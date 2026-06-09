// CAPTCHA Master strategy v5 - Optimized Shared Answer.
//
// IMPROVEMENT v5:
// 1. Adaptive retry delay: 1s, 2s, 3s, 4s, 5s (bukan flat 3s)
//    Total tetap 15s, tapi DAPAT puzzle lebih cepat kalau server seed cepet.
// 2. Polling shared file 0.5s (was 2s) - lebih responsif tanpa API call extra.
// 3. First-wave jitter 0-300ms (was 0-1000ms) - lebih cepat solve duluan.
// 4. Skip jitter kalau pre-check sudah dapat shared = no waste time.
// 5. Detailed timing log per phase: phase=t.0s/t.1s/etc untuk debug.
// 6. Race-condition fix: writeSharedAnswer pakai atomic write (rename trick)
//    biar dua agent tidak corrupt file barengan.
// 7. Re-attempt submit even setelah cooldown 5s habis - shared answer punya
//    chance update dari attempt agent lain.
// 8. Concurrent shared poll DURING solver call (kalau Groq lambat 5s,
//    cek shared tiap 0.5s sambil solver jalan, submit kalau dapat duluan).

import { log } from '../logger.js';
import { api } from '../api.js';
import { solveWithVision } from '../vision.js';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================================================================
// Shared answer file management - lokasi: xsleepybot/shared/
// ====================================================================
const SHARED_DIR = path.resolve(process.cwd(), '..', '..', 'shared');

function sharedAnswerPath(tournamentId, roundNum) {
  return path.join(SHARED_DIR, `captcha-${tournamentId}-R${roundNum}.json`);
}

function readSharedAnswer(tournamentId, roundNum) {
  try {
    const file = sharedAnswerPath(tournamentId, roundNum);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.tiles) || data.tiles.length === 0) return null;
    const age = Date.now() - (data.timestamp || 0);
    if (age > 10 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

// Atomic write: write to .tmp then rename (POSIX rename = atomic)
function writeSharedAnswer(tournamentId, roundNum, tiles, solver) {
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    const file = sharedAnswerPath(tournamentId, roundNum);
    const tmp = `${file}.${process.pid}.tmp`;
    const data = {
      tiles,
      solver,
      timestamp: Date.now(),
      tournamentId,
      roundNum,
    };
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    log.ok(`[captcha] shared written: ${JSON.stringify(tiles)} by ${solver}`);
  } catch (e) {
    log.warn(`[captcha] failed write shared: ${e.message}`);
  }
}

function cleanupOldShared() {
  try {
    if (!fs.existsSync(SHARED_DIR)) return;
    const files = fs.readdirSync(SHARED_DIR);
    const now = Date.now();
    for (const f of files) {
      if (!f.startsWith('captcha-')) continue;
      const full = path.join(SHARED_DIR, f);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > 30 * 60 * 1000) {
          fs.unlinkSync(full);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ====================================================================
// Provider chain
// ====================================================================
function buildProviders() {
  const list = [];
  const primary = (process.env.VISION_PROVIDER || 'groq').toLowerCase();
  const primaryKey = process.env.VISION_API_KEY || '';
  if (primary !== 'none' && primaryKey) {
    list.push({ provider: primary, apiKey: primaryKey, label: primary });
  }
  const fallback = (process.env.VISION_FALLBACK || '').toLowerCase();
  const fallbackKey = process.env.VISION_FALLBACK_KEY || '';
  if (fallback && fallback !== 'none' && fallbackKey) {
    list.push({ provider: fallback, apiKey: fallbackKey, label: fallback });
  }
  return list;
}

// ====================================================================
// Solve with concurrent shared-poll (race solver vs shared)
// Returns: { tiles, source }
//   source = 'self' (solver succeed) | 'shared' (shared appeared first)
// ====================================================================
async function solveWithConcurrentSharedPoll({
  provider, apiKey, imageUrl, label,
  tournamentId, roundNum, agentLabel,
}) {
  const t0 = Date.now();
  let solverDone = false;
  let solverResult = null;
  let solverError = null;

  // Solver (race competitor 1)
  const solverPromise = (async () => {
    try {
      const tiles = await solveWithVision({ provider, apiKey, imageUrl });
      solverResult = tiles;
    } catch (e) {
      solverError = e;
    } finally {
      solverDone = true;
    }
  })();

  // Shared poller (race competitor 2)
  while (!solverDone) {
    const shared = readSharedAnswer(tournamentId, roundNum);
    if (shared && shared.solver !== agentLabel) {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      log.game(
        `[captcha] shared appeared during ${label} solve at t+${dt}s -> use shared`,
      );
      return { tiles: shared.tiles, source: 'shared', sharedSolver: shared.solver };
    }
    await sleep(500);
  }

  await solverPromise;
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  if (solverError) {
    log.warn(`[captcha] ${label} failed in ${dt}s: ${solverError.message}`);
    return { tiles: null, source: 'self-failed' };
  }
  if (solverResult) {
    log.ok(`[captcha] ${label} solved in ${dt}s -> ${JSON.stringify(solverResult)}`);
    return { tiles: solverResult, source: 'self' };
  }
  return { tiles: null, source: 'self-failed' };
}

// ====================================================================
// Submit wrapper
// ====================================================================
async function submitAttempt(tournamentId, roundNum, tiles, attemptLabel) {
  try {
    const res = await api.arena.submitCaptcha(tournamentId, roundNum, tiles);
    if (res?.status === 'correct') {
      log.ok(
        `[captcha] CORRECT (${attemptLabel}) score=${res.score} solve=${res.solve_seconds}s`,
      );
      return { ok: true, res };
    }
    if (res?.status === 'wrong') {
      const cdSec = res.cooldown_seconds || 5;
      log.warn(`[captcha] WRONG (${attemptLabel}), cooldown ${cdSec}s`);
      return { ok: false, cooldownSec: cdSec };
    }
    log.warn(`[captcha] unknown status (${attemptLabel})`, res);
    return { ok: false };
  } catch (e) {
    if (e.status === 409) {
      log.warn(`[captcha] already solved (${attemptLabel})`);
      return { ok: true, alreadySolved: true };
    }
    if (e.status === 429) {
      const cd = e.data?.cooldown_remaining_seconds || 5;
      log.warn(`[captcha] cooldown 429 (${attemptLabel}) wait ${cd}s`);
      return { ok: false, cooldownSec: cd };
    }
    if (e.status === 503) {
      log.warn(`[captcha] puzzle not loaded 503 (${attemptLabel})`);
      return { ok: false, transient: true };
    }
    log.err(`[captcha] submit error (${attemptLabel}): ${e.message}`);
    return { ok: false };
  }
}

// ====================================================================
// Helper: try-submit-shared (cek shared, kalau ada submit)
// Returns true kalau submit success
// ====================================================================
async function trySubmitShared(tournamentId, roundNum, agentLabel, label, prevTiles = null) {
  const shared = readSharedAnswer(tournamentId, roundNum);
  if (!shared || shared.solver === agentLabel) return false;
  if (prevTiles && JSON.stringify(shared.tiles) === JSON.stringify(prevTiles)) {
    return false; // jangan submit jawaban sama yang sudah wrong
  }
  const r = await submitAttempt(tournamentId, roundNum, shared.tiles, label);
  return r.ok;
}

// ====================================================================
// Agent slot detection
// ====================================================================
function getAgentSlot() {
  const cwd = process.cwd();
  const match = cwd.match(/agents[\/\\](\d+)$/);
  return match ? parseInt(match[1], 10) : 1;
}

function getAgentLabel() {
  const slot = getAgentSlot();
  return `agent-${String(slot).padStart(2, '0')}`;
}

// ====================================================================
// MAIN PLAY
// ====================================================================
export async function play({ tournamentId, roundNum }) {
  const tStart = Date.now();
  const elapsed = () => ((Date.now() - tStart) / 1000).toFixed(1);
  const agentLabel = getAgentLabel();
  const slot = getAgentSlot();
  const providers = buildProviders();

  cleanupOldShared();

  log.game(`[captcha] R${roundNum}: PLAY START slot=${slot} t+0s`);

  // ============================================================
  // STEP 0: PRE-CHECK shared answer (instant submit kalau ada)
  // ============================================================
  if (await trySubmitShared(tournamentId, roundNum, agentLabel, 'shared-precheck')) {
    log.ok(`[captcha] R${roundNum}: SHARED pre-check WIN at t+${elapsed()}s`);
    return;
  }

  // ============================================================
  // STEP 1: FETCH PUZZLE dengan adaptive retry
  // Delay sequence: 1s, 2s, 3s, 4s, 5s = total 15s
  // Sambil polling shared answer setiap retry
  // ============================================================
  let pairing = null;
  let puzzle = null;
  const RETRY_DELAYS = [1000, 2000, 3000, 4000, 5000]; // adaptive

  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    try {
      pairing = await api.arena.pairing(tournamentId, roundNum);
      // DEBUG v5.1: log struktur pairing biar kita tau field puzzle ada di mana
      if (i === 0 && pairing) {
        const keys = Object.keys(pairing);
        log.game(`[captcha] DEBUG pairing keys: ${JSON.stringify(keys)}`);
        if (!pairing.puzzle && !pairing.my_pairing?.puzzle) {
          const summary = JSON.stringify(pairing).slice(0, 500);
          log.warn(`[captcha] DEBUG pairing body: ${summary}`);
        }
      }
    } catch (e) {
      log.warn(`[captcha] pairing fetch err try ${i + 1}: ${e.message}`);
    }

    if (pairing?.my_pairing?.is_bye || pairing?.is_bye) {
      log.game(`[captcha] R${roundNum}: BYE - skip`);
      return;
    }

    puzzle = pairing?.puzzle || pairing?.my_pairing?.puzzle;
    if (puzzle) {
      log.game(`[captcha] R${roundNum}: puzzle ready at t+${elapsed()}s (try ${i + 1})`);
      break;
    }

    // Poll shared during retry wait (every 250ms)
    const waitEnd = Date.now() + RETRY_DELAYS[i];
    while (Date.now() < waitEnd) {
      if (await trySubmitShared(tournamentId, roundNum, agentLabel, 'shared-during-retry')) {
        log.ok(`[captcha] R${roundNum}: SHARED during retry WIN at t+${elapsed()}s`);
        return;
      }
      await sleep(250);
    }

    log.warn(
      `[captcha] R${roundNum}: no puzzle (try ${i + 1}/${RETRY_DELAYS.length}) waited ${RETRY_DELAYS[i]/1000}s`,
    );
  }

  // ============================================================
  // STEP 2: Kalau puzzle masih kosong setelah 15s retry,
  // poll shared 20 detik lagi (250ms interval)
  // ============================================================
  if (!puzzle) {
    log.warn(`[captcha] R${roundNum}: puzzle EMPTY after retries, polling shared 20s...`);
    const waitEnd = Date.now() + 20_000;
    while (Date.now() < waitEnd) {
      if (await trySubmitShared(tournamentId, roundNum, agentLabel, 'shared-no-puzzle')) {
        log.ok(`[captcha] R${roundNum}: SHARED late WIN at t+${elapsed()}s`);
        return;
      }
      await sleep(250);
    }
    log.err(`[captcha] R${roundNum}: GIVE UP - no puzzle, no shared`);
    return;
  }

  // ============================================================
  // STEP 3: Stagger berdasarkan slot wave
  // FIRST wave (odd slot): 0-300ms (cepat solve duluan)
  // SECOND wave (even slot): 2000-3500ms (kasih waktu first wave solve dulu)
  // SKIP jitter kalau shared sudah ada
  // ============================================================
  const isFirstWave = slot % 2 === 1;
  let jitterMs;
  if (isFirstWave) {
    jitterMs = Math.floor(Math.random() * 300); // 0-300ms
  } else {
    jitterMs = 2000 + Math.floor(Math.random() * 1500); // 2000-3500ms
  }

  log.game(
    `[captcha] R${roundNum}: t+${elapsed()}s wave=${isFirstWave ? 'FIRST' : 'SECOND'} jitter=${jitterMs}ms`,
  );

  // Polling shared selama jitter (kalau muncul, langsung submit)
  if (jitterMs > 250) {
    const waitEnd = Date.now() + jitterMs;
    while (Date.now() < waitEnd) {
      if (await trySubmitShared(tournamentId, roundNum, agentLabel, 'shared-during-jitter')) {
        log.ok(`[captcha] R${roundNum}: SHARED during jitter WIN at t+${elapsed()}s`);
        return;
      }
      await sleep(250);
    }
  } else {
    await sleep(jitterMs);
  }

  // ============================================================
  // STEP 4: Solve sendiri pakai primary (concurrent shared poll)
  // ============================================================
  if (providers.length === 0) {
    log.warn(`[captcha] no vision provider configured`);
    return;
  }

  const p1 = providers[0];
  log.game(`[captcha] R${roundNum}: t+${elapsed()}s solving with ${p1.label}...`);
  const solve1 = await solveWithConcurrentSharedPoll({
    ...p1, imageUrl: puzzle.grid_image_url,
    tournamentId, roundNum, agentLabel,
  });

  if (solve1.source === 'shared') {
    // Shared muncul DURING solve - submit shared
    const r = await submitAttempt(tournamentId, roundNum, solve1.tiles, 'shared-during-solve');
    if (r.ok) {
      log.ok(`[captcha] R${roundNum}: SHARED during solve WIN at t+${elapsed()}s`);
      return;
    }
  }

  let tiles1 = solve1.tiles;

  // Kalau primary gagal (error), coba fallback provider untuk attempt 1
  if (!tiles1 && providers.length > 1) {
    log.warn(`[captcha] R${roundNum}: primary failed, try fallback for attempt-1`);

    // Cek shared dulu sebelum fallback
    if (await trySubmitShared(tournamentId, roundNum, agentLabel, 'shared-before-fallback')) {
      log.ok(`[captcha] R${roundNum}: SHARED before fallback WIN`);
      return;
    }

    const p2 = providers[1];
    const solve2 = await solveWithConcurrentSharedPoll({
      ...p2, imageUrl: puzzle.grid_image_url,
      tournamentId, roundNum, agentLabel,
    });
    if (solve2.source === 'shared') {
      const r = await submitAttempt(tournamentId, roundNum, solve2.tiles, 'shared-during-fallback');
      if (r.ok) return;
    }
    tiles1 = solve2.tiles;
  }

  if (!tiles1) {
    log.err(`[captcha] R${roundNum}: all solvers failed at t+${elapsed()}s, polling shared 30s`);
    const waitEnd = Date.now() + 30_000;
    while (Date.now() < waitEnd) {
      if (await trySubmitShared(tournamentId, roundNum, agentLabel, 'shared-final-wait')) {
        log.ok(`[captcha] R${roundNum}: SHARED final wait WIN at t+${elapsed()}s`);
        return;
      }
      await sleep(500);
    }
    log.err(`[captcha] R${roundNum}: GIVE UP after 30s wait`);
    return;
  }

  // ============================================================
  // STEP 5: Submit attempt 1
  // ============================================================
  const r1 = await submitAttempt(tournamentId, roundNum, tiles1, 'attempt1');
  if (r1.ok) {
    writeSharedAnswer(tournamentId, roundNum, tiles1, agentLabel);
    log.ok(`[captcha] R${roundNum}: SELF-SOLVE WIN at t+${elapsed()}s`);
    return;
  }

  if (r1.transient) {
    await sleep(2000);
    const rRetry = await submitAttempt(tournamentId, roundNum, tiles1, 'attempt1-retry');
    if (rRetry.ok) {
      writeSharedAnswer(tournamentId, roundNum, tiles1, agentLabel);
      return;
    }
    return;
  }

  // ============================================================
  // STEP 6: WRONG → poll shared aggressively during cooldown
  // ============================================================
  const cd1 = (r1.cooldownSec || 5) * 1000;
  const cdEnd = Date.now() + cd1;

  log.game(`[captcha] R${roundNum}: WRONG, polling shared during ${cd1/1000}s cooldown...`);
  while (Date.now() < cdEnd) {
    const shared = readSharedAnswer(tournamentId, roundNum);
    if (
      shared && shared.solver !== agentLabel &&
      JSON.stringify(shared.tiles) !== JSON.stringify(tiles1)
    ) {
      log.game(
        `[captcha] R${roundNum}: shared appeared during cooldown from ${shared.solver}`,
      );
      // Tunggu cooldown selesai
      const remaining = cdEnd - Date.now();
      if (remaining > 0) await sleep(remaining + 100);
      const r = await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-mid-cd');
      if (r.ok) {
        log.ok(`[captcha] R${roundNum}: SHARED mid-cd WIN at t+${elapsed()}s`);
        return;
      }
      break;
    }
    await sleep(250);
  }

  // Cek sekali lagi setelah cooldown
  const shared4 = readSharedAnswer(tournamentId, roundNum);
  if (
    shared4 && shared4.solver !== agentLabel &&
    JSON.stringify(shared4.tiles) !== JSON.stringify(tiles1)
  ) {
    const r = await submitAttempt(tournamentId, roundNum, shared4.tiles, 'shared-post-cd');
    if (r.ok) {
      log.ok(`[captcha] R${roundNum}: SHARED post-cd WIN at t+${elapsed()}s`);
      return;
    }
  }

  // ============================================================
  // STEP 7: Fallback solver (attempt 2)
  // ============================================================
  if (providers.length > 1) {
    const p2 = providers[1];
    log.game(`[captcha] R${roundNum}: t+${elapsed()}s try fallback ${p2.label}...`);
    const solve2 = await solveWithConcurrentSharedPoll({
      ...p2, imageUrl: puzzle.grid_image_url,
      tournamentId, roundNum, agentLabel,
    });

    if (solve2.source === 'shared') {
      const r = await submitAttempt(tournamentId, roundNum, solve2.tiles, 'shared-during-fb');
      if (r.ok) return;
    }

    if (solve2.tiles && JSON.stringify(solve2.tiles) !== JSON.stringify(tiles1)) {
      const r2 = await submitAttempt(tournamentId, roundNum, solve2.tiles, 'attempt2');
      if (r2.ok) {
        writeSharedAnswer(tournamentId, roundNum, solve2.tiles, agentLabel);
        log.ok(`[captcha] R${roundNum}: FALLBACK WIN at t+${elapsed()}s`);
        return;
      }
      // Wrong fallback - tunggu cooldown lalu poll shared
      if (r2.cooldownSec) {
        const cd2End = Date.now() + r2.cooldownSec * 1000;
        while (Date.now() < cd2End) {
          if (await trySubmitShared(
            tournamentId, roundNum, agentLabel, 'shared-mid-cd2',
            tiles1, // jangan submit kalau sama dengan attempt1 yang udah wrong
          )) {
            log.ok(`[captcha] R${roundNum}: SHARED mid-cd2 WIN at t+${elapsed()}s`);
            return;
          }
          await sleep(250);
        }
      }
    } else if (solve2.tiles) {
      log.warn(`[captcha] attempt2 same as attempt1, skip`);
    }
  }

  // ============================================================
  // STEP 8: Final wait for shared answer
  // ============================================================
  log.game(`[captcha] R${roundNum}: t+${elapsed()}s both attempts done, final wait 60s`);
  const finalEnd = Date.now() + 60_000;
  while (Date.now() < finalEnd) {
    const shared = readSharedAnswer(tournamentId, roundNum);
    if (
      shared && shared.solver !== agentLabel &&
      JSON.stringify(shared.tiles) !== JSON.stringify(tiles1)
    ) {
      log.ok(`[captcha] R${roundNum}: late shared from ${shared.solver}`);
      const r = await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-final');
      if (r.ok) {
        log.ok(`[captcha] R${roundNum}: SHARED final WIN at t+${elapsed()}s`);
        return;
      }
      // Mungkin masih cooldown
      if (r.cooldownSec) {
        await sleep(r.cooldownSec * 1000 + 200);
        const rR = await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-final-retry');
        if (rR.ok) return;
      }
    }
    await sleep(500);
  }

  log.warn(`[captcha] R${roundNum}: ROUND END t+${elapsed()}s without correct answer`);
}
