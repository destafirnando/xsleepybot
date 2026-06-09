// CAPTCHA Master strategy v3 - Shared Answer Mode.
//
// KONSEP UTAMA:
// 10 agent jalan di HP yang sama. Saat 1 agent berhasil solve CORRECT,
// jawaban ditulis ke shared file. Agent lain yang belum submit bisa
// langsung pakai jawaban tersebut tanpa buang waktu solve sendiri.
//
// FLOW per agent:
// 1. Cek shared answer file dulu → kalau ada + fresh → submit langsung!
// 2. Kalau belum ada → solve dengan Groq → submit
// 3. Kalau CORRECT → tulis ke shared answer file
// 4. Kalau WRONG → cek shared answer lagi (mungkin agent lain sudah solve)
//    → retry dengan fallback Gemini
//    → kalau CORRECT → tulis ke shared
// 5. Loop: cek shared answer tiap 2 detik selama round masih berjalan
//    (kalau agent lain belum submit, tunggu answer dari yang sudah correct)
//
// ANTI-RATE-LIMIT:
// - Stagger 0-3s random di awal
// - Cuma 2-3 agent yang benar-benar solve (sisanya tunggu answer)
// - Hemat quota Groq + Gemini

import { log } from '../logger.js';
import { api } from '../api.js';
import { solveWithVision } from '../vision.js';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================================================================
// Shared answer file management
// Key = tournament_id + round_num → jawaban unik per round
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
    // Validate: must be recent (< 10 min), must have tiles array
    if (!Array.isArray(data.tiles) || data.tiles.length === 0) return null;
    const age = Date.now() - (data.timestamp || 0);
    if (age > 10 * 60 * 1000) return null; // stale, ignore
    return data;
  } catch {
    return null;
  }
}

function writeSharedAnswer(tournamentId, roundNum, tiles, solver) {
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    const file = sharedAnswerPath(tournamentId, roundNum);
    const data = {
      tiles,
      solver, // agent folder yang solve
      timestamp: Date.now(),
      tournamentId,
      roundNum,
    };
    fs.writeFileSync(file, JSON.stringify(data));
    log.ok(`[captcha] shared answer written: ${JSON.stringify(tiles)} by ${solver}`);
  } catch (e) {
    log.warn(`[captcha] failed to write shared answer: ${e.message}`);
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
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > 30 * 60 * 1000) {
        fs.unlinkSync(full);
      }
    }
  } catch { /* ignore */ }
}

// ====================================================================
// Provider chain builder
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
// Solve wrapper with timing
// ====================================================================
async function trySolve(provider, apiKey, imageUrl, label) {
  const t0 = Date.now();
  try {
    const tiles = await solveWithVision({ provider, apiKey, imageUrl });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log.ok(`[captcha] ${label} solved in ${dt}s -> ${JSON.stringify(tiles)}`);
    return tiles;
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log.warn(`[captcha] ${label} failed in ${dt}s: ${e.message}`);
    return null;
  }
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
      log.warn(`[captcha] cooldown (${attemptLabel}) wait ${cd}s`);
      return { ok: false, cooldownSec: cd };
    }
    if (e.status === 503) {
      log.warn(`[captcha] puzzle not loaded (${attemptLabel})`);
      return { ok: false, transient: true };
    }
    throw e;
  }
}

// ====================================================================
// Agent slot detection (sama seperti maze)
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
  const agentLabel = getAgentLabel();
  const slot = getAgentSlot();
  const providers = buildProviders();

  // Cleanup stale shared answers
  cleanupOldShared();

  // ===== STEP 0: PRE-CHECK SHARED ANSWER =====
  // Cek shared answer DULU sebelum tarik pairing/puzzle.
  // Kalau ada → submit langsung, tidak butuh puzzle sama sekali!
  const preShared = readSharedAnswer(tournamentId, roundNum);
  if (preShared && preShared.solver !== agentLabel) {
    log.game(
      `[captcha] R${roundNum}: shared answer FOUND (pre-check) dari ${preShared.solver}: ${JSON.stringify(preShared.tiles)}`,
    );
    const r = await submitAttempt(tournamentId, roundNum, preShared.tiles, 'shared-precheck');
    if (r.ok) return;
    log.warn(`[captcha] shared answer wrong, fall through ke flow normal`);
    if (r.cooldownSec) await sleep(r.cooldownSec * 1000 + 200);
  }

  // ===== STEP 1: FETCH PUZZLE dengan RETRY + polling shared =====
  // Server kadang lambat seed puzzle. Retry sampai 5x sambil cek shared.
  let pairing = null;
  let puzzle = null;
  const PAIRING_RETRY = 5;

  for (let i = 0; i < PAIRING_RETRY; i++) {
    try {
      pairing = await api.arena.pairing(tournamentId, roundNum);
    } catch (e) {
      log.warn(`[captcha] pairing fetch error attempt ${i + 1}: ${e.message}`);
    }

    if (pairing?.my_pairing?.is_bye || pairing?.is_bye) {
      log.game(`[captcha] R${roundNum}: BYE - skip`);
      return;
    }

    puzzle = pairing?.puzzle || pairing?.my_pairing?.puzzle;
    if (puzzle) break;

    // No puzzle yet - check shared answer (mungkin agent lain sudah dapat)
    const sharedDuringWait = readSharedAnswer(tournamentId, roundNum);
    if (sharedDuringWait && sharedDuringWait.solver !== agentLabel) {
      log.game(
        `[captcha] R${roundNum}: no puzzle yet, but shared answer ada from ${sharedDuringWait.solver}: ${JSON.stringify(sharedDuringWait.tiles)}`,
      );
      const r = await submitAttempt(tournamentId, roundNum, sharedDuringWait.tiles, 'shared-no-puzzle');
      if (r.ok) return;
      if (r.cooldownSec) await sleep(r.cooldownSec * 1000 + 200);
    }

    log.warn(
      `[captcha] R${roundNum}: no puzzle (try ${i + 1}/${PAIRING_RETRY}) - server belum seed, wait 3s`,
    );
    await sleep(3000);
  }

  if (!puzzle) {
    log.warn(`[captcha] R${roundNum}: puzzle masih kosong setelah ${PAIRING_RETRY} retry`);
    // Final wait loop: poll shared answer 20s
    const waitEnd = Date.now() + 20_000;
    while (Date.now() < waitEnd) {
      const shared = readSharedAnswer(tournamentId, roundNum);
      if (shared && shared.solver !== agentLabel) {
        log.ok(`[captcha] late shared answer found: ${JSON.stringify(shared.tiles)}`);
        const r = await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-after-no-puzzle');
        if (r.ok) return;
        if (r.cooldownSec) await sleep(r.cooldownSec * 1000 + 200);
      }
      await sleep(2000);
    }
    log.err(`[captcha] R${roundNum}: give up - no puzzle, no shared answer`);
    return;
  }

  // ===== STEP 2: Stagger berdasarkan slot wave =====
  const isFirstWave = slot % 2 === 1;
  const jitterMs = isFirstWave
    ? Math.floor(Math.random() * 1000)
    : 3000 + Math.floor(Math.random() * 2000);

  log.game(
    `[captcha] R${roundNum}: slot=${slot} wave=${isFirstWave ? 'FIRST' : 'SECOND'} jitter=${jitterMs}ms`,
  );
  await sleep(jitterMs);

  const existing2 = readSharedAnswer(tournamentId, roundNum);
  if (existing2 && existing2.solver !== agentLabel) {
    log.game(
      `[captcha] R${roundNum}: shared answer appeared from ${existing2.solver}: ${JSON.stringify(existing2.tiles)}`,
    );
    const r = await submitAttempt(tournamentId, roundNum, existing2.tiles, 'shared-post-jitter');
    if (r.ok) return;
    if (r.cooldownSec) await sleep(r.cooldownSec * 1000 + 200);
  }

  // ===== STEP 3: Solve sendiri dengan primary provider =====
  if (providers.length === 0) {
    log.warn(`[captcha] no vision provider configured - skip`);
    return;
  }

  const p1 = providers[0];
  let tiles1 = await trySolve(p1.provider, p1.apiKey, puzzle.grid_image_url, p1.label);

  if (!tiles1) {
    const shared3 = readSharedAnswer(tournamentId, roundNum);
    if (shared3 && shared3.solver !== agentLabel) {
      log.game(`[captcha] primary failed, using shared answer: ${JSON.stringify(shared3.tiles)}`);
      const r = await submitAttempt(tournamentId, roundNum, shared3.tiles, 'shared-after-fail');
      if (r.ok) return;
    }
    if (providers.length > 1) {
      const p2 = providers[1];
      tiles1 = await trySolve(p2.provider, p2.apiKey, puzzle.grid_image_url, p2.label);
    }
    if (!tiles1) {
      log.err(`[captcha] all solvers failed - waiting for shared answer`);
      const waitEnd = Date.now() + 30_000;
      while (Date.now() < waitEnd) {
        await sleep(2000);
        const shared = readSharedAnswer(tournamentId, roundNum);
        if (shared && shared.solver !== agentLabel) {
          log.ok(`[captcha] got shared answer while waiting: ${JSON.stringify(shared.tiles)}`);
          await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-wait');
          return;
        }
      }
      log.err(`[captcha] no answer found after 30s wait - give up`);
      return;
    }
  }

  // ===== STEP 4: Submit attempt 1 =====
  const r1 = await submitAttempt(tournamentId, roundNum, tiles1, 'attempt1');
  if (r1.ok) {
    writeSharedAnswer(tournamentId, roundNum, tiles1, agentLabel);
    return;
  }

  if (r1.transient) {
    await sleep(3000);
    const rRetry = await submitAttempt(tournamentId, roundNum, tiles1, 'attempt1-retry');
    if (rRetry.ok) {
      writeSharedAnswer(tournamentId, roundNum, tiles1, agentLabel);
      return;
    }
    return;
  }

  // ===== STEP 5: Wrong → poll shared during cooldown + fallback =====
  const cd1 = (r1.cooldownSec || 5) * 1000;
  const cdEnd = Date.now() + cd1;

  while (Date.now() < cdEnd) {
    await sleep(1000);
    const sharedMid = readSharedAnswer(tournamentId, roundNum);
    if (sharedMid && sharedMid.solver !== agentLabel && JSON.stringify(sharedMid.tiles) !== JSON.stringify(tiles1)) {
      log.game(
        `[captcha] shared answer appeared during cooldown from ${sharedMid.solver}`,
      );
      const remaining = cdEnd - Date.now();
      if (remaining > 0) await sleep(remaining + 100);
      const r = await submitAttempt(tournamentId, roundNum, sharedMid.tiles, 'shared-mid-cd');
      if (r.ok) return;
      break;
    }
  }

  const shared4 = readSharedAnswer(tournamentId, roundNum);
  if (shared4 && shared4.solver !== agentLabel && JSON.stringify(shared4.tiles) !== JSON.stringify(tiles1)) {
    const r = await submitAttempt(tournamentId, roundNum, shared4.tiles, 'shared-post-cd');
    if (r.ok) return;
  }

  // ===== STEP 6: Fallback solver (attempt 2) =====
  if (providers.length > 1) {
    const p2 = providers[1];
    const tiles2 = await trySolve(p2.provider, p2.apiKey, puzzle.grid_image_url, p2.label);
    if (tiles2 && JSON.stringify(tiles2) !== JSON.stringify(tiles1)) {
      const r2 = await submitAttempt(tournamentId, roundNum, tiles2, 'attempt2');
      if (r2.ok) {
        writeSharedAnswer(tournamentId, roundNum, tiles2, agentLabel);
        return;
      }
      log.warn(`[captcha] attempt2 also wrong`);
    } else if (tiles2) {
      log.warn(`[captcha] attempt2 same as attempt1, skip`);
    }
  }

  // ===== STEP 7: Final wait — tunggu shared answer dari agent lain =====
  log.game(`[captcha] both attempts failed, waiting shared answer (max 30s)...`);
  const finalWaitEnd = Date.now() + 30_000;
  while (Date.now() < finalWaitEnd) {
    await sleep(2000);
    const sharedFinal = readSharedAnswer(tournamentId, roundNum);
    if (sharedFinal && sharedFinal.solver !== agentLabel && JSON.stringify(sharedFinal.tiles) !== JSON.stringify(tiles1)) {
      log.ok(`[captcha] final shared answer from ${sharedFinal.solver}: ${JSON.stringify(sharedFinal.tiles)}`);
      await submitAttempt(tournamentId, roundNum, sharedFinal.tiles, 'shared-final');
      return;
    }
  }

  log.warn(`[captcha] round ${roundNum} finished without correct answer`);
}
