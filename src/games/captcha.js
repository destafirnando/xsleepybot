// CAPTCHA Master strategy.
//
// Aturan:
//   - 3x3 grid, pilih tile yang sesuai prompt (e.g. "select all trucks").
//   - Score = max(0, 600 - solve_seconds). Wrong = 5s cooldown.
//   - Image 600x700 PNG, prompt di header band.
//
// Tanpa vision model:
//   - Best-effort: kirim 1 tebakan random (ada peluang ~0.2% cocok).
//   - Server akan auto-skip jadi random kalau kita gak submit.
//   - Kita submit early (tapi 1x saja) supaya 5s cooldown gak meledak.
//
// Dengan vision model (env VISION_PROVIDER):
//   - Download image, kirim ke vision API, parse response, submit.
//   - Mode: openai (gpt-4o), anthropic (claude), gemini.

import { log } from '../logger.js';
import { api } from '../api.js';
import { solveWithVision } from '../vision.js';

function randomTiles() {
  // Random subset 3-5 tiles dari 0-8
  const all = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const count = 3 + Math.floor(Math.random() * 3); // 3-5
  const shuffled = all.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).sort((a, b) => a - b);
}

export async function play({ tournamentId, roundNum }) {
  const pairing = await api.arena.pairing(tournamentId, roundNum);

  // Untuk captcha, puzzle ada di top-level pairing.puzzle (bukan di my_pairing)
  const puzzle = pairing?.puzzle || pairing?.my_pairing?.puzzle;
  if (!puzzle) {
    log.warn(`[captcha] R${roundNum}: no puzzle in pairing — server belum seed?`);
    return;
  }
  if (pairing?.my_pairing?.is_bye) {
    log.game(`[captcha] R${roundNum}: BYE - skip`);
    return;
  }

  const provider = (process.env.VISION_PROVIDER || 'none').toLowerCase();
  let selected;

  if (provider !== 'none' && process.env.VISION_API_KEY) {
    log.game(`[captcha] R${roundNum}: solving with ${provider}...`);
    try {
      selected = await solveWithVision({
        provider,
        apiKey: process.env.VISION_API_KEY,
        imageUrl: puzzle.grid_image_url,
        instructions: puzzle.instructions,
      });
      log.ok(`[captcha] vision proposed tiles=${JSON.stringify(selected)}`);
    } catch (e) {
      log.err(`[captcha] vision failed, fallback random: ${e.message}`);
      selected = randomTiles();
    }
  } else {
    log.warn(`[captcha] no vision provider — random fallback`);
    selected = randomTiles();
  }

  // Submit max 1 attempt (gak mau habiskan waktu di cooldown loop)
  try {
    const res = await api.arena.submitCaptcha(tournamentId, roundNum, selected);
    if (res?.status === 'correct') {
      log.ok(`[captcha] CORRECT! score=${res.score} time=${res.solve_seconds}s`);
    } else {
      log.warn(`[captcha] wrong attempt`, res);
    }
  } catch (e) {
    if (e.status === 409) {
      log.warn(`[captcha] already solved`);
    } else if (e.status === 429) {
      log.warn(`[captcha] cooldown`, e.data);
    } else if (e.status === 503) {
      log.warn(`[captcha] puzzle not loaded yet`);
    } else {
      throw e;
    }
  }
}
