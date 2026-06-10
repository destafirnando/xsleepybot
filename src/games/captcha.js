// CAPTCHA Master strategy v6 - Solver/Freerider Wave System.
//
// PROBLEM v5: 10 agent panggil Gemini bareng = quota 429 dalam 1-2 round.
// Plus: jawaban shared yang WRONG ke-cache dan agent lain submit ulang.
//
// FIX v6 - Wave-based architecture:
//
// SOLVER agents (slot 01, 02):
//   - Panggil Groq primary (cepat, gratis, jalan baik)
//   - Kalau Groq wrong/error: Gemini sebagai attempt-2 (rare)
//   - Kalau correct: tulis ke shared/captcha-XX.json
//   - Quota usage: ~5-10 Gemini call/round (well under 15 RPM)
//
// FREERIDER agents (slot 03-10):
//   - NEVER panggil vision API
//   - Polling shared file aggresif (250ms)
//   - Submit shared answer langsung kalau muncul
//   - Kalau wait 60s tidak ada shared = skip round (score 0)
//
// PLUS:
// - "wrong tiles" tracker: jangan submit jawaban yang udah confirmed wrong
// - Gemini 429 backoff: kalau quota hit, skip Gemini selama 60s
// - Atomic write shared file (renameSync)

import { log } from '../logger.js';
import { api } from '../api.js';
import { solveWithVision } from '../vision.js';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ====================================================================
// Konstanta
// ====================================================================
const SHARED_DIR = path.resolve(process.cwd(), '..', '..', 'shared');
const SOLVER_SLOTS = new Set([1, 2]); // hanya slot 1 & 2 yang solve

// Gemini 429 cooldown - shared antar agent via file
const GEMINI_COOLDOWN_FILE = path.join(SHARED_DIR, 'gemini-cooldown.txt');

// ====================================================================
// Shared answer file management
// ====================================================================
function sharedAnswerPath(tournamentId, roundNum) {
  return path.join(SHARED_DIR, `captcha-${tournamentId}-R${roundNum}.json`);
}

function wrongTilesPath(tournamentId, roundNum) {
  return path.join(SHARED_DIR, `captcha-${tournamentId}-R${roundNum}-wrong.json`);
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

function writeSharedAnswer(tournamentId, roundNum, tiles, solver) {
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    const file = sharedAnswerPath(tournamentId, roundNum);
    const tmp = `${file}.${process.pid}.tmp`;
    const data = { tiles, solver, timestamp: Date.now(), tournamentId, roundNum };
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    log.ok(`[captcha] CORRECT shared written: ${JSON.stringify(tiles)} by ${solver}`);
  } catch (e) {
    log.warn(`[captcha] failed write shared: ${e.message}`);
  }
}

// Track wrong tiles set untuk avoid resubmit
function readWrongTiles(tournamentId, roundNum) {
  try {
    const file = wrongTilesPath(tournamentId, roundNum);
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.wrong) ? data.wrong : [];
  } catch {
    return [];
  }
}

function appendWrongTiles(tournamentId, roundNum, tiles) {
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    const file = wrongTilesPath(tournamentId, roundNum);
    const existing = readWrongTiles(tournamentId, roundNum);
    const sig = JSON.stringify(tiles);
    if (existing.some((w) => JSON.stringify(w) === sig)) return;
    existing.push(tiles);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ wrong: existing, timestamp: Date.now() }));
    fs.renameSync(tmp, file);
  } catch { /* ignore */ }
}

function isKnownWrong(tiles, wrongList) {
  if (!Array.isArray(wrongList)) return false;
  const sig = JSON.stringify(tiles);
  return wrongList.some((w) => JSON.stringify(w) === sig);
}

// Gemini cooldown tracker
function isGeminiCooldown() {
  try {
    if (!fs.existsSync(GEMINI_COOLDOWN_FILE)) return false;
    const ts = parseInt(fs.readFileSync(GEMINI_COOLDOWN_FILE, 'utf8'), 10);
    if (isNaN(ts)) return false;
    return Date.now() < ts;
  } catch {
    return false;
  }
}

function setGeminiCooldown(seconds) {
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    const until = Date.now() + seconds * 1000;
    fs.writeFileSync(GEMINI_COOLDOWN_FILE, String(until));
    log.warn(`[captcha] Gemini cooldown set: ${seconds}s (quota exceeded)`);
  } catch { /* ignore */ }
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
// Provider chain - solver only
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

async function trySolve(provider, apiKey, imageUrl, label) {
  const t0 = Date.now();
  try {
    const tiles = await solveWithVision({ provider, apiKey, imageUrl });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log.ok(`[captcha] ${label} solved in ${dt}s -> ${JSON.stringify(tiles)}`);
    return tiles;
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = e.message || String(e);
    // Detect 429 quota exceeded for Gemini
    if (label.includes('gemini') && /429|quota|exceeded/i.test(msg)) {
      setGeminiCooldown(60);
    }
    log.warn(`[captcha] ${label} failed in ${dt}s: ${msg.slice(0, 100)}`);
    return null;
  }
}

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
// Slot detection
// ====================================================================
function getAgentSlot() {
  const cwd = process.cwd();
  const match = cwd.match(/agents[\/\\](\d+)$/);
  return match ? parseInt(match[1], 10) : 1;
}

function getAgentLabel() {
  return `agent-${String(getAgentSlot()).padStart(2, '0')}`;
}

// ====================================================================
// FREERIDER FLOW: cuma baca shared, JANGAN call vision API
// ====================================================================
async function playFreerider(tournamentId, roundNum, agentLabel) {
  const tStart = Date.now();
  log.game(`[captcha] R${roundNum} FREERIDER mode (slot ${getAgentSlot()})`);

  // Cek shared answer di awal
  const preCheck = readSharedAnswer(tournamentId, roundNum);
  if (preCheck && preCheck.solver !== agentLabel) {
    log.game(`[captcha] R${roundNum}: pre-check shared from ${preCheck.solver}`);
    const r = await submitAttempt(tournamentId, roundNum, preCheck.tiles, 'shared-instant');
    if (r.ok) return;
  }

  // Polling 250ms selama max 90 detik
  const deadline = tStart + 90_000;
  let attempts = 0;
  let lastSubmitted = null;

  while (Date.now() < deadline) {
    await sleep(250);

    const shared = readSharedAnswer(tournamentId, roundNum);
    if (!shared || shared.solver === agentLabel) continue;

    const sig = JSON.stringify(shared.tiles);
    if (lastSubmitted === sig) continue; // jangan resubmit jawaban sama

    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
    log.game(`[captcha] R${roundNum} freerider t+${elapsed}s shared from ${shared.solver}`);
    lastSubmitted = sig;
    attempts++;

    const r = await submitAttempt(tournamentId, roundNum, shared.tiles, `freeride-${attempts}`);
    if (r.ok) {
      log.ok(`[captcha] R${roundNum} FREERIDER WIN at t+${elapsed}s (attempts=${attempts})`);
      return;
    }
    if (r.cooldownSec) {
      await sleep(r.cooldownSec * 1000 + 200);
    }
  }

  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  log.warn(`[captcha] R${roundNum} freerider TIMEOUT t+${elapsed}s (no correct shared)`);
}

// ====================================================================
// SOLVER FLOW: solve dengan Groq, fallback Gemini, tulis shared
// ====================================================================
async function playSolver(tournamentId, roundNum, agentLabel) {
  const tStart = Date.now();
  const elapsed = () => ((Date.now() - tStart) / 1000).toFixed(1);

  log.game(`[captcha] R${roundNum} SOLVER mode (slot ${getAgentSlot()})`);

  // Pre-check shared - solver juga benefit kalau slot lain sudah solve
  const preShared = readSharedAnswer(tournamentId, roundNum);
  if (preShared && preShared.solver !== agentLabel) {
    log.game(`[captcha] R${roundNum} solver: pre-check shared from ${preShared.solver}`);
    const r = await submitAttempt(tournamentId, roundNum, preShared.tiles, 'shared-precheck');
    if (r.ok) return;
  }

  // Fetch puzzle dengan retry adaptive
  let pairing = null;
  let puzzle = null;
  const RETRY_DELAYS = [1000, 1500, 2500, 3500, 5000];

  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    try {
      pairing = await api.arena.pairing(tournamentId, roundNum);
    } catch (e) {
      log.warn(`[captcha] pairing fetch err try ${i + 1}: ${e.message}`);
    }

    if (pairing?.my_pairing?.is_bye || pairing?.is_bye) {
      log.game(`[captcha] R${roundNum} BYE`);
      return;
    }

    puzzle = pairing?.puzzle || pairing?.my_pairing?.puzzle;
    if (puzzle) {
      log.game(`[captcha] R${roundNum} puzzle ready t+${elapsed()}s`);
      break;
    }

    // Saat retry wait, cek shared (mungkin solver lain udah solve)
    const waitEnd = Date.now() + RETRY_DELAYS[i];
    while (Date.now() < waitEnd) {
      const shared = readSharedAnswer(tournamentId, roundNum);
      if (shared && shared.solver !== agentLabel) {
        log.game(`[captcha] R${roundNum} solver: shared during retry from ${shared.solver}`);
        const r = await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-retry');
        if (r.ok) return;
      }
      await sleep(300);
    }

    log.warn(`[captcha] R${roundNum} no puzzle try ${i + 1}/${RETRY_DELAYS.length}`);
  }

  if (!puzzle) {
    // Wait long polling shared (sambil agent solver lain solve)
    log.warn(`[captcha] R${roundNum} solver: puzzle EMPTY, polling shared 30s`);
    const waitEnd = Date.now() + 30_000;
    while (Date.now() < waitEnd) {
      const shared = readSharedAnswer(tournamentId, roundNum);
      if (shared && shared.solver !== agentLabel) {
        const r = await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-late');
        if (r.ok) return;
      }
      await sleep(500);
    }
    log.err(`[captcha] R${roundNum} solver: GIVE UP no puzzle`);
    return;
  }

  // Provider chain
  const providers = buildProviders();
  if (providers.length === 0) {
    log.err(`[captcha] no vision provider configured`);
    return;
  }

  const wrongList = readWrongTiles(tournamentId, roundNum);

  // ATTEMPT 1: Primary (Groq biasanya)
  const p1 = providers[0];
  log.game(`[captcha] R${roundNum} solver t+${elapsed()}s solving with ${p1.label}...`);

  let tiles1 = await trySolve(p1.provider, p1.apiKey, puzzle.grid_image_url, p1.label);

  if (tiles1 && isKnownWrong(tiles1, wrongList)) {
    log.warn(`[captcha] ${p1.label} answer matches known WRONG, skip submit`);
    tiles1 = null;
  }

  if (tiles1) {
    const r1 = await submitAttempt(tournamentId, roundNum, tiles1, 'attempt1');
    if (r1.ok) {
      writeSharedAnswer(tournamentId, roundNum, tiles1, agentLabel);
      log.ok(`[captcha] R${roundNum} SOLVER WIN attempt1 at t+${elapsed()}s`);
      return;
    }
    // Wrong - record as wrong + tunggu cooldown sambil cek shared
    appendWrongTiles(tournamentId, roundNum, tiles1);
    if (r1.cooldownSec) {
      const cdEnd = Date.now() + r1.cooldownSec * 1000;
      while (Date.now() < cdEnd) {
        const shared = readSharedAnswer(tournamentId, roundNum);
        if (shared && shared.solver !== agentLabel &&
            JSON.stringify(shared.tiles) !== JSON.stringify(tiles1)) {
          // Tunggu cooldown selesai dulu
          const remaining = cdEnd - Date.now();
          if (remaining > 0) await sleep(remaining + 100);
          const r = await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-mid-cd');
          if (r.ok) return;
          break;
        }
        await sleep(250);
      }
    }
  }

  // ATTEMPT 2: Fallback (Gemini biasanya) - HANYA kalau cooldown belum aktif
  if (providers.length > 1) {
    const p2 = providers[1];
    if (p2.label.includes('gemini') && isGeminiCooldown()) {
      log.warn(`[captcha] Gemini in cooldown, skip attempt2`);
    } else {
      log.game(`[captcha] R${roundNum} t+${elapsed()}s try fallback ${p2.label}...`);
      let tiles2 = await trySolve(p2.provider, p2.apiKey, puzzle.grid_image_url, p2.label);

      if (tiles2 && isKnownWrong(tiles2, [...wrongList, tiles1].filter(Boolean))) {
        log.warn(`[captcha] ${p2.label} answer matches WRONG, skip`);
        tiles2 = null;
      }

      if (tiles2 && JSON.stringify(tiles2) !== JSON.stringify(tiles1)) {
        const r2 = await submitAttempt(tournamentId, roundNum, tiles2, 'attempt2');
        if (r2.ok) {
          writeSharedAnswer(tournamentId, roundNum, tiles2, agentLabel);
          log.ok(`[captcha] R${roundNum} SOLVER WIN attempt2 at t+${elapsed()}s`);
          return;
        }
        appendWrongTiles(tournamentId, roundNum, tiles2);
      }
    }
  }

  // FINAL: Wait for shared from other solver
  log.game(`[captcha] R${roundNum} solver: both attempts done, wait shared 60s`);
  const finalEnd = Date.now() + 60_000;
  while (Date.now() < finalEnd) {
    const shared = readSharedAnswer(tournamentId, roundNum);
    if (shared && shared.solver !== agentLabel) {
      const r = await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-final');
      if (r.ok) {
        log.ok(`[captcha] R${roundNum} solver WIN via shared at t+${elapsed()}s`);
        return;
      }
      if (r.cooldownSec) {
        await sleep(r.cooldownSec * 1000 + 200);
        const rR = await submitAttempt(tournamentId, roundNum, shared.tiles, 'shared-final-r');
        if (rR.ok) return;
      }
    }
    await sleep(500);
  }

  log.warn(`[captcha] R${roundNum} solver END t+${elapsed()}s no correct answer`);
}

// ====================================================================
// MAIN PLAY - dispatch by slot
// ====================================================================
export async function play({ tournamentId, roundNum }) {
  const slot = getAgentSlot();
  const agentLabel = getAgentLabel();

  cleanupOldShared();

  // Cek bye dulu (untuk semua agent)
  let pairing;
  try {
    pairing = await api.arena.pairing(tournamentId, roundNum);
  } catch {
    pairing = null;
  }

  if (pairing?.my_pairing?.is_bye || pairing?.is_bye) {
    log.game(`[captcha] R${roundNum}: BYE - skip`);
    return;
  }

  // Dispatch
  if (SOLVER_SLOTS.has(slot)) {
    await playSolver(tournamentId, roundNum, agentLabel);
  } else {
    await playFreerider(tournamentId, roundNum, agentLabel);
  }
}
