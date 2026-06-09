// Crash Pilot strategy.
//
// Aturan:
//   - Pilih target 1.01x - 10.0x.
//   - Crash point ~ shifted_exponential(lambda=0.55, shift=1.01).
//   - Jika target ≤ crash → cash out, score = target. Else → 0.
//   - EV-optimal ≈ 1.82x (P=58% cash, EV≈1.06).
//
// Strategi:
//   - Bias ke EV-optimal 1.82x dengan jitter ±0.3.
//   - Sesekali (20%) pasang aggressive 2.5-4.0x untuk variance.
//   - Sesekali (10%) pasang ultra-safe 1.20-1.40x kalau lagi leading
//     (kita gak tau ranking dari endpoint ini, jadi mostly default).

import { log } from '../logger.js';
import { api } from '../api.js';

const MESSAGES_SAFE = [
  'cash early',
  'taking it home',
  'low and locked',
  'no greed',
];
const MESSAGES_MID = [
  'optimal mode',
  'standard play',
  'on target',
  'EV check',
];
const MESSAGES_AGGRO = [
  'going for it',
  'leapfrog time',
  'high target',
  'all in',
];

function pickMessage(target) {
  const pool =
    target <= 1.5 ? MESSAGES_SAFE : target <= 2.5 ? MESSAGES_MID : MESSAGES_AGGRO;
  return pool[Math.floor(Math.random() * pool.length)];
}

function jitter(center, spread) {
  return center + (Math.random() * 2 - 1) * spread;
}

function decide() {
  const r = Math.random();
  let target;
  if (r < 0.1) {
    // 10% ultra safe
    target = jitter(1.3, 0.1);
  } else if (r < 0.7) {
    // 60% EV-optimal area (1.82 ± 0.3)
    target = jitter(1.82, 0.3);
  } else if (r < 0.9) {
    // 20% medium aggro
    target = jitter(2.5, 0.5);
  } else {
    // 10% high risk
    target = jitter(4.0, 1.0);
  }
  // Clamp & round to 2 decimals
  target = Math.max(1.01, Math.min(10.0, target));
  return Math.round(target * 100) / 100;
}

export async function play({ tournamentId, roundNum }) {
  // pairing tetap dipanggil supaya konsisten + dapat info BYE
  let pairing;
  try {
    pairing = await api.arena.pairing(tournamentId, roundNum);
  } catch (e) {
    log.warn(`[crash_pilot] pairing fetch fail: ${e.message}`);
  }

  if (pairing?.my_pairing?.is_bye) {
    log.game(`[crash_pilot] R${roundNum}: BYE - skip submit`);
    return;
  }

  const target = decide();
  const message = pickMessage(target);

  log.game(`[crash_pilot] R${roundNum}: target=${target}x`, { msg: message });

  try {
    const res = await api.arena.submit(
      tournamentId,
      roundNum,
      target,
      message,
    );
    log.ok(`[crash_pilot] submitted target=${target}x`, res);
  } catch (e) {
    if (e.status === 409) {
      log.warn(`[crash_pilot] already submitted`);
    } else {
      throw e;
    }
  }
}
