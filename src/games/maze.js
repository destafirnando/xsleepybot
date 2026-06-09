// Maze Runner strategy v4 - "Spread, Survive, Random Exit".
//
// MASALAH v3: Bot push ke target dist OK, tapi ratusan agent lain (bukan
// cuma kita) juga push ke ring dist=10 -> tile collision -> collapse 100%.
// Hasil: round 1 score 0, eliminated round 2.
//
// FIX v4 - Tiga lapisan anti-collision:
//   1. SPREAD push ke 8 corner berbeda (dari v3, masih dipakai)
//   2. RANDOM EXIT: setelah hit target dist, walk random 2-4 step
//      perpendicular -> agent yang same-corner pun beda tile akhirnya
//   3. AGGRESSIVE DODGE: sampai 5 attempt scan+dodge, stop saat clear
//
// 3 MODE:
//   - defensive (NEW): target dist 7, hpFloor 70, paling aman, score 70-80
//   - safe (default): target dist 10, hpFloor 60, score 100-130
//   - push: target dist 14, hpFloor 40, score 140-180

import { log } from '../logger.js';
import { api } from '../api.js';

// ====================================================================
// Konstanta
// ====================================================================
const MAX_TILE = 50;
const SCAN_COST = 5;
const HIGH_AVG_COST_THRESHOLD = 9;

const CONFIG = {
  defensive: {
    targetDist: 7,
    hpFloor: 70,
    pushExtension: 1,
    bufferForExtend: 30,
    randomExitMin: 1,
    randomExitMax: 3,
    maxDodge: 5,
    label: 'DEFENSIVE',
  },
  safe: {
    targetDist: 10,
    hpFloor: 60,
    pushExtension: 2,
    bufferForExtend: 25,
    randomExitMin: 2,
    randomExitMax: 4,
    maxDodge: 4,
    label: 'SAFE',
  },
  push: {
    targetDist: 14,
    hpFloor: 40,
    pushExtension: 4,
    bufferForExtend: 25,
    randomExitMin: 1,
    randomExitMax: 2, // push mode lebih sedikit random exit (sayang HP)
    maxDodge: 3,
    label: 'PUSH',
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

// ====================================================================
// Per-agent slot detection
// ====================================================================
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
// Pilih next direction (push phase)
// ====================================================================
function nextStep(nb, pattern, stepIdx, lastDir, blockedDirs = new Set()) {
  const primary = pattern[stepIdx % pattern.length];
  const alt = pattern[(stepIdx + 1) % pattern.length];
  if (!blockedDirs.has(primary) && neighOpen(nb, primary) !== false) return primary;
  if (alt !== primary && !blockedDirs.has(alt) && neighOpen(nb, alt) !== false) return alt;
  for (const d of ['W', 'A', 'S', 'D']) {
    if (d === primary || d === alt) continue;
    if (blockedDirs.has(d)) continue;
    if (d === OPP[lastDir]) continue;
    if (neighOpen(nb, d) !== false) return d;
  }
  for (const d of ['W', 'A', 'S', 'D']) {
    if (blockedDirs.has(d)) continue;
    if (neighOpen(nb, d) !== false) return d;
  }
  return primary;
}

// ====================================================================
// RANDOM EXIT direction - perpendicular ke pattern, random pilih
// Tujuan: setelah push, walk side-to-side biar tile akhir TIDAK PREDICTABLE
// ====================================================================
function randomExitStep(nb, corner, lastDir) {
  const c = CORNERS[corner];
  const perpDirs = c.perp.slice();
  // Shuffle
  for (let i = perpDirs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [perpDirs[i], perpDirs[j]] = [perpDirs[j], perpDirs[i]];
  }
  for (const d of perpDirs) {
    if (d === OPP[lastDir]) continue;
    if (neighOpen(nb, d) !== false) return d;
  }
  // Fallback: any open
  for (const d of perpDirs) {
    if (neighOpen(nb, d) !== false) return d;
  }
  return perpDirs[0] || 'A';
}

// ====================================================================
// DODGE direction - 5 strategi escalating
// ====================================================================
function dodgeStep(nb, pattern, lastDir, attemptN = 0) {
  const primary = pattern[0];
  const alt = pattern[1];
  let candidates;
  switch (attemptN) {
    case 0: candidates = [alt, primary]; break;
    case 1: {
      // perpendicular 90deg
      const perp = primary === 'W' || primary === 'S' ? ['D', 'A'] : ['W', 'S'];
      candidates = perp;
      break;
    }
    case 2: candidates = [primary, alt]; break;
    case 3: {
      // any direction kecuali OPP
      candidates = ['W', 'A', 'S', 'D'].filter((d) => d !== OPP[lastDir]);
      // shuffle
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      break;
    }
    default: candidates = ['W', 'A', 'S', 'D'];
  }
  for (const d of candidates) {
    if (d === OPP[lastDir]) continue;
    if (neighOpen(nb, d) !== false) return d;
  }
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
// Main play
// ====================================================================
export async function play({ tournamentId, roundNum, roundEndsAt }) {
  const mode = (process.env.MAZE_MODE || 'safe').toLowerCase();
  const cfg = CONFIG[mode] || CONFIG.safe;
  const slot = getAgentSlot();
  const corner = pickCorner();
  const pattern = CORNERS[corner].dirs;

  log.game(
    `[maze] R${roundNum}: ${cfg.label} | slot=${slot} corner=${corner} ` +
      `pattern=${pattern.join('')} target=${cfg.targetDist} floor=${cfg.hpFloor}`,
  );

  let pairing;
  try {
    pairing = await api.arena.pairing(tournamentId, roundNum);
  } catch (e) {
    log.err(`[maze] pairing fail: ${e.message}`);
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
  const stepsHistory = [];

  const endTime = roundEndsAt
    ? new Date(roundEndsAt).getTime()
    : Date.now() + 9.5 * 60 * 1000;

  // Reserve waktu: 90 detik untuk random exit + 5 dodge attempt + buffer
  const phase1Deadline = endTime - 90_000;

  // ==== PHASE 1: PUSH ====
  while (!isDead && Date.now() < phase1Deadline) {
    const dist = distFromCenter(pos[0], pos[1]);

    if (hp <= cfg.hpFloor) {
      log.game(`[maze] HP=${hp.toFixed(1)} ≤ floor ${cfg.hpFloor}, stop push at dist=${dist}`);
      break;
    }
    if (hp <= MAX_TILE + 1) {
      log.warn(`[maze] death-zone HP=${hp.toFixed(1)}, stop push at dist=${dist}`);
      break;
    }
    if (stepsHistory.length >= 3) {
      const recent = stepsHistory.slice(-3);
      const avgCost = recent.reduce((a, b) => a + b.cost, 0) / recent.length;
      if (avgCost > HIGH_AVG_COST_THRESHOLD && hp < cfg.hpFloor + 25) {
        log.warn(`[maze] avg cost ${avgCost.toFixed(1)} HP/step boros, stop early dist=${dist}`);
        break;
      }
    }
    if (dist >= effectiveTarget) {
      if (!extended && hp >= cfg.hpFloor + cfg.bufferForExtend && cfg.pushExtension > 0) {
        effectiveTarget += cfg.pushExtension;
        extended = true;
        log.game(`[maze] HP=${hp.toFixed(1)} ample, extend target -> ${effectiveTarget}`);
      } else {
        log.game(`[maze] dist=${dist} ≥ ${effectiveTarget}, stop push`);
        break;
      }
    }

    let chainLen;
    if (hp >= cfg.hpFloor + 35) chainLen = 3;
    else if (hp >= cfg.hpFloor + 15) chainLen = 2;
    else chainLen = 1;

    const chain = [];
    for (let i = 0; i < chainLen; i++) {
      const dir = i === 0
        ? nextStep(neighborhood, pattern, stepIdx, lastDir)
        : pattern[(stepIdx + 1) % pattern.length];
      chain.push(dir);
      lastDir = dir;
      stepIdx++;
    }

    let res;
    const hpBefore = hp;
    try {
      res = await api.arena.submitMaze(tournamentId, roundNum, chain.join(''));
    } catch (e) {
      if (e.status === 429) {
        const wait = e.data?.cooldown_remaining_seconds ? e.data.cooldown_remaining_seconds * 1000 : 1100;
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
    stepsHistory.push({ dirs: chain.join(''), cost });

    log.game(
      `[maze] PUSH ${chain.join('')} pos=(${pos.join(',')}) hp=${hp.toFixed(1)} ` +
        `dist=${distFromCenter(pos[0], pos[1])} cost=${cost.toFixed(1)}${bumps ? ` bumps=${bumps}` : ''}`,
    );

    if (isDead) {
      log.err(`[maze] DIED in push phase, score=0`);
      return;
    }

    if (res.cooldown_until) {
      const wait = new Date(res.cooldown_until).getTime() - Date.now();
      if (wait > 0) await sleep(wait + 50);
    } else {
      await sleep(1100);
    }
  }

  const distAfterPush = distFromCenter(pos[0], pos[1]);
  log.game(`[maze] push done: pos=(${pos.join(',')}) hp=${hp.toFixed(1)} dist=${distAfterPush}`);

  // ==== PHASE 1.5: RANDOM EXIT ====
  // Walk perpendicular 1-4 step random untuk ANTI-CLUSTER.
  // Ini key fix untuk masalah "ratusan agent stop di ring sama".
  // Setiap agent dapat exit count unik (slot-based jitter).
  const exitBaseCount = cfg.randomExitMin + ((slot * 7) % (cfg.randomExitMax - cfg.randomExitMin + 1));
  const exitJitter = Math.random() < 0.3 ? 1 : 0; // 30% chance +1 random
  const exitCount = exitBaseCount + exitJitter;

  log.game(`[maze] RANDOM_EXIT: target ${exitCount} step (slot-based)`);

  let exitDone = 0;
  for (let i = 0; i < exitCount; i++) {
    if (hp <= SCAN_COST + 15) {
      log.warn(`[maze] HP=${hp.toFixed(1)} too low for more random exit`);
      break;
    }
    if (Date.now() >= endTime - 30_000) {
      log.warn(`[maze] running out of time, stop random exit`);
      break;
    }

    const dir = randomExitStep(neighborhood, corner, lastDir);
    let res;
    const hpBefore = hp;
    try {
      res = await api.arena.submitMaze(tournamentId, roundNum, dir);
    } catch (e) {
      if (e.status === 429) {
        await sleep(1200);
        i--;
        continue;
      }
      log.warn(`[maze] random_exit error: ${e.message}`);
      break;
    }

    pos = res.final_position || pos;
    hp = Number(res.health_left ?? hp);
    isDead = res.is_dead === true;
    if (Array.isArray(res.moves)) {
      for (const m of res.moves) {
        if (m.neighborhood) neighborhood = m.neighborhood;
      }
    }
    const cost = hpBefore - hp;
    log.game(
      `[maze] EXIT ${dir} pos=(${pos.join(',')}) hp=${hp.toFixed(1)} ` +
        `dist=${distFromCenter(pos[0], pos[1])} cost=${cost.toFixed(1)}`,
    );

    if (isDead) {
      log.err(`[maze] DIED in random exit`);
      return;
    }

    lastDir = dir;
    exitDone++;

    if (res.cooldown_until) {
      const wait = new Date(res.cooldown_until).getTime() - Date.now();
      if (wait > 0) await sleep(wait + 50);
    } else {
      await sleep(1100);
    }
  }

  log.game(
    `[maze] random_exit done: ${exitDone}/${exitCount} step, pos=(${pos.join(',')}) ` +
      `dist=${distFromCenter(pos[0], pos[1])}`,
  );

  // ==== PHASE 2: SCAN + DODGE LOOP (sampai tile clear atau HP habis) ====
  let dodgeAttempt = 0;
  const MAX_DODGE = cfg.maxDodge;

  while (
    !isDead &&
    hp > SCAN_COST + 10 &&
    Date.now() < endTime - 5_000 &&
    dodgeAttempt < MAX_DODGE
  ) {
    try {
      await sleep(1100);
      const check = await api.arena.mazeCheck(tournamentId, roundNum);
      const occupants = Number(check.tile_occupants ?? 1);
      hp = Number(check.health_left ?? hp - SCAN_COST);
      isDead = check.is_dead === true;

      log.game(
        `[maze] SCAN#${dodgeAttempt + 1} occupants=${occupants} hp=${hp.toFixed(1)}`,
      );

      if (isDead) {
        log.err(`[maze] DIED on scan`);
        return;
      }

      if (occupants <= 1) {
        log.ok(`[maze] tile CLEAR (1 agent), no more dodge`);
        break;
      }

      const collapseRisk = Math.min(1, (occupants - 1) * 0.25);

      if (hp < 25) {
        log.warn(`[maze] HP=${hp.toFixed(1)} too low to dodge, accept ${(collapseRisk*100).toFixed(0)}% risk`);
        break;
      }

      if (check.cooldown_until) {
        const wait = new Date(check.cooldown_until).getTime() - Date.now();
        if (wait > 0) await sleep(wait + 50);
      } else {
        await sleep(1100);
      }

      const dodge = dodgeStep(neighborhood, pattern, lastDir, dodgeAttempt);
      log.game(
        `[maze] DODGE#${dodgeAttempt + 1} dir=${dodge} (occupants=${occupants}, risk=${(collapseRisk*100).toFixed(0)}%)`,
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
        log.warn(`[maze] dodge submit fail: ${e.message}`);
        break;
      }

      dodgeAttempt++;
    } catch (e) {
      log.warn(`[maze] scan/dodge error: ${e.message}`);
      break;
    }
  }

  if (dodgeAttempt > 0 && !isDead) {
    log.game(`[maze] anti-collapse: ${dodgeAttempt} dodge done, pos=(${pos.join(',')})`);
  }

  // ==== FINAL ====
  const finalDist = distFromCenter(pos[0], pos[1]);
  const expectedScore = finalDist * 10;
  log.ok(
    `[maze] R${roundNum} done: pos=(${pos.join(',')}) dist=${finalDist} hp=${hp.toFixed(1)} ` +
      `expected_score=${expectedScore}+ (+1..50 tile)`,
  );
}
