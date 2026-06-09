// CAPTCHA Master strategy v2 - Multi-provider chain + smart retry.
//
// Aturan:
//   - 3x3 grid, pilih tile yang sesuai prompt (e.g. "select all trucks").
//   - Score = max(0, 600 - solve_seconds). Wrong = 5s cooldown.
//   - Image 600x700 PNG, prompt di header band.
//
// Strategy:
//   1. Stagger acak 0-2s (anti rate-limit kalau 10 agent main captcha bareng).
//   2. Solve dengan PROVIDER PRIMARY (env VISION_PROVIDER, default 'groq').
//      Kalau ada VISION_FALLBACK + VISION_FALLBACK_KEY → chain primary->fallback.
//   3. Submit hasil.
//   4. Kalau wrong → tunggu cooldown server (5s), retry dengan PROVIDER FALLBACK.
//      Total max 2 attempt per round (primary + fallback). Hindari boros cooldown.
//   5. Kalau gak ada vision sama sekali → skip submit (random hit ~0.2% gak worth).

import { log } from '../logger.js';
import { api } from '../api.js';
import { solveWithVision } from '../vision.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomTiles() {
  // Random subset 3-5 tiles dari 0-8
  const all = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const count = 3 + Math.floor(Math.random() * 3);
  const shuffled = all.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).sort((a, b) => a - b);
}

// Build chain providers dari env: primary + (optional) fallback
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
    log.warn(`[captcha] ${label} failed in ${dt}s: ${e.message}`);
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
      return { ok: false, res, cooldownSec: cdSec };
    }
    log.warn(`[captcha] unknown status (${attemptLabel})`, res);
    return { ok: false, res };
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
      log.warn(`[captcha] puzzle not loaded yet (${attemptLabel})`);
      return { ok: false, transient: true };
    }
    throw e;
  }
}

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
  if (providers.length === 0) {
    log.warn(`[captcha] no vision provider configured - skip submit`);
    return;
  }

  // Stagger acak biar 10 agent gak burst Groq bareng (RPM=30)
  const jitterMs = Math.floor(Math.random() * 2000);
  if (jitterMs > 100) {
    log.game(`[captcha] R${roundNum}: jitter ${jitterMs}ms`);
    await sleep(jitterMs);
  }

  log.game(
    `[captcha] R${roundNum}: chain=[${providers.map((p) => p.label).join(',')}] image=${puzzle.grid_image_url?.slice(0, 60)}...`,
  );

  // ATTEMPT 1: primary provider
  const p1 = providers[0];
  let tiles1 = await trySolve(p1.provider, p1.apiKey, puzzle.grid_image_url, p1.label);
  if (!tiles1) {
    // Primary error - kalau ada fallback solver, langsung pakai untuk attempt 1
    if (providers.length > 1) {
      const p2 = providers[1];
      tiles1 = await trySolve(p2.provider, p2.apiKey, puzzle.grid_image_url, p2.label);
    }
    if (!tiles1) {
      log.err(`[captcha] all providers failed - random fallback`);
      tiles1 = randomTiles();
    }
  }

  const r1 = await submitAttempt(tournamentId, roundNum, tiles1, `attempt1`);
  if (r1.ok) return;

  // Wrong / cooldown / transient. Decide retry?
  if (r1.transient) {
    // 503 - tunggu sebentar, retry sekali lagi dengan tiles yang sama
    await sleep(3000);
    const rRetry = await submitAttempt(
      tournamentId,
      roundNum,
      tiles1,
      'attempt1-retry',
    );
    if (rRetry.ok) return;
    return;
  }

  // ATTEMPT 2: kalau ada fallback provider, coba dengan provider beda
  if (providers.length > 1) {
    const p2 = providers[1];
    // Tunggu cooldown wrong
    const wait = (r1.cooldownSec || 5) * 1000 + 200;
    log.game(`[captcha] retry attempt2 dgn ${p2.label} setelah ${wait}ms`);
    await sleep(wait);

    const tiles2 = await trySolve(p2.provider, p2.apiKey, puzzle.grid_image_url, p2.label);
    if (tiles2 && JSON.stringify(tiles2) !== JSON.stringify(tiles1)) {
      const r2 = await submitAttempt(tournamentId, roundNum, tiles2, 'attempt2');
      if (r2.ok) return;
      log.warn(`[captcha] attempt2 also wrong - accept score 0`);
    } else if (tiles2) {
      log.warn(`[captcha] attempt2 same as attempt1 - skip`);
    } else {
      log.warn(`[captcha] attempt2 solver failed - skip`);
    }
  } else {
    log.warn(`[captcha] no fallback provider - accept score 0`);
  }
}
