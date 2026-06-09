// Maze Runner strategy v3 - "Spread & Survive".
//
// KENAPA REWRITE:
//   v2 punya bug: 10 agent collapse ke 3-4 corner sama -> tile collision
//   100% risk -> score 0 untuk banyak agent. Plus HP boros (final 18-21).
//
// FIX v3:
//   1. PER-AGENT UNIQUE SLOT: pakai folder name (agents/01..10) bukan hash
//      key, sehingga 10 agent dapat 8 corner direction berbeda + offset.
//   2. 8 ARAH (bukan 4): N, NE, E, SE, S, SW, W, NW.
//   3. SMART STOP: monitor avg HP cost per step, stop kalau >8 (banyak terror).
//   4. SMART DODGE: kalau dodge gagal hindari crowd (occupants masih >=2),
//      coba dodge lagi ke arah berbeda - bukan diam menerima collapse.
//   5. EARLY HP FLOOR: floor naik dari 50 -> 60 untuk safe mode (lebih aman).

import { log } from '../logger.js';
import { api } from '../api.js';
import { state } from '../state.js';
import path from 'node:path';
import fs from 'node:fs';

// ====================================================================
// Konstanta
// ====================================================================
const MAX_TILE = 50;
const SCAN_COST = 5;
const WALL_BUMP_COST = 20;
const HIGH_AVG_COST_THRESHOLD = 9; // average HP cost > ini = banyak terror tile

const CONFIG = {
  safe: {
    targetDist: 10,
    hpFloor: 60, // raised from 50 -> safer
    pushExtension: 2,
    bufferForExtend: 25,
    label: 'SAFE',
  },
  push: {
    targetDist: 14,
    hpFloor: 40, // raised from 35
    pushExtension: 4,
    bufferForExtend: 25,
    label: 'PUSH',
  },
};

const OPP = { W: 'S', S: 'W', A: 'D', D: 'A' };

// 8 corner pattern - tiap punya 2 step direction yang menjauhi center
// + tie-breaker offset (urutan langkah pertama) untuk lebih banyak variasi
const CORNERS = {
  N:  { dirs: ['W', 'W'], primary: 'W' },        // pure north
  NE: { dirs: ['W', 'D'], primary: 'W' },        // north-east
  E:  { dirs: ['D', 'D'], primary: 'D' },        // pure east
  SE: { dirs: ['S', 'D'], primary: 'S' },        // south-east
  S:  { dirs: ['S', 'S'], primary: 'S' },        // pure south
  SW: { dirs: ['S', 'A'], primary: 'S' },        // south-west
  W:  { dirs: ['A', 'A'], primary: 'A' },        // pure west
  NW: { dirs: ['W', 'A'], primary: 'W' },        // north-west
};
const CORNER_KEYS = Object.keys(CORNERS); // [N, NE, E, SE, S, SW, W, NW]

// ====================================================================
// Per-agent slot - cara baru: detect dari cwd path (agents/NN)
// ====================================================================
function getAgentSlot() {
  // Coba: cwd ends with /NN (agent number) -> pakai itu
  const cwd = process.cwd();
  const match = cwd.match(/agents[\/\\](\d+)$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  // Fallback: hash AGENTHANSA_API_KEY
  const key = process.env.AGENTHANSA_API_KEY || 'fallback';
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function pickCorner() {
  const slot = getAgentSlot();
  const cornerIdx = slot % CORNER_KEYS.length;
  return CORNER_KEYS[cornerIdx];
}

function stepPattern(corner) {
  return CORNERS[corner]?.dirs || ['W', 'D'];
}

// ====================================================================
// Neighborhood adapter
// ====================================================================
function neighOpen(nb, dir) {
  if (!nb) return null;

  if (Array.isArray(nb)) {
    const idx = ['W', 'A', 'S', 'D'].indexOf(dir);
    if (idx >= 0 && idx < nb.length) {
      const v = nb[idx];
      if (v === 'open' || v === 'floor' || v === true) return true;
      if (v === 'wall' || v === 'oob' || v === false) return false;
      if (v && typeof v === 'object') {
        const t = v.type || v.kind;
        return t === 'open' || t === 'floor' ? true : false;
      }
    }
    return null;
  }

  const aliases = {
    W: ['W', 'up', 'north', 'n', 'top'],
    S: ['S', 'down', 'south', 's', 'bottom'],
    A: ['A', 'left', 'west', 'w', 'l'],
    D: ['D', 'right', 'east', 'e', 'r'],
  };

  for (const k of aliases[dir]) {
    if (k in nb) {
      const v = nb[k];
      if (v === 'open' || v === 'floor' || v === true) return true;
      if (v === 'wall' || v === 'oob' || v === false) return false;
      if (v && typeof v === 'object') {
        const t = v.type || v.kind;
        if (t === 'open' || t === 'floor') return true;
        if (t === 'wall' || t === 'oob') return false;
      }
    }
  }
  return null;
}

// ====================================================================
// Pilih next direction
// ====================================================================
function nextStep(nb, pattern, stepIdx, lastDir, blockedDirs = new Set()) {
  const primary = pattern[stepIdx % pattern.length];
  const alt = pattern[(stepIdx + 1) % pattern.length];

  // Try corner directions
  if (!blockedDirs.has(primary) && neighOpen(nb, primary) !== false) return primary;
  if (alt !== primary && !blockedDirs.has(alt) && neighOpen(nb, alt) !== false) return alt;

  // Fallback: any non-OPP, non-blocked
  for (const d of ['W', 'A', 'S', 'D']) {
    if (d === primary || d === alt) continue;
    if (blockedDirs.has(d)) continue;
    if (d === OPP[lastDir]) continue;
    if (neighOpen(nb, d) !== false) return d;
  }

  // Last resort
  for (const d of ['W', 'A', 'S', 'D']) {
    if (blockedDirs.has(d)) continue;
    if (neighOpen(nb, d) !== false) return d;
  }
  return primary;
}

// ====================================================================
// DODGE - pilih arah yang BERBEDA dari cluster yang collapse
// strategi: kalau pattern utama crowded (ada banyak agent ke sini),
// dodge ke arah perpendicular yang masih jaga distance.
// ====================================================================
function dodgeStep(nb, pattern, lastDir, attemptN = 0) {
  // Dodge sequence per attempt:
  // attempt 0: alt direction dari pattern (perpendicular ke primary)
  // attempt 1: primary direction (lanjut menjauh)
  // attempt 2: opposite dari primary (back tracking)
  // attempt 3: any open direction
  const primary = pattern[0];
  const alt = pattern[1];

  let candidates;
  switch (attemptN) {
    case 0: candidates = [alt, primary]; break;
    case 1: candidates = [primary, alt]; break;
    case 2: {
      // perpendicular to corner (rotate 90°)
      const perp = primary === 'W' || primary === 'S' ? ['D', 'A'] : ['W', 'S'];
      candidates = perp;
      break;
    }
    default:
      candidates = ['W', 'A', 'S', 'D'];
  }

  for (const d of candidates) {
    if (d === OPP[lastDir]) continue;
    if (neighOpen(nb, d) !== false) return d;
  }
  // ignore OPP rule kalau truly stuck
  for (const d of candidates) {
    if (neighOpen(nb, d) !== false) return d;
  }
  return primary;
}

function distFromCenter(x, y) {
  return Math.abs(x - 10) + Math.abs(y - 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================================================================
// Main play function
// ====================================================================
export async function play({ tournamentId, roundNum, roundEndsAt }) {
  const mode = (process.env.MAZE_MODE || 'safe').toLowerCase();
  const cfg = CONFIG[mode] || CONFIG.safe;
  const slot = getAgentSlot();
  const corner = pickCorner();
  const pattern = stepPattern(corner);

  log.game(
    `[maze] R${roundNum}: ${cfg.label} mode | slot=${slot} corner=${corner} ` +
      `pattern=${pattern.join('')} target=${cfg.targetDist} hpFloor=${cfg.hpFloor}`,
  );

  let pairing;
  try {
    pairing = await api.arena.pairing(tournamentId, roundNum);
  } catch (e) {
    log.err(`[maze] pairing fetch failed: ${e.message}`);
    return;
  }

  if (pairing?.my_pairing?.is_bye || pairing?.is_bye) {
    log.game(`[maze] R${roundNum}: BYE - skip`);
    return;
  }

  const ms = pairing?.maze_state || pairing?.my_pairing?.maze_state || {};
  let pos = Array.isArray(ms.position) ? [...ms.position] : [10, 10];
  let hp = Number(ms.health ?? ms.hp ?? 100);
  let neighborhood = ms.neighborhood || null;
  let stepIdx = 0;
  let lastDir = null;
  let isDead = false;
  let effectiveTarget = cfg.targetDist;
  let extended = false;
  let bumps = 0;

  // Track HP cost average untuk smart stop
  const hpHistory = [hp];
  const stepsHistory = []; // {dir, hpBefore, hpAfter, cost}

  const endTime = roundEndsAt
    ? new Date(roundEndsAt).getTime()
    : Date.now() + 9.5 * 60 * 1000;

  // ==== PHASE 1: PUSH ====
  while (!isDead && Date.now() < endTime - 60_000) {
    const dist = distFromCenter(pos[0], pos[1]);

    // Stop conditions
    if (hp <= cfg.hpFloor) {
      log.game(`[maze] HP=${hp.toFixed(1)} <= floor ${cfg.hpFloor}, stop push at dist=${dist}`);
      break;
    }

    // Death-zone: 1 spike tile bisa langsung mati
    if (hp <= MAX_TILE + 1) {
      log.warn(
        `[maze] HP=${hp.toFixed(1)} dalam death-zone (≤${MAX_TILE + 1}), stop push at dist=${dist}`,
      );
      break;
    }

    // Smart stop: kalau average HP cost terlalu tinggi (banyak terror tile)
    if (stepsHistory.length >= 3) {
      const recent = stepsHistory.slice(-3);
      const avgCost = recent.reduce((a, b) => a + b.cost, 0) / recent.length;
      if (avgCost > HIGH_AVG_COST_THRESHOLD && hp < cfg.hpFloor + 25) {
        log.warn(
          `[maze] avg cost recent ${avgCost.toFixed(1)} HP/step terlalu boros, stop early at dist=${dist}`,
        );
        break;
      }
    }

    if (dist >= effectiveTarget) {
      // Adaptive extend
      if (
        !extended &&
        hp >= cfg.hpFloor + cfg.bufferForExtend &&
        cfg.pushExtension > 0
      ) {
        effectiveTarget += cfg.pushExtension;
        extended = true;
        log.game(
          `[maze] HP=${hp.toFixed(1)} ample, extend target -> dist=${effectiveTarget}`,
        );
      } else {
        log.game(`[maze] dist=${dist} >= target ${effectiveTarget}, stop push`);
        break;
      }
    }

    // Adaptive chain length - lebih konservatif dari v2
    let chainLen;
    if (hp >= cfg.hpFloor + 35) chainLen = 3;
    else if (hp >= cfg.hpFloor + 15) chainLen = 2;
    else chainLen = 1; // HP tipis: 1 step doang biar bisa monitor

    // Build chain
    const chain = [];
    for (let i = 0; i < chainLen; i++) {
      const dir = i === 0
        ? nextStep(neighborhood, pattern, stepIdx, lastDir)
        : pattern[(stepIdx + 1) % pattern.length];
      chain.push(dir);
      lastDir = dir;
      stepIdx++;
    }

    // Submit move
    let res;
    const hpBefore = hp;
    try {
      res = await api.arena.submitMaze(tournamentId, roundNum, chain.join(''));
    } catch (e) {
      if (e.status === 429) {
        const wait = e.data?.cooldown_remaining_seconds
          ? e.data.cooldown_remaining_seconds * 1000
          : 1100;
        await sleep(wait + 50);
        continue;
      }
      log.err(`[maze] move error: ${e.message}`);
      break;
    }

    pos = res.final_position || pos;
    hp = Number(res.health_left ?? hp);
    isDead = res.is_dead === true;

    if (Array.isArray(res.moves)) {
      for (const m of res.moves) {
        if (m.result === 'wall_bump') bumps++;
        if (m.neighborhood) neighborhood = m.neighborhood;
      }
    }

    const cost = hpBefore - hp;
    stepsHistory.push({ dirs: chain.join(''), hpBefore, hpAfter: hp, cost });

    log.game(
      `[maze] chain=${chain.join('')} pos=(${pos.join(',')}) hp=${hp.toFixed(1)} ` +
        `dist=${distFromCenter(pos[0], pos[1])} cost=${cost.toFixed(1)}${bumps ? ` bumps=${bumps}` : ''}`,
    );

    if (isDead) {
      log.err(`[maze] DIED in push phase, score=0`);
      return;
    }

    // Honor cooldown
    if (res.cooldown_until) {
      const wait = new Date(res.cooldown_until).getTime() - Date.now();
      if (wait > 0) await sleep(wait + 50);
    } else {
      await sleep(1100);
    }
  }

  const finalDist = distFromCenter(pos[0], pos[1]);
  log.game(
    `[maze] push phase done: pos=(${pos.join(',')}) hp=${hp.toFixed(1)} dist=${finalDist}`,
  );

  // ==== PHASE 2: SMART ANTI-COLLAPSE ====
  // Ulangi scan + dodge sampai 3x kalau masih crowded
  let dodgeAttempt = 0;
  const MAX_DODGE = 3;

  while (
    !isDead &&
    hp > SCAN_COST + 10 &&
    Date.now() < endTime - 8_000 &&
    dodgeAttempt < MAX_DODGE
  ) {
    try {
      await sleep(1100);

      const check = await api.arena.mazeCheck(tournamentId, roundNum);
      const occupants = Number(check.tile_occupants ?? 1);
      hp = Number(check.health_left ?? hp - SCAN_COST);
      isDead = check.is_dead === true;

      log.game(
        `[maze] scan#${dodgeAttempt + 1}: occupants=${occupants} hp=${hp.toFixed(1)}`,
      );

      if (isDead) {
        log.err(`[maze] DIED on scan`);
        return;
      }

      if (occupants <= 1) {
        log.game(`[maze] tile clear, no dodge needed`);
        break;
      }

      const collapseRisk = Math.min(1, (occupants - 1) * 0.25);

      // HP tidak cukup untuk dodge?
      if (hp < 25) {
        log.warn(
          `[maze] HP=${hp.toFixed(1)} too low for dodge, accept ${(collapseRisk * 100).toFixed(0)}% collapse risk`,
        );
        break;
      }

      // Dodge!
      if (check.cooldown_until) {
        const wait = new Date(check.cooldown_until).getTime() - Date.now();
        if (wait > 0) await sleep(wait + 50);
      } else {
        await sleep(1100);
      }

      const dodge = dodgeStep(neighborhood, pattern, lastDir, dodgeAttempt);

      log.game(
        `[maze] DODGE#${dodgeAttempt + 1} dir=${dodge} (occupants=${occupants}, risk=${(collapseRisk * 100).toFixed(0)}%)`,
      );

      try {
        const dRes = await api.arena.submitMaze(tournamentId, roundNum, dodge);
        pos = dRes.final_position || pos;
        hp = Number(dRes.health_left ?? hp);
        isDead = dRes.is_dead === true;
        if (Array.isArray(dRes.moves)) {
          for (const m of dRes.moves) {
            if (m.neighborhood) neighborhood = m.neighborhood;
          }
        }
        if (isDead) {
          log.err(`[maze] DIED on dodge`);
          return;
        }
        lastDir = dodge;
      } catch (e) {
        log.warn(`[maze] dodge submit failed: ${e.message}`);
        break;
      }

      dodgeAttempt++;
    } catch (e) {
      log.warn(`[maze] scan/dodge error: ${e.message}`);
      break;
    }
  }

  if (dodgeAttempt > 0 && !isDead) {
    log.game(
      `[maze] anti-collapse done: ${dodgeAttempt} dodge attempt(s), final pos=(${pos.join(',')})`,
    );
  } else if (!isDead && hp <= SCAN_COST + 10) {
    log.game(`[maze] HP=${hp.toFixed(1)} terlalu rendah, hold position`);
  }

  // ==== FINAL ====
  const final = distFromCenter(pos[0], pos[1]);
  const expectedScore = final * 10;
  log.ok(
    `[maze] R${roundNum} done: pos=(${pos.join(',')}) dist=${final} hp=${hp.toFixed(1)} ` +
      `expected_score=${expectedScore}+ (+1..50 tile)`,
  );
}
