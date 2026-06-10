// CAPTCHA Master strategy v7 - Multi-Solver Voting + Auto-Recovery.
//
// PROBLEM v6: Cuma 2 solver, kalau Groq + Gemini sama-sama wrong = 0 score.
// Log production: 0/10 agent dapat correct, 8 freerider TIMEOUT.
//
// FIX v7 - "4-Solver System":
//
// SOLVER (slot 1-4) - 4 agent paralel solve dengan model BERBEDA:
//   - Slot 1: Groq llama-4-scout (fast)
//   - Slot 2: Groq llama-4-maverick (more accurate)
//   - Slot 3: Groq scout + prompt variation
//   - Slot 4: Gemini 2.5-flash-lite
//
// FREERIDER (slot 5-10) - poll shared file 250ms, no API calls.
//
// VOTING:
//   - Solver yang dapat correct -> tulis shared
//   - Solver yang lihat shared dari peer -> submit langsung (skip own attempt)
//   - Wrong tiles tracker: agent yang submit wrong record di shared/wrong-tiles.json
//   - Solver lain skip jawaban yang udah confirmed wrong
//
// PROBABILITAS SUCCESS:
//   - Per-model accuracy ~70-85%
//   - 4 independent solver: 1 - 0.25^4 = 99.6% min 1 correct
//   - Even 2 model wrong, 2 yang lain bisa cover

import { log } from '../logger.js';
import { api } from '../api.js';
import { solveWithVision, PROMPT_DETAILED } from '../vision.js';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHARED_DIR = path.resolve(process.cwd(), '..', '..', 'shared');
const SOLVER_SLOTS = new Set([1, 2, 3, 4]); // 4 solver, sisanya freerider

// Solver-specific config: tiap slot pakai variation berbeda untuk DIVERSITY.
// Kunci: kombinasi (provider, temperature, prompt) yang berbeda agar model
// kasih jawaban INDEPENDENT - bukan deterministik sama semua.
const SOLVER_CONFIG = {
  1: {
    provider: 'groq',
    label: 'groq-default',
    opts: { temperature: 0 },
  },
  2: {
    provider: 'groq',
    label: 'groq-temp05',
    opts: { temperature: 0.5 },
  },
  3: {
    provider: 'groq',
    label: 'groq-detailed',
    opts: { temperature: 0, prompt: PROMPT_DETAILED },
  },
  4: {
    provider: 'gemini',
    label: 'gemini-25lite',
    opts: { temperature: 0 },
  },
};

const GEMINI_COOLDOWN_FILE = path.join(SHARED_DIR, 'gemini-cooldown.txt');

// ====================================================================
// File helpers
// ====================================================================
function sharedAnswerPath(t, r) {
  return path.join(SHARED_DIR, `captcha-${t}-R${r}.json`);
}

function wrongTilesPath(t, r) {
  return path.join(SHARED_DIR, `captcha-${t}-R${r}-wrong.json`);
}

function readSharedAnswer(t, r) {
  try {
    const f = sharedAnswerPath(t, r);
    if (!fs.existsSync(f)) return null;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(d.tiles) || d.tiles.length === 0) return null;
    if (Date.now() - (d.timestamp || 0) > 10 * 60 * 1000) return null;
    return d;
  } catch { return null; }
}

function writeSharedAnswer(t, r, tiles, solver) {
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    const f = sharedAnswerPath(t, r);
    const tmp = `${f}.${process.pid}.tmp`;
    const d = { tiles, solver, timestamp: Date.now(), tournamentId: t, roundNum: r };
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, f);
    log.ok(`[captcha] CORRECT shared written: ${JSON.stringify(tiles)} by ${solver}`);
  } catch (e) {
    log.warn(`[captcha] failed write shared: ${e.message}`);
  }
}

function readWrongTiles(t, r) {
  try {
    const f = wrongTilesPath(t, r);
    if (!fs.existsSync(f)) return [];
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(d.wrong) ? d.wrong : [];
  } catch { return []; }
}

function appendWrongTiles(t, r, tiles) {
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    const f = wrongTilesPath(t, r);
    const existing = readWrongTiles(t, r);
    const sig = JSON.stringify(tiles);
    if (existing.some((w) => JSON.stringify(w) === sig)) return;
    existing.push(tiles);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ wrong: existing, timestamp: Date.now() }));
    fs.renameSync(tmp, f);
  } catch { /* ignore */ }
}

function isKnownWrong(tiles, wrongList) {
  if (!Array.isArray(wrongList)) return false;
  const sig = JSON.stringify(tiles);
  return wrongList.some((w) => JSON.stringify(w) === sig);
}

function isGeminiCooldown() {
  try {
    if (!fs.existsSync(GEMINI_COOLDOWN_FILE)) return false;
    const ts = parseInt(fs.readFileSync(GEMINI_COOLDOWN_FILE, 'utf8'), 10);
    return !isNaN(ts) && Date.now() < ts;
  } catch { return false; }
}

function setGeminiCooldown(seconds) {
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
    fs.writeFileSync(GEMINI_COOLDOWN_FILE, String(Date.now() + seconds * 1000));
    log.warn(`[captcha] Gemini cooldown ${seconds}s`);
  } catch { /* ignore */ }
}

function cleanupOldShared() {
  try {
    if (!fs.existsSync(SHARED_DIR)) return;
    for (const f of fs.readdirSync(SHARED_DIR)) {
      if (!f.startsWith('captcha-')) continue;
      const full = path.join(SHARED_DIR, f);
      try {
        const stat = fs.statSync(full);
        if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(full);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ====================================================================
// Slot helpers
// ====================================================================
function getAgentSlot() {
  const cwd = process.cwd();
  const m = cwd.match(/agents[\/\\](\d+)$/);
  return m ? parseInt(m[1], 10) : 1;
}

function getAgentLabel() {
  return `agent-${String(getAgentSlot()).padStart(2, '0')}`;
}

// ====================================================================
// Solver helpers
// ====================================================================
async function trySolveWithModel(provider, apiKey, imageUrl, label, opts) {
  const t0 = Date.now();
  try {
    const tiles = await solveWithVision({
      provider, apiKey, imageUrl, opts: opts || {},
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log.ok(`[captcha] ${label} solved in ${dt}s -> ${JSON.stringify(tiles)}`);
    return tiles;
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = e.message || String(e);
    if (label.includes('gemini') && /429|quota|exceeded/i.test(msg)) {
      setGeminiCooldown(60);
    }
    log.warn(`[captcha] ${label} failed in ${dt}s: ${msg.slice(0, 100)}`);
    return null;
  }
}

async function submitAttempt(t, r, tiles, label) {
  try {
    const res = await api.arena.submitCaptcha(t, r, tiles);
    if (res?.status === 'correct') {
      log.ok(`[captcha] CORRECT (${label}) score=${res.score} solve=${res.solve_seconds}s`);
      return { ok: true, res };
    }
    if (res?.status === 'wrong') {
      const cd = res.cooldown_seconds || 5;
      log.warn(`[captcha] WRONG (${label}) cd=${cd}s`);
      return { ok: false, cooldownSec: cd };
    }
    return { ok: false };
  } catch (e) {
    if (e.status === 409) return { ok: true, alreadySolved: true };
    if (e.status === 429) {
      const cd = e.data?.cooldown_remaining_seconds || 5;
      return { ok: false, cooldownSec: cd };
    }
    if (e.status === 503) return { ok: false, transient: true };
    log.err(`[captcha] submit error (${label}): ${e.message}`);
    return { ok: false };
  }
}

// ====================================================================
// FREERIDER: poll shared file aggressively
// ====================================================================
async function playFreerider(tournamentId, roundNum, agentLabel) {
  const tStart = Date.now();
  const slot = getAgentSlot();
  log.game(`[captcha] R${roundNum} FREERIDER mode (slot ${slot})`);

  const pre = readSharedAnswer(tournamentId, roundNum);
  if (pre && pre.solver !== agentLabel) {
    log.game(`[captcha] R${roundNum}: pre-check shared from ${pre.solver}`);
    const r = await submitAttempt(tournamentId, roundNum, pre.tiles, 'shared-instant');
    if (r.ok) return;
  }

  const deadline = tStart + 90_000;
  let lastSubmitted = null;
  let attempts = 0;

  while (Date.now() < deadline) {
    await sleep(250);
    const shared = readSharedAnswer(tournamentId, roundNum);
    if (!shared || shared.solver === agentLabel) continue;
    const sig = JSON.stringify(shared.tiles);
    if (lastSubmitted === sig) continue;

    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
    log.game(`[captcha] R${roundNum} freerider t+${elapsed}s shared from ${shared.solver}`);
    lastSubmitted = sig;
    attempts++;

    const r = await submitAttempt(tournamentId, roundNum, shared.tiles, `freeride-${attempts}`);
    if (r.ok) {
      log.ok(`[captcha] R${roundNum} FREERIDER WIN at t+${elapsed}s`);
      return;
    }
    if (r.cooldownSec) await sleep(r.cooldownSec * 1000 + 200);
  }

  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  log.warn(`[captcha] R${roundNum} freerider TIMEOUT t+${elapsed}s`);
}

// ====================================================================
// SOLVER: solve with assigned model
// ====================================================================
async function playSolver(tournamentId, roundNum, agentLabel) {
  const tStart = Date.now();
  const elapsed = () => ((Date.now() - tStart) / 1000).toFixed(1);
  const slot = getAgentSlot();
  const cfg = SOLVER_CONFIG[slot];

  log.game(`[captcha] R${roundNum} SOLVER mode (slot ${slot}, model=${cfg.label})`);

  // Skip Gemini kalau cooldown aktif
  if (cfg.provider === 'gemini' && isGeminiCooldown()) {
    log.warn(`[captcha] Gemini cooldown active, fallback to FREERIDER`);
    return playFreerider(tournamentId, roundNum, agentLabel);
  }

  // Pre-check shared
  const pre = readSharedAnswer(tournamentId, roundNum);
  if (pre && pre.solver !== agentLabel) {
    log.game(`[captcha] R${roundNum} solver pre-check shared from ${pre.solver}`);
    const r = await submitAttempt(tournamentId, roundNum, pre.tiles, 'shared-precheck');
    if (r.ok) return;
  }

  // Determine API key based on provider
  const apiKey = cfg.provider === 'gemini'
    ? (process.env.VISION_FALLBACK_KEY || process.env.VISION_API_KEY)
    : process.env.VISION_API_KEY;

  if (!apiKey) {
    log.err(`[captcha] no API key for provider ${cfg.provider}, fallback freerider`);
    return playFreerider(tournamentId, roundNum, agentLabel);
  }

  // Fetch puzzle
  let pairing = null;
  let puzzle = null;
  const RETRY_DELAYS = [1000, 1500, 2500, 3500, 5000];

  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    try {
      pairing = await api.arena.pairing(tournamentId, roundNum);
    } catch (e) {
      log.warn(`[captcha] pairing err try ${i+1}: ${e.message}`);
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

    const waitEnd = Date.now() + RETRY_DELAYS[i];
    while (Date.now() < waitEnd) {
      const s = readSharedAnswer(tournamentId, roundNum);
      if (s && s.solver !== agentLabel) {
        const r = await submitAttempt(tournamentId, roundNum, s.tiles, 'shared-retry');
        if (r.ok) return;
      }
      await sleep(300);
    }
    log.warn(`[captcha] R${roundNum} no puzzle try ${i+1}/${RETRY_DELAYS.length}`);
  }

  if (!puzzle) {
    log.warn(`[captcha] R${roundNum} solver: puzzle EMPTY, fallback freerider`);
    return playFreerider(tournamentId, roundNum, agentLabel);
  }

  // Wave 1: solve dengan assigned model
  const wrongList = readWrongTiles(tournamentId, roundNum);
  log.game(`[captcha] R${roundNum} t+${elapsed()}s solving with ${cfg.label}...`);

  let tiles = await trySolveWithModel(
    cfg.provider, apiKey, puzzle.grid_image_url, cfg.label, cfg.opts,
  );

  if (tiles && isKnownWrong(tiles, wrongList)) {
    log.warn(`[captcha] ${cfg.label} answer matches known WRONG, skip`);
    tiles = null;
  }

  if (tiles) {
    const r1 = await submitAttempt(tournamentId, roundNum, tiles, 'attempt1');
    if (r1.ok) {
      writeSharedAnswer(tournamentId, roundNum, tiles, agentLabel);
      log.ok(`[captcha] R${roundNum} SOLVER WIN at t+${elapsed()}s`);
      return;
    }
    appendWrongTiles(tournamentId, roundNum, tiles);

    // Tunggu cooldown sambil cek shared dari solver lain
    if (r1.cooldownSec) {
      const cdEnd = Date.now() + r1.cooldownSec * 1000;
      while (Date.now() < cdEnd) {
        const s = readSharedAnswer(tournamentId, roundNum);
        if (s && s.solver !== agentLabel &&
            JSON.stringify(s.tiles) !== JSON.stringify(tiles)) {
          const remaining = cdEnd - Date.now();
          if (remaining > 0) await sleep(remaining + 100);
          const r = await submitAttempt(tournamentId, roundNum, s.tiles, 'shared-mid-cd');
          if (r.ok) return;
          break;
        }
        await sleep(250);
      }
    }
  }

  // Wave 2: kalau attempt 1 wrong, coba shared dari solver lain
  log.game(`[captcha] R${roundNum} solver: wave-1 done, wait shared 60s`);
  const finalEnd = Date.now() + 60_000;
  let lastSeen = tiles ? JSON.stringify(tiles) : null;

  while (Date.now() < finalEnd) {
    const s = readSharedAnswer(tournamentId, roundNum);
    if (s && s.solver !== agentLabel) {
      const sig = JSON.stringify(s.tiles);
      if (sig !== lastSeen) {
        lastSeen = sig;
        const r = await submitAttempt(tournamentId, roundNum, s.tiles, 'shared-final');
        if (r.ok) {
          log.ok(`[captcha] R${roundNum} solver WIN via shared at t+${elapsed()}s`);
          return;
        }
        if (r.cooldownSec) await sleep(r.cooldownSec * 1000 + 200);
      }
    }
    await sleep(500);
  }

  log.warn(`[captcha] R${roundNum} solver END t+${elapsed()}s no correct`);
}

// ====================================================================
// MAIN PLAY
// ====================================================================
export async function play({ tournamentId, roundNum }) {
  const slot = getAgentSlot();
  const agentLabel = getAgentLabel();

  cleanupOldShared();

  // Quick BYE check
  let pairing = null;
  try {
    pairing = await api.arena.pairing(tournamentId, roundNum);
  } catch { /* ignore */ }
  if (pairing?.my_pairing?.is_bye || pairing?.is_bye) {
    log.game(`[captcha] R${roundNum}: BYE - skip`);
    return;
  }

  if (SOLVER_SLOTS.has(slot)) {
    await playSolver(tournamentId, roundNum, agentLabel);
  } else {
    await playFreerider(tournamentId, roundNum, agentLabel);
  }
}
