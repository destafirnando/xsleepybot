// Maze Runner v6 - "Push to Survive" strategy.
//
// LESSONS LEARNED dari tournament data analysis (TID 615f7d13):
// - Top 23 survivors R1: score 95-169
// - Median R1 cutoff: ~95 score (dist 9 + tile 5)
// - Top 8 score 127+: dist 12-14
// - Bot defensive (target 7, score 70) = DI BAWAH median = eliminated R1
//
// FIX v6 - prioritas SURVIVAL via DIST yang cukup:
// - Target dist 11 (score 110+) untuk LEWAT median R1
// - Mode push: target 13 untuk top 30%
// - Mode aggressive: target 15 untuk top 10%
//
// PRINSIP YANG TETAP DARI v5:
// 1. Strict wall avoidance (no bump)
// 2. High-cost zone detection (stop di 2 cost > 12 berturut)
// 3. NO random exit (buang HP)
// 4. Phase 2 dodge max 2 step

import { log } from '../logger.js';
import { api } from '../api.js';

// ====================================================================
const MAX_TILE = 50;
const SCAN_COST = 5;

// MODE configuration - TARGET DIST DINAIKAN agar lewat median (95)
const CONFIG = {
  // 'survive' = NEW DEFAULT - target lewat median R1
  survive: {
    targetDist: 11,
    hpFloor: 40,    // turun dari 75 → 40 supaya bisa push lebih jauh
    pushExtension: 1, // extend ke 12 kalau HP banyak
    maxDodge: 2,
    label: 'SURVIVE',
  },
  // 'push' = top 30%
  push: {
    targetDist: 13,
    hpFloor: 30,
    pushExtension: 1,
    maxDodge: 2,
    label: 'PUSH',
  },
  // 'aggressive' = top 10%
  aggressive: {
    targetDist: 15,
    hpFloor: 20,
    pushExtension: 0,
    maxDodge: 1,
    label: 'AGGRESSIVE',
  },
  // Backward compat
  defensive: {  // alias untuk survive
    targetDist: 11,
    hpFloor: 40,
    pushExtension: 1,
    maxDodge: 2,
    label: 'SURVIVE',
  },
  safe: {  // alias untuk push moderate
    targetDist: 12,
    hpFloor: 35,
    pushExtension: 1,
    maxDodge: 2,
    label: 'SAFE',
  },
};

const OPP = { W: 'S', S: 'W', A: 'D', D: 'A' };

const CORNERS = {
  N:  { dirs: ['W', 'W'], primary: 'W', perp: ['A', 'D'] },
  NE: { dirs: ['W', 'D'], primary: 'W', perp: ['A', 'S'] },
  E:  { dirs: ['D', 'D'], primary: 'D', perp: ['W', 'S'] },
  SE: { dirs: ['S', 'D'], primary: 'S', perp: ['W', 'A'] },
  S:  { dirs: ['S', 'S'], primary: 'S', perp: ['A', 'D'] },
  SW: { dirs: ['S', 'A'], primary: 'S', perp: ['W', 'D'] },
  W:  { dirs: ['A', 'A'], primary: 'A', perp: ['W', 'S'] },
  NW: { dirs: ['W', 'A'], primary: 'W', perp: ['S', 'D'] },
};
const CORNER_KEYS = Object.keys(CORNERS);

function getAgentSlot() {
  const cwd = process.cwd();
  const match = cwd.match(/agents[\/\\](\d+)$/);
  if (match) return parseInt(match[1], 10);
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

function isOpenable(nb, dir, strict = false) {
  const s = neighStatus(nb, dir);
  if (strict) return s === 'open';
  return s !== 'wall';
}

function nextStep(nb, pattern, lastDir, blocked = new Set()) {
  const primary = pattern[0];
  const alt = pattern[1];

  // Strict pass
  for (const d of [primary, alt]) {
    if (blocked.has(d)) continue;
    if (isOpenable(nb, d, true)) return { dir: d, confidence: 'high' };
  }

  const perp = primary === 'W' || primary === 'S' ? ['A', 'D'] : ['W', 'S'];
  for (const d of perp) {
    if (blocked.has(d)) continue;
    if (d === OPP[lastDir]) continue;
    if (isOpenable(nb, d, true)) return { dir: d, confidence: 'medium' };
  }

  // Lenient (accept unknown)
  for (const d of [primary, alt, ...perp]) {
    if (blocked.has(d)) continue;
    if (d === OPP[lastDir]) continue;
    if (isOpenable(nb, d, false)) return { dir: d, confidence: 'low' };
  }

  for (const d of ['W', 'A', 'S', 'D']) {
    if (blocked.has(d)) continue;
    return { dir: d, confidence: 'desperate' };
  }
  return { dir: primary, confidence: 'fallback' };
}

function dodgeStep(nb, pattern, lastDir, attemptN = 0) {
  const primary = pattern[0];
  const perp = primary === 'W' || primary === 'S' ? ['A', 'D'] : ['W', 'S'];
  let candidates;
  switch (attemptN) {
    case 0: candidates = perp; break;
    case 1: candidates = [pattern[1], primary]; break;
    default: candidates = ['W', 'A', 'S', 'D'];
  }
  for (const d of candidates) {
    if (d === OPP[lastDir]) continue;
    if (isOpenable(nb, d, true)) return d;
  }
  for (const d of candidates) {
    if (isOpenable(nb, d, false)) return d;
  }
  return primary;
}

function distFromCenter(x, y) {
  return Math.abs(x - 10) + Math.abs(y - 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================================================================
// MAIN PLAY
// ====================================================================
export async function play({ tournamentId, roundNum, roundEndsAt }) {
  // DEFAULT mode = 'survive' (was 'defensive' di v5)
  const mode = (process.env.MAZE_MODE || 'survive').toLowerCase();
  const cfg = CONFIG[mode] || CONFIG.survive;

  // Mutable copy biar bisa adaptive extend tanpa korup CONFIG global
  const targetDist = cfg.targetDist;
  let effectiveTarget = targetDist;
  let extended = false;

  const slot = getAgentSlot();
  const corner = pickCorner();
  const pattern = CORNERS[corner].dirs;

  log.game(
    `[maze] R${roundNum}: ${cfg.label} v6 | slot=${slot} corner=${corner} ` +
      `pattern=${pattern.join('')} target=${targetDist} floor=${cfg.hpFloor}`,
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
    log.warn(`[maze] R${roundNum}: ELIMINATED already, skip`);
    return;
  }

  const ms = pairing?.maze_state || pairing?.my_pairing?.maze_state || {};
  let pos = Array.isArray(ms.position) ? [...ms.position] : [10, 10];
  let hp = Number(ms.health ?? ms.hp ?? 100);
  let neighborhood = ms.neighborhood || null;
  let lastDir = null;
  let isDead = false;
  let consecutiveHighCost = 0;
  let stepCount = 0;

  const endTime = roundEndsAt
    ? new Date(roundEndsAt).getTime()
    : Date.now() + 9.5 * 60 * 1000;

  const phase1Deadline = endTime - 60_000; // reserve 60s for phase 2

  // ==== PHASE 1: PUSH PUSH PUSH (target 11+) ====
  while (!isDead && Date.now() < phase1Deadline) {
    const dist = distFromCenter(pos[0], pos[1]);

    // STOP: HP critical
    if (hp <= cfg.hpFloor) {
      log.game(`[maze] HP=${hp.toFixed(1)} <= floor ${cfg.hpFloor}, STOP at dist=${dist}`);
      break;
    }
    // STOP: death-zone (1 spike tile = mati)
    if (hp <= MAX_TILE + 5) {
      log.warn(`[maze] death-zone HP=${hp.toFixed(1)}, STOP at dist=${dist}`);
      break;
    }
    // STOP: high-cost zone (2 step berturut > 12 HP)
    // Tolerance lebih tinggi dari v5 (was 10) supaya tidak terlalu cepat stop
    if (consecutiveHighCost >= 2) {
      log.warn(`[maze] HIGH-COST zone (2 consec >12HP), STOP at dist=${dist} hp=${hp.toFixed(1)}`);
      break;
    }

    // Target reached?
    if (dist >= effectiveTarget) {
      // Adaptive extend kalau HP masih banyak
      if (
        !extended &&
        cfg.pushExtension > 0 &&
        hp >= cfg.hpFloor + 25 &&
        stepCount < 18
      ) {
        effectiveTarget += cfg.pushExtension;
        extended = true;
        log.game(`[maze] hit target, HP=${hp.toFixed(1)} ample, extend to ${effectiveTarget}`);
      } else {
        log.game(`[maze] dist=${dist} >= target ${effectiveTarget}, STOP`);
        break;
      }
    }

    // Chain length:
    //  - HP buffer >= floor+30: chain 2
    //  - else: chain 1 (hati-hati)
    let chainLen = hp >= cfg.hpFloor + 30 ? 2 : 1;

    const { dir, confidence } = nextStep(neighborhood, pattern, lastDir);

    if (confidence === 'desperate' || confidence === 'fallback') {
      log.warn(`[maze] no safe direction (${confidence}), STOP at dist=${dist}`);
      break;
    }

    const chain = [dir];
    if (chainLen >= 2 && confidence === 'high') {
      const altDir = pattern[1];
      if (isOpenable(neighborhood, altDir, false)) {
        chain.push(altDir);
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

    if (cost >= 13) consecutiveHighCost++;
    else consecutiveHighCost = 0;

    log.game(
      `[maze] STEP${stepCount} ${chain.join('')} pos=(${pos.join(',')}) hp=${hp.toFixed(1)} ` +
        `dist=${distFromCenter(pos[0], pos[1])} cost=${cost.toFixed(1)}` +
        (bumped ? ' [WALL_BUMP!]' : '') + ` conf=${confidence}`,
    );

    if (isDead) {
      log.err(`[maze] DIED at step ${stepCount}, score=0`);
      return;
    }

    if (bumped) {
      log.warn(`[maze] WALL_BUMP - neighborhood data was stale`);
      consecutiveHighCost = 2;
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
  log.game(
    `[maze] PUSH DONE: pos=(${pos.join(',')}) hp=${hp.toFixed(1)} dist=${finalDist} steps=${stepCount}`,
  );

  // ==== PHASE 2: ANTI-COLLAPSE (max 2 dodge) ====
  let dodgeCount = 0;

  while (
    !isDead &&
    hp >= SCAN_COST + 15 &&
    Date.now() < endTime - 10_000 &&
    dodgeCount < cfg.maxDodge
  ) {
    try {
      await sleep(1100);
      const check = await api.arena.mazeCheck(tournamentId, roundNum);
      const occupants = Number(check.tile_occupants ?? 1);
      hp = Number(check.health_left ?? hp - SCAN_COST);
      isDead = check.is_dead === true;

      log.game(`[maze] SCAN occupants=${occupants} hp=${hp.toFixed(1)}`);

      if (isDead) {
        log.err(`[maze] DIED on scan`);
        return;
      }
      if (occupants <= 1) {
        log.ok(`[maze] tile CLEAR`);
        break;
      }

      const collapseRisk = Math.min(1, (occupants - 1) * 0.25);
      if (hp < 25) {
        log.warn(
          `[maze] HP=${hp.toFixed(1)} too low to dodge, accept ${(collapseRisk * 100).toFixed(0)}% risk`,
        );
        break;
      }

      if (check.cooldown_until) {
        const wait = new Date(check.cooldown_until).getTime() - Date.now();
        if (wait > 0) await sleep(wait + 50);
      } else {
        await sleep(1100);
      }

      const dodge = dodgeStep(neighborhood, pattern, lastDir, dodgeCount);
      log.game(
        `[maze] DODGE${dodgeCount + 1} ${dodge} (occupants=${occupants}, risk=${(collapseRisk*100).toFixed(0)}%)`,
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
        if (e.status === 403 || /eliminated/i.test(e.message)) {
          log.warn(`[maze] eliminated during dodge`);
          break;
        }
        log.warn(`[maze] dodge error: ${e.message}`);
        break;
      }
      dodgeCount++;
    } catch (e) {
      if (e.status === 403 || /eliminated/i.test(e.message)) {
        log.warn(`[maze] eliminated during scan`);
        break;
      }
      log.warn(`[maze] scan error: ${e.message}`);
      break;
    }
  }

  if (dodgeCount > 0 && !isDead) {
    log.game(`[maze] anti-collapse: ${dodgeCount} dodge done`);
  }

  const final = distFromCenter(pos[0], pos[1]);
  const expectedScore = final * 10;
  log.ok(
    `[maze] R${roundNum} END: pos=(${pos.join(',')}) dist=${final} hp=${hp.toFixed(1)} ` +
      `expected_score=${expectedScore}+ (+1..50 tile)`,
  );
}
