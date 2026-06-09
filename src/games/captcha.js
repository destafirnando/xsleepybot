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
  const pairing = await api.arena.pairing(tournamentId, roundNum);

  const puzzle = pairing?.puzzle || pairing?.my_pairing?.puzzle;
  if (!puzzle) {
    log.warn(`[captcha] R${roundNum}: no puzzle - server belum seed`);
    return;
  }
  if (pairing?.my_pairing?.is_bye || pairing?.is_bye) {
    log.game(`[captcha] R${roundNum}: BYE - skip`);
    return;
  }

  const providers = buildProviders();
  const agentLabel = getAgentLabel();
  const slot = getAgentSlot();

  // Cleanup stale shared answers
  cleanupOldShared();

  // ===== STEP 0: Cek shared answer — mungkin agent lain sudah solve! =====
  const existing = readSharedAnswer(tournamentId, roundNum);
  if (existing && existing.solver !== agentLabel) {
    log.game(
      `[captcha] R${roundNum}: shared answer FOUND dari ${existing.solver}: ${JSON.stringify(existing.tiles)}`,
    );
    const r = await submitAttempt(tournamentId, roundNum, existing.tiles, 'shared');
    if (r.ok) return;
    // Kalau submit shared juga wrong (unlikely), lanjut solve sendiri
    log.warn(`[captcha] shared answer wrong, solving sendiri...`);
    if (r.cooldownSec) await sleep(r.cooldownSec * 1000 + 200);
  }

  // ===== STEP 1: Stagger — bukan semua agent solve bareng =====
  // Agent dengan slot ganjil → solve dulu (first-wave solver)
  // Agent dengan slot genap → tunggu 3-5 detik (second-wave, check shared dulu)
  const isFirstWave = slot % 2 === 1; // agent 01, 03, 05, 07, 09
  const jitterMs = isFirstWave
    ? Math.floor(Math.random() * 1000) // 0-1s (cepet)
    : 3000 + Math.floor(Math.random() * 2000); // 3-5s (tunggu)

  log.game(
    `[captcha] R${roundNum}: slot=${slot} wave=${isFirstWave ? 'FIRST' : 'SECOND'} jitter=${jitterMs}ms`,
  );
  await sleep(jitterMs);

  // Cek shared lagi setelah jitter (mungkin first-wave sudah solve)
  const existing2 = readSharedAnswer(tournamentId, roundNum);
  if (existing2 && existing2.solver !== agentLabel) {
    log.game(
      `[captcha] R${roundNum}: shared answer appeared from ${existing2.solver}: ${JSON.stringify(existing2.tiles)}`,
    );
    const r = await submitAttempt(tournamentId, roundNum, existing2.tiles, 'shared-post-jitter');
    if (r.ok) return;
    if (r.cooldownSec) await sleep(r.cooldownSec * 1000 + 200);
  }

  // ===== STEP 2: Solve sendiri dengan primary provider =====
  if (providers.length === 0) {
    log.warn(`[captcha] no vision provider configured - skip`);
    return;
  }

  const p1 = providers[0];
  let tiles1 = await trySolve(p1.provider, p1.apiKey, puzzle.grid_image_url, p1.label);

  // Kalau primary error → cek shared sekali lagi sebelum fallback
  if (!tiles1) {
    const shared3 = readSharedAnswer(tournamentId, roundNum);
    if (shared3) {
      log.game(`[captcha] primary failed, using shared answer: ${JSON.stringify(shared3.tiles)}`);
      const r = await submitAttempt(tournamentId, roundNum, shared3.tiles, 'shared-after-fail');
      if (r.ok) return;
    }
    // Fallback ke provider 2 untuk attempt 1
    if (providers.length > 1) {
      const p2 = providers[1];
      tiles1 = await trySolve(p2.provider, p2.apiKey, puzzle.grid_image_url, p2.label);
    }
    if (!tiles1) {
      log.err(`[captcha] all solvers failed - waiting for shared answer`);
      // Wait loop: tunggu shared answer dari agent lain (max 30 detik)
      const waitEnd = Date.now() + 30_000;
      while (Date.now() < waitEnd) {
        await sleep(2000);
        const shared = readSharedAnswer(tournamentId, roundNum);
        if (shared) {
          log.ok(`[captcha] got shared answer while waiting: ${JSON.stringify(shared.tiles)}`);
          await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-wait');
          return;
        }
      }
      log.err(`[captcha] no answer found after 30s wait - give up`);
      return;
    }
  }

  // ===== STEP 3: Submit attempt 1 =====
  const r1 = await submitAttempt(tournamentId, roundNum, tiles1, 'attempt1');
  if (r1.ok) {
    // CORRECT! Tulis ke shared file biar agent lain bisa pakai
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

  // ===== STEP 4: Wrong → cek shared + retry fallback =====
  // Tunggu cooldown
  const cd1 = (r1.cooldownSec || 5) * 1000;

  // Selama cooldown, poll shared answer setiap 1 detik
  const cdEnd = Date.now() + cd1;
  while (Date.now() < cdEnd) {
    await sleep(1000);
    const sharedMid = readSharedAnswer(tournamentId, roundNum);
    if (sharedMid) {
      log.game(
        `[captcha] shared answer appeared during cooldown from ${sharedMid.solver}`,
      );
      // Masih dalam cooldown? Tunggu sisa
      const remaining = cdEnd - Date.now();
      if (remaining > 0) await sleep(remaining + 100);
      const r = await submitAttempt(tournamentId, roundNum, sharedMid.tiles, 'shared-mid-cd');
      if (r.ok) return;
      break;
    }
  }

  // Cek shared sekali lagi
  const shared4 = readSharedAnswer(tournamentId, roundNum);
  if (shared4 && JSON.stringify(shared4.tiles) !== JSON.stringify(tiles1)) {
    const r = await submitAttempt(tournamentId, roundNum, shared4.tiles, 'shared-post-cd');
    if (r.ok) return;
  }

  // ===== STEP 5: Fallback solver (attempt 2) =====
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

  // ===== STEP 6: Final wait — tunggu shared answer dari agent lain =====
  log.game(`[captcha] both attempts failed, waiting shared answer (max 20s)...`);
  const finalWaitEnd = Date.now() + 20_000;
  while (Date.now() < finalWaitEnd) {
    await sleep(2000);
    const sharedFinal = readSharedAnswer(tournamentId, roundNum);
    if (sharedFinal && JSON.stringify(sharedFinal.tiles) !== JSON.stringify(tiles1)) {
      log.ok(`[captcha] final shared answer from ${sharedFinal.solver}: ${JSON.stringify(sharedFinal.tiles)}`);
      // Submit mungkin kena cooldown lagi — try anyway
      await submitAttempt(tournamentId, roundNum, sharedFinal.tiles, 'shared-final');
      return;
    }
  }

  log.warn(`[captcha] round ${roundNum} finished without correct answer`);
}
