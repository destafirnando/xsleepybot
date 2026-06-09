// Maze Runner strategy v2 - "Survive & Score 100+".
//
// Aturan:
//   - Grid 21x21, start (10,10). Score = manhattan_distance * 10 + final_tile_value.
//   - HP=100 per round. Step damage = tile value (median 5, max 50).
//   - Wall bump = 20 HP, no movement. Mati (HP<=0) = score 0.
//   - Tile collapse: 25%(2 agt)/50%(3)/75%(4)/100%(5+) → score 0 untuk semua agent di tile itu.
//
// TUJUAN BARU:
//   1. Score >= 100 (artinya dist >= 10).
//   2. JANGAN MATI per round - kumulatif score lebih penting daripada push max distance.
//   3. Anti collapse - tiap agent (10 agent) spread ke corner berbeda by hash(api_key).
//
// Dua mode (env MAZE_MODE):
//   - safe (default): targetDist=10, hpFloor=50. Score 100+, survival ~95%.
//   - push: targetDist=14, hpFloor=35. Score 140+, survival ~70%.
//
// Adaptive push: kalau target dicapai dengan HP berlimpah, lanjut push 2-4 langkah lagi.
//
// Per-agent corner: hash(API_KEY) -> NW/NE/SW/SE. Pattern langkah zigzag 2 direksi.

import { log } from '../logger.js';
import { api } from '../api.js';

// ====================================================================
// Konstanta & konfigurasi
// ====================================================================
const MAX_TILE = 50; // damage paling buruk yang bisa kena dalam 1 step
const SCAN_COST = 5;
const WALL_BUMP_COST = 20;

const CONFIG = {
  safe: {
    targetDist: 10, // score 100+ guaranteed
    hpFloor: 50, // stop push kalau HP <= ini
    pushExtension: 2, // adaptive: extend target +2 kalau HP buffer cukup
    bufferForExtend: 30, // butuh HP >= floor + 30 untuk extend
    label: 'SAFE',
  },
  push: {
    targetDist: 14, // score 140+
    hpFloor: 35,
    pushExtension: 4,
    bufferForExtend: 25,
    label: 'PUSH',
  },
};

const OPP = { W: 'S', S: 'W', A: 'D', D: 'A' };

// ====================================================================
// Per-agent corner direction (deterministic by API key hash)
// 10 agent kamu akan tersebar ke 4 corner (kemungkinan) - reduce collision.
// ====================================================================
function pickCorner() {
  const key = process.env.AGENTHANSA_API_KEY || 'fallback';
  let h = 0;
  for (const c of key.slice(-12)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ['NW', 'NE', 'SW', 'SE'][Math.abs(h) % 4];
}

function stepPattern(corner) {
  // Zigzag 2 direksi yang sama-sama menjauhi center.
  switch (corner) {
    case 'NW': return ['W', 'A']; // north + west
    case 'NE': return ['W', 'D']; // north + east
    case 'SW': return ['S', 'A'];
    case 'SE': return ['S', 'D'];
    default: return ['W', 'D'];
  }
}

// ====================================================================
// Neighborhood adapter (defensive - format API bisa beda alias)
// Returns: true (open), false (wall/oob), null (unknown)
// ====================================================================
function neighOpen(nb, dir) {
  if (!nb) return null;

  // Handle array form: [W, A, S, D] common order
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
// Pilih next direction berdasarkan pattern + neighborhood
// ====================================================================
function nextStep(nb, pattern, stepIdx, lastDir) {
  const primary = pattern[stepIdx % 2];
  const alt = pattern[(stepIdx + 1) % 2];

  // Try corner directions first
  if (neighOpen(nb, primary) !== false) return primary;
  if (neighOpen(nb, alt) !== false) return alt;

  // Both corner-dirs blocked - try perpendicular (any non-OPP, non-corner)
  for (const d of ['W', 'A', 'S', 'D']) {
    if (d === primary || d === alt) continue;
    if (d === OPP[lastDir]) continue; // hindari bolak-balik
    if (neighOpen(nb, d) !== false) return d;
  }

  // Truly stuck - try OPP[lastDir] (retreat)
  for (const d of ['W', 'A', 'S', 'D']) {
    if (neighOpen(nb, d) !== false) return d;
  }

  // Give up, will likely bump
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
  const corner = pickCorner();
  const pattern = stepPattern(corner);

  log.game(
    `[maze] R${roundNum}: ${cfg.label} mode | corner=${corner} pattern=${pattern.join('')} ` +
      `target=${cfg.targetDist} hpFloor=${cfg.hpFloor}`,
  );

  // Initial state from pairing
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

  const endTime = roundEndsAt
    ? new Date(roundEndsAt).getTime()
    : Date.now() + 9.5 * 60 * 1000;

  // ==== PHASE 1: PUSH ====
  while (!isDead && Date.now() < endTime - 45_000) {
    const dist = distFromCenter(pos[0], pos[1]);

    // Stop conditions
    if (hp <= cfg.hpFloor) {
      log.game(`[maze] HP=${hp.toFixed(1)} <= floor ${cfg.hpFloor}, stop push at dist=${dist}`);
      break;
    }
    if (hp <= MAX_TILE + 1) {
      // Death-zone: 1 spike tile bisa langsung mati
      log.warn(
        `[maze] HP=${hp.toFixed(1)} dalam death-zone (≤${MAX_TILE + 1}), stop push at dist=${dist}`,
      );
      break;
    }

    if (dist >= effectiveTarget) {
      // Adaptive: extend target sekali kalau HP buffer cukup
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

    // Adaptive chain length berdasarkan HP buffer
    let chainLen;
    if (hp >= cfg.hpFloor + 40) chainLen = 3;
    else if (hp >= cfg.hpFloor + 20) chainLen = 2;
    else chainLen = 1;

    // Build chain - hanya step pertama yang validated lewat neighborhood
    const chain = [];
    for (let i = 0; i < chainLen; i++) {
      let dir;
      if (i === 0) {
        dir = nextStep(neighborhood, pattern, stepIdx, lastDir);
      } else {
        // Subsequent steps: alternate pattern (blind)
        dir = pattern[(stepIdx + 1) % 2];
      }
      chain.push(dir);
      lastDir = dir;
      stepIdx++;
    }

    // Submit move
    let res;
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

    // Apply response
    pos = res.final_position || pos;
    hp = Number(res.health_left ?? hp);
    isDead = res.is_dead === true;

    // Track bumps + neighborhood
    if (Array.isArray(res.moves)) {
      for (const m of res.moves) {
        if (m.result === 'wall_bump') bumps++;
        if (m.neighborhood) neighborhood = m.neighborhood;
      }
    }

    log.game(
      `[maze] chain=${chain.join('')} pos=(${pos.join(',')}) hp=${hp.toFixed(1)} dist=${distFromCenter(pos[0], pos[1])}${bumps ? ` bumps=${bumps}` : ''}`,
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

  // ==== PHASE 2: ANTI-COLLAPSE DODGE ====
  // Kalau dist < target tapi gak mati, masih bisa score. Cek crowd.
  if (
    !isDead &&
    hp > SCAN_COST + WALL_BUMP_COST &&
    Date.now() < endTime - 10_000
  ) {
    try {
      // Tunggu ada cooldown server (rate limit 1s antar request)
      await sleep(1100);

      const check = await api.arena.mazeCheck(tournamentId, roundNum);
      const occupants = Number(check.tile_occupants ?? 1);
      hp = Number(check.health_left ?? hp - SCAN_COST);
      isDead = check.is_dead === true;

      log.game(
        `[maze] scan: occupants=${occupants} hp=${hp.toFixed(1)}`,
      );

      if (isDead) {
        log.err(`[maze] DIED on scan (HP terlalu rendah)`);
        return;
      }

      // Decide: dodge?
      // - 1 agent (just me): no dodge needed
      // - 2+ agents: dodge if HP cukup
      const collapseRisk = Math.min(1, (occupants - 1) * 0.25);
      const expectedScoreNoDodge = (1 - collapseRisk) * (finalDist * 10 + 8);
      // average tile value mid range
      const expectedScoreDodge = finalDist * 10 + 5; // dodge boleh +/-1 dist

      if (occupants >= 2 && hp > 25) {
        if (check.cooldown_until) {
          const wait = new Date(check.cooldown_until).getTime() - Date.now();
          if (wait > 0) await sleep(wait + 50);
        } else {
          await sleep(1100);
        }

        // Pilih dodge step - prefer extend ke corner direction (lebih aman / sama dist)
        let dodge = nextStep(neighborhood, pattern, stepIdx, lastDir);

        log.game(
          `[maze] DODGE ${dodge} (occupants=${occupants}, collapseRisk=${(collapseRisk * 100).toFixed(0)}%)`,
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
          const newDist = distFromCenter(pos[0], pos[1]);
          log.game(
            `[maze] post-dodge pos=(${pos.join(',')}) hp=${hp.toFixed(1)} dist=${newDist}`,
          );
        } catch (e) {
          log.warn(`[maze] dodge submit failed: ${e.message}`);
        }
      } else if (occupants >= 2) {
        log.warn(
          `[maze] occupants=${occupants} but HP=${hp.toFixed(1)} too low for dodge - accept ${(collapseRisk * 100).toFixed(0)}% risk`,
        );
      }
    } catch (e) {
      log.warn(`[maze] scan error: ${e.message}`);
    }
  } else if (!isDead) {
    log.game(`[maze] HP=${hp.toFixed(1)} terlalu rendah untuk scan/dodge - hold position`);
  }

  // ==== FINAL ====
  const final = distFromCenter(pos[0], pos[1]);
  const expectedScore = final * 10;
  log.ok(
    `[maze] R${roundNum} done: pos=(${pos.join(',')}) dist=${final} hp=${hp.toFixed(1)} ` +
      `expected_score=${expectedScore}+ (+1..50 tile)`,
  );
}
