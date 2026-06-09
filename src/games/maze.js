// Maze Runner v5 - "Conservative Survival" strategy.
//
// LESSON LEARNED dari production log:
// - Bot v4 boros HP banget: final HP 4-25 (mestinya 50+)
// - Wall bump terjadi (cost=20 di log) = neighborhood detection bug
// - Random exit fase BUANG HP tanpa GAIN distance
// - Eliminated R1 = score R1 di bawah median (terlalu agresif/mati)
//
// FIX v5 - 4 prinsip:
//
// 1. HP CONSERVATION FIRST
//    - Step 1-by-1 saat HP < 75 (bukan chain 3)
//    - Stop push lebih awal (hpFloor naik)
//
// 2. NEVER WALL BUMP
//    - Validasi neighborhood STRICT sebelum tiap step
//    - Kalau primary direction = wall/oob/null -> pivot, jangan bump
//
// 3. NO RANDOM EXIT
//    - Random exit di v4 buang 15-25 HP untuk gain dist 0-2
//    - SKIP fase ini sepenuhnya
//    - Phase 2 cukup: scan + dodge 1-2 step (kalau perlu)
//
// 4. HIGH-COST DETECTION
//    - Setelah tiap step, monitor HP cost
//    - 2 step berturut cost > 10 = high-cost zone, STOP push
//    - 1 step cost > 25 = tile mengerikan, retreat 1 step lalu pivot
//
// MODE DEFAULT = 'defensive' (was 'safe')
//   - Target dist 7, hpFloor 75, survival 99%
//   - Score 70-90 (cukup untuk LEWAT median cutoff)

import { log } from '../logger.js';
import { api } from '../api.js';

// ====================================================================
// Konstanta
// ====================================================================
const MAX_TILE = 50;
const SCAN_COST = 5;
const WALL_BUMP_COST = 20;

const CONFIG = {
  defensive: {
    targetDist: 7,
    hpFloor: 75,        // stop push kalau HP <= ini
    pushExtension: 0,   // jangan extend - too risky
    maxDodge: 3,
    label: 'DEFENSIVE',
  },
  safe: {
    targetDist: 9,
    hpFloor: 65,
    pushExtension: 1,
    maxDodge: 2,
    label: 'SAFE',
  },
  push: {
    targetDist: 12,
    hpFloor: 45,
    pushExtension: 2,
    maxDodge: 2,
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
// Per-agent slot
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
// Neighborhood STRICT - return: 'open' | 'wall' | 'unknown'
// (was: true/false/null - confusing)
// ====================================================================
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

// "openable" = kita BOLEH coba (open atau unknown)
// Kalau strict mode, kita HANYA mau yang open.
function isOpenable(nb, dir, strict = false) {
  const s = neighStatus(nb, dir);
  if (strict) return s === 'open';
  return s !== 'wall'; // open atau unknown OK
}

// ====================================================================
// Pilih next direction - STRICT mode (hindari wall)
// Priority: corner directions > perpendicular > any open
// ====================================================================
function nextStep(nb, pattern, lastDir, blocked = new Set()) {
  const primary = pattern[0];
  const alt = pattern[1];

  // Strict pass: hanya yang DIPASTIKAN open
  for (const d of [primary, alt]) {
    if (blocked.has(d)) continue;
    if (isOpenable(nb, d, true)) return { dir: d, confidence: 'high' };
  }

  // Perpendicular (still strict open)
  const perp = primary === 'W' || primary === 'S' ? ['A', 'D'] : ['W', 'S'];
  for (const d of perp) {
    if (blocked.has(d)) continue;
    if (d === OPP[lastDir]) continue;
    if (isOpenable(nb, d, true)) return { dir: d, confidence: 'medium' };
  }

  // Lenient pass: terima unknown (akan di-monitor cost)
  for (const d of [primary, alt, ...perp]) {
    if (blocked.has(d)) continue;
    if (d === OPP[lastDir]) continue;
    if (isOpenable(nb, d, false)) return { dir: d, confidence: 'low' };
  }

  // Last resort: any direction
  for (const d of ['W', 'A', 'S', 'D']) {
    if (blocked.has(d)) continue;
    return { dir: d, confidence: 'desperate' };
  }
  return { dir: primary, confidence: 'fallback' };
}

// Dodge - perpendicular preferred
function dodgeStep(nb, pattern, lastDir, attemptN = 0) {
  const primary = pattern[0];
  const perp = primary === 'W' || primary === 'S' ? ['A', 'D'] : ['W', 'S'];

  let candidates;
  switch (attemptN) {
    case 0: candidates = perp; break;
    case 1: candidates = [pattern[1], primary]; break;
    default: candidates = ['W', 'A', 'S', 'D'];
  }

  // Strict: hanya open
  for (const d of candidates) {
    if (d === OPP[lastDir]) continue;
    if (isOpenable(nb, d, true)) return d;
  }
  // Lenient
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
  // DEFAULT mode = 'defensive' (was 'safe' di v4)
  const mode = (process.env.MAZE_MODE || 'defensive').toLowerCase();
  const cfg = CONFIG[mode] || CONFIG.defensive;
  const slot = getAgentSlot();
  const corner = pickCorner();
  const pattern = CORNERS[corner].dirs;

  log.game(
    `[maze] R${roundNum}: ${cfg.label} v5 | slot=${slot} corner=${corner} ` +
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
    log.game(`[maze] R${roundNum}: BYE`);
    return;
  }

  // Cek eliminated status (dari prior round)
  if (pairing?.eliminated || pairing?.my_pairing?.eliminated) {
    log.warn(`[maze] R${roundNum}: ELIMINATED in prior round, skip`);
    return;
  }

  const ms = pairing?.maze_state || pairing?.my_pairing?.maze_state || {};
  let pos = Array.isArray(ms.position) ? [...ms.position] : [10, 10];
  let hp = Number(ms.health ?? ms.hp ?? 100);
  let neighborhood = ms.neighborhood || null;
  let lastDir = null;
  let isDead = false;
  let consecutiveHighCost = 0; // counter for high-cost zone detection

  const endTime = roundEndsAt
    ? new Date(roundEndsAt).getTime()
    : Date.now() + 9.5 * 60 * 1000;

  // Reserve waktu lebih: 60s untuk phase 2 + buffer
  const phase1Deadline = endTime - 60_000;

  // ==== PHASE 1: CONSERVATIVE PUSH (1-by-1 saat HP rendah) ====
  let stepCount = 0;

  while (!isDead && Date.now() < phase1Deadline) {
    const dist = distFromCenter(pos[0], pos[1]);

    // STOP CONDITIONS - banyak layer
    if (hp <= cfg.hpFloor) {
      log.game(`[maze] HP=${hp.toFixed(1)} <= floor ${cfg.hpFloor}, STOP at dist=${dist}`);
      break;
    }
    // Death-zone: kena 1 spike tile = mati
    if (hp <= MAX_TILE + 5) {
      log.warn(`[maze] death-zone HP=${hp.toFixed(1)}, STOP at dist=${dist}`);
      break;
    }
    // High-cost zone detection
    if (consecutiveHighCost >= 2) {
      log.warn(`[maze] HIGH-COST zone (2 consec >10HP), STOP at dist=${dist} hp=${hp.toFixed(1)}`);
      break;
    }

    if (dist >= cfg.targetDist) {
      // Adaptive extend ONLY kalau HP berlimpah
      if (cfg.pushExtension > 0 && hp >= cfg.hpFloor + 25 && stepCount < 15) {
        log.game(`[maze] hit target ${cfg.targetDist}, HP ample (${hp.toFixed(1)}), extend +1`);
        cfg.targetDist += cfg.pushExtension; // mutate local copy via cfg... wait cfg is reference
        // Actually use a different var to avoid mutating shared CONFIG
        // Quick fix: just break here for safety
        log.game(`[maze] dist=${dist} >= target, STOP push (no extend in v5)`);
        break;
      }
      log.game(`[maze] dist=${dist} >= target, STOP push`);
      break;
    }

    // CHAIN LENGTH: lebih konservatif dari v4
    let chainLen;
    if (hp >= cfg.hpFloor + 30) chainLen = 2; // chain 2 saat HP buffer besar
    else chainLen = 1; // chain 1 saat HP rendah - bisa monitor cost per step

    // Pilih direction (strict no-wall)
    const { dir, confidence } = nextStep(neighborhood, pattern, lastDir);

    // CRITICAL CHECK: kalau confidence rendah, ekstra safety
    if (confidence === 'desperate' || confidence === 'fallback') {
      log.warn(`[maze] no safe direction (${confidence}), STOP at dist=${dist} hp=${hp.toFixed(1)}`);
      break;
    }

    // Build chain - kalau chainLen=1, single dir
    // Kalau chainLen=2, hanya tambah kalau confidence high
    const chain = [dir];
    if (chainLen >= 2 && confidence === 'high') {
      const altDir = pattern[1];
      if (isOpenable(neighborhood, altDir, false)) {
        chain.push(altDir);
      }
    }

    // Submit move
    let res;
    const hpBefore = hp;
    try {
      res = await api.arena.submitMaze(tournamentId, roundNum, chain.join(''));
    } catch (e) {
      // 403 eliminated -> stop
      if (e.status === 403 || /eliminated/i.test(e.message)) {
        log.warn(`[maze] eliminated (403), stop`);
        break;
      }
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

    let bumped = false;
    if (Array.isArray(res.moves)) {
      for (const m of res.moves) {
        if (m.result === 'wall_bump') bumped = true;
        if (m.neighborhood) neighborhood = m.neighborhood;
      }
    }

    const cost = hpBefore - hp;
    stepCount++;

    if (cost >= 11) consecutiveHighCost++;
    else consecutiveHighCost = 0;

    log.game(
      `[maze] STEP${stepCount} ${chain.join('')} pos=(${pos.join(',')}) hp=${hp.toFixed(1)} ` +
        `dist=${distFromCenter(pos[0], pos[1])} cost=${cost.toFixed(1)}` +
        (bumped ? ' [WALL_BUMP!]' : '') + ` conf=${confidence}`,
    );

    if (isDead) {
      log.err(`[maze] DIED, score=0`);
      return;
    }

    // Kalau bumped wall, log warning + extra cost penalty
    if (bumped) {
      log.warn(`[maze] WALL BUMP detected - neighborhood data was wrong/stale`);
      // Force chain length = 1 next iteration
      consecutiveHighCost = 2; // trigger stop
    }

    lastDir = chain[chain.length - 1];

    // Cooldown
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

  // ==== PHASE 2: ANTI-COLLAPSE (BUKAN random exit!) ====
  // Phase 2 kita PANGKAS jadi lebih simple & efektif:
  // - Scan tile sekali (cost 5 HP)
  // - Kalau crowded (>=2 agent), dodge 1 step perpendicular
  // - Kalau setelah dodge masih crowded, dodge 1 step lagi (max 2 dodge)
  // - Selesai. JANGAN random walk.

  let dodgeCount = 0;

  while (
    !isDead &&
    hp >= SCAN_COST + 15 &&  // butuh HP minimum untuk scan + dodge
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
        log.ok(`[maze] tile CLEAR (1 agent)`);
        break;
      }

      const collapseRisk = Math.min(1, (occupants - 1) * 0.25);

      // HP terlalu rendah untuk dodge?
      if (hp < 25) {
        log.warn(
          `[maze] HP=${hp.toFixed(1)} too low to dodge, accept ${(collapseRisk * 100).toFixed(0)}% risk`,
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
    log.game(`[maze] anti-collapse done: ${dodgeCount} dodge`);
  }

  // ==== FINAL ====
  const final = distFromCenter(pos[0], pos[1]);
  const expectedScore = final * 10;
  log.ok(
    `[maze] R${roundNum} END: pos=(${pos.join(',')}) dist=${final} hp=${hp.toFixed(1)} ` +
      `expected_score=${expectedScore}+ (+1..50 tile)`,
  );
}
