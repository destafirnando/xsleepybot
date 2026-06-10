// Maze Runner v8 - "PUSH FAR" strategy.
//
// LESSON LEARNED from production R1 log (14:00):
// - Bot v6 stop di dist 1-5 dengan HP masih banyak (47!)
// - Trigger: high-cost detection (2 tile cost > 13 berturut)
// - Tapi tile cost 13+ itu NORMAL (30% tile distribution)
// - Bot terlalu paranoid -> stop dini -> stuck di ring crowded center
//
// Agent yang menang (Hoz: dist 13+, score 169) PUSH SAMPAI EDGE.
// Mereka TIDAK stop di high-cost - mereka terus push.
//
// Ratusan agent kompetitor cluster di dist 1-5 (sama strategy bot v6).
// Tile collapse 100% di area itu. Score = 0.
//
// FIX v8 - "PUSH FAR ESCAPE":
//
// 1. HPFloor 30 (was 40-75) - lebih agresif push
// 2. Death-zone hanya MAX_TILE+1=51 (was +5) - hampir no safety margin
// 3. HAPUS high-cost-zone stop (was 2 cost > 13 = stop)
//    Tile mahal 11-30 NORMAL, bukan terror.
//    Hanya stop kalau cost >= 35 (real terror tile)
// 4. HAPUS DODGE PHASE - dodge cuma geser ke tile crowded sebelah
//    Solution: push lebih jauh ke ring yang lebih sepi
// 5. Chain 2-3 step kalau HP > 50 (push faster)
//
// PHILOSOPHY: di tournament 400 agent, RING DEKAT CENTER = OVERCROWDED.
// RING JAUH (dist 11+) = lebih sedikit agent yang berhasil sampai = lebih aman.

import { log } from '../logger.js';
import { api } from '../api.js';

// ====================================================================
const MAX_TILE = 50;
const TERROR_THRESHOLD = 35; // hanya stop kalau ketemu terror tile (top 10% values)

const CONFIG = {
  // 'survive' = push aggressive untuk LEWAT median 95
  survive: {
    targetDist: 12,
    hpFloor: 30,
    pushExtension: 2,
    label: 'SURVIVE',
  },
  // 'push' = top 30%
  push: {
    targetDist: 14,
    hpFloor: 25,
    pushExtension: 1,
    label: 'PUSH',
  },
  // 'aggressive' = top 10%
  aggressive: {
    targetDist: 16,
    hpFloor: 20,
    pushExtension: 0,
    label: 'AGGRESSIVE',
  },
  // backward compat aliases
  defensive: {
    targetDist: 12,
    hpFloor: 30,
    pushExtension: 2,
    label: 'SURVIVE',
  },
  safe: {
    targetDist: 13,
    hpFloor: 28,
    pushExtension: 1,
    label: 'SAFE',
  },
};

const OPP = { W: 'S', S: 'W', A: 'D', D: 'A' };

const CORNERS = {
  N:  { dirs: ['W', 'W'] },
  NE: { dirs: ['W', 'D'] },
  E:  { dirs: ['D', 'D'] },
  SE: { dirs: ['S', 'D'] },
  S:  { dirs: ['S', 'S'] },
  SW: { dirs: ['S', 'A'] },
  W:  { dirs: ['A', 'A'] },
  NW: { dirs: ['W', 'A'] },
};
const CORNER_KEYS = Object.keys(CORNERS);

function getAgentSlot() {
  const cwd = process.cwd();
  const m = cwd.match(/agents[\/\\](\d+)$/);
  if (m) return parseInt(m[1], 10);
  const key = process.env.AGENTHANSA_API_KEY || 'fallback';
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function pickCorner() {
  const slot = getAgentSlot();
  return CORNER_KEYS[slot % CORNER_KEYS.length];
}

// Neighborhood STRICT
function neighStatus(nb, dir) {
  if (!nb) return 'unknown';
  if (Array.isArray(nb)) {
    const idx = ['W', 'A', 'S', 'D'].indexOf(dir);
    if (idx < 0 || idx >= nb.length) return 'unknown';
    const v = nb[idx];
    if (v === 'open' || v === 'floor' || v === true) return 'open';
    if (v === 'wall' || v === 'oob' || v === false) return 'wall';
    if (v && typeof v === 'object') {
      const t = v.type || v.kind;
      if (t === 'open' || t === 'floor') return 'open';
      if (t === 'wall' || t === 'oob') return 'wall';
    }
    return 'unknown';
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
      if (v === 'open' || v === 'floor' || v === true) return 'open';
      if (v === 'wall' || v === 'oob' || v === false) return 'wall';
      if (v && typeof v === 'object') {
        const t = v.type || v.kind;
        if (t === 'open' || t === 'floor') return 'open';
        if (t === 'wall' || t === 'oob') return 'wall';
      }
    }
  }
  return 'unknown';
}

function isOpen(nb, dir) {
  return neighStatus(nb, dir) === 'open';
}

function isNotWall(nb, dir) {
  return neighStatus(nb, dir) !== 'wall';
}

// Pilih next step - prefer corner direction, hindari wall
function nextStep(nb, pattern, lastDir) {
  const primary = pattern[0];
  const alt = pattern[1];

  // Strict: confirmed open
  for (const d of [primary, alt]) {
    if (isOpen(nb, d)) return { dir: d, confidence: 'high' };
  }

  // Perpendicular still strict open
  const perp = primary === 'W' || primary === 'S' ? ['A', 'D'] : ['W', 'S'];
  for (const d of perp) {
    if (d === OPP[lastDir]) continue;
    if (isOpen(nb, d)) return { dir: d, confidence: 'medium' };
  }

  // Lenient: accept unknown
  for (const d of [primary, alt, ...perp]) {
    if (d === OPP[lastDir]) continue;
    if (isNotWall(nb, d)) return { dir: d, confidence: 'low' };
  }

  // Last resort
  for (const d of ['W', 'A', 'S', 'D']) {
    if (isNotWall(nb, d)) return { dir: d, confidence: 'desperate' };
  }
  return { dir: primary, confidence: 'fallback' };
}

function distFromCenter(x, y) {
  return Math.abs(x - 10) + Math.abs(y - 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================================================================
export async function play({ tournamentId, roundNum, roundEndsAt }) {
  const mode = (process.env.MAZE_MODE || 'survive').toLowerCase();
  const cfg = CONFIG[mode] || CONFIG.survive;
  let effectiveTarget = cfg.targetDist;
  let extended = false;

  const slot = getAgentSlot();
  const corner = pickCorner();
  const pattern = CORNERS[corner].dirs;

  log.game(
    `[maze] R${roundNum}: ${cfg.label} v8 | slot=${slot} corner=${corner} ` +
      `pattern=${pattern.join('')} target=${effectiveTarget} floor=${cfg.hpFloor}`,
  );

  let pairing;
  try {
    pairing = await api.arena.pairing(tournamentId, roundNum);
  } catch (e) {
    log.err(`[maze] pairing fail: ${e.message}`);
    return;
  }

  if (pairing?.my_pairing?.is_bye || pairing?.is_bye) {
    log.game(`[maze] R${roundNum}: BYE`);
    return;
  }
  if (pairing?.eliminated || pairing?.my_pairing?.eliminated) {
    log.warn(`[maze] R${roundNum}: ELIMINATED, skip`);
    return;
  }

  const ms = pairing?.maze_state || pairing?.my_pairing?.maze_state || {};
  let pos = Array.isArray(ms.position) ? [...ms.position] : [10, 10];
  let hp = Number(ms.health ?? ms.hp ?? 100);
  let neighborhood = ms.neighborhood || null;
  let lastDir = null;
  let isDead = false;
  let stepCount = 0;
  let terrorHit = 0; // counter terror tile (>= 35 HP cost)

  const endTime = roundEndsAt
    ? new Date(roundEndsAt).getTime()
    : Date.now() + 9.5 * 60 * 1000;

  // Reserve 30s buffer (TIDAK ada phase 2 dodge - lebih banyak waktu push)
  const phase1Deadline = endTime - 30_000;

  // ==== PHASE 1: PUSH FAR ====
  while (!isDead && Date.now() < phase1Deadline) {
    const dist = distFromCenter(pos[0], pos[1]);

    // Stop conditions - LEBIH MINIMAL
    if (hp <= cfg.hpFloor) {
      log.game(`[maze] HP=${hp.toFixed(1)} <= floor ${cfg.hpFloor}, STOP at dist=${dist}`);
      break;
    }
    // Death-zone: 1 spike tile bisa langsung mati
    if (hp <= MAX_TILE + 1) {
      log.warn(`[maze] death-zone HP=${hp.toFixed(1)}, STOP at dist=${dist}`);
      break;
    }
    // Stop kalau kena 2 terror tile berturut (cost >= 35)
    if (terrorHit >= 2) {
      log.warn(`[maze] 2 TERROR tiles hit, STOP at dist=${dist} hp=${hp.toFixed(1)}`);
      break;
    }

    // Target reached?
    if (dist >= effectiveTarget) {
      // Adaptive extend
      if (!extended && cfg.pushExtension > 0 && hp >= cfg.hpFloor + 20) {
        effectiveTarget += cfg.pushExtension;
        extended = true;
        log.game(`[maze] hit target, HP=${hp.toFixed(1)} ample, extend to ${effectiveTarget}`);
      } else {
        log.game(`[maze] dist=${dist} >= target ${effectiveTarget}, STOP`);
        break;
      }
    }

    // Chain length: AGRESIF push kalau HP banyak
    let chainLen;
    if (hp >= cfg.hpFloor + 50) chainLen = 3;
    else if (hp >= cfg.hpFloor + 25) chainLen = 2;
    else chainLen = 1;

    const { dir, confidence } = nextStep(neighborhood, pattern, lastDir);

    if (confidence === 'desperate' || confidence === 'fallback') {
      log.warn(`[maze] no safe direction (${confidence}), STOP at dist=${dist}`);
      break;
    }

    const chain = [dir];
    if (chainLen >= 2 && confidence === 'high') {
      const altDir = pattern[1];
      if (isNotWall(neighborhood, altDir)) {
        chain.push(altDir);
        if (chainLen >= 3) {
          // 3rd step blind, but we're optimistic - HP buffer cukup
          chain.push(pattern[0]);
        }
      }
    }

    let res;
    const hpBefore = hp;
    try {
      res = await api.arena.submitMaze(tournamentId, roundNum, chain.join(''));
    } catch (e) {
      if (e.status === 403 || /eliminated/i.test(e.message)) {
        log.warn(`[maze] eliminated (403), stop`);
        break;
      }
      if (e.status === 429) {
        const wait = e.data?.cooldown_remaining_seconds
          ? e.data.cooldown_remaining_seconds * 1000 : 1100;
        await sleep(wait + 50);
        continue;
      }
      log.err(`[maze] move error: ${e.message}`);
      break;
    }

    pos = res.final_position || pos;
    hp = Number(res.health_left ?? hp);
    isDead = res.is_dead === true;

    let bumped = false;
    if (Array.isArray(res.moves)) {
      for (const m of res.moves) {
        if (m.result === 'wall_bump') bumped = true;
        if (m.neighborhood) neighborhood = m.neighborhood;
      }
    }

    const cost = hpBefore - hp;
    stepCount++;

    // Track terror tile (cost >= 35 = top 10% mahal)
    if (cost >= TERROR_THRESHOLD) terrorHit++;
    else terrorHit = 0; // reset counter kalau cheap tile

    log.game(
      `[maze] STEP${stepCount} ${chain.join('')} pos=(${pos.join(',')}) hp=${hp.toFixed(1)} ` +
        `dist=${distFromCenter(pos[0], pos[1])} cost=${cost.toFixed(1)}` +
        (bumped ? ' [WALL_BUMP!]' : '') + ` conf=${confidence}` +
        (cost >= TERROR_THRESHOLD ? ' [TERROR!]' : ''),
    );

    if (isDead) {
      log.err(`[maze] DIED at step ${stepCount}, score=0`);
      return;
    }

    if (bumped) {
      // Wall bump = waste 20 HP. Stop chain length next iteration.
      log.warn(`[maze] WALL_BUMP - reduce chain next step`);
    }

    lastDir = chain[chain.length - 1];

    if (res.cooldown_until) {
      const wait = new Date(res.cooldown_until).getTime() - Date.now();
      if (wait > 0) await sleep(wait + 50);
    } else {
      await sleep(1100);
    }
  }

  const finalDist = distFromCenter(pos[0], pos[1]);
  const expectedScore = finalDist * 10;
  log.ok(
    `[maze] R${roundNum} END: pos=(${pos.join(',')}) dist=${finalDist} hp=${hp.toFixed(1)} steps=${stepCount} ` +
      `expected_score=${expectedScore}+ (+1..50 tile)`,
  );

  // ==== NO PHASE 2 - kalau dist 12+, ring edge biasanya sepi ====
  // Phase 2 dodge cuma BUANG HP. Lebih baik stay where we are.
}
