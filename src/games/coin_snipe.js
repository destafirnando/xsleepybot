// Coin Snipe strategy.
//
// Aturan singkat:
//   - Pilih 1-10. Lower wins, score = floor((my+opp)/2). Higher = 0.
//   - Sama-sama angka → keduanya 0.
//   - 10 sweep 1-5 (score=10). Tapi kalah ke 6,7,8 (lower-wins) dan ke 9 (regicide).
//   - NO-REPEAT: tidak boleh sama dengan pick round sebelumnya.
//
// Strategi default kita:
//   - Round 1: random dari [3,4,5,6,7] (sweet spot — bukan extreme).
//   - Round >1:
//     * Kalau ada opponent history, hitung distribusi & counter-pick:
//       - Kalau opponent sering pick low (≤5), kita pick 6-9 (atau 10 kalau berani).
//       - Kalau opponent sering pick high, kita pick low (2-4).
//     * Tambahkan jitter random supaya gak predictable.
//   - Hindari forbidden_number dan pick yang sama dengan round terakhir kita.

import { state } from '../state.js';
import { log } from '../logger.js';
import { api } from '../api.js';

const MESSAGES_LOW = [
  'going small this time',
  'safe play',
  'keep it tight',
  'not feeling brave',
  'low and steady',
];
const MESSAGES_MID = [
  'middle path',
  'balanced bet',
  'calling bluffs',
  'reading the table',
  'medium heat',
];
const MESSAGES_HIGH = [
  'feeling lucky',
  'pushing chips',
  'all gas',
  'risking it',
  'sweep mode',
];

function pickMessage(num) {
  const pool =
    num <= 4 ? MESSAGES_LOW : num <= 7 ? MESSAGES_MID : MESSAGES_HIGH;
  return pool[Math.floor(Math.random() * pool.length)];
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function decide(pairing, lastPick) {
  // Forbidden = pick kita di round sebelumnya (server akan reject kalau sama)
  const forbidden = new Set();
  if (lastPick != null) forbidden.add(lastPick);
  // Server kadang juga kasih hint via my_pairing.forbidden_number
  if (pairing?.forbidden_number != null) forbidden.add(pairing.forbidden_number);

  const opp = pairing?.opponent || {};
  const priorPicks = opp.prior_submissions || []; // di tournament ini
  const careerPicks = opp.career_submissions || []; // 100 terakhir career
  const careerDist = opp.career_pick_distribution || null;

  // Hitung kecenderungan opponent
  const sample = [...priorPicks, ...careerPicks]
    .map((s) => (typeof s === 'object' ? s.submission ?? s.pick : s))
    .filter((n) => Number.isInteger(n));

  let candidates;
  if (sample.length >= 3) {
    const avg = sample.reduce((a, b) => a + b, 0) / sample.length;
    if (avg <= 4.5) {
      // Opponent biased rendah → kita bisa pick mid-high (6-8)
      candidates = [6, 7, 8];
    } else if (avg >= 6.5) {
      // Opponent biased tinggi → kita pick rendah (2-4) untuk lower-wins
      candidates = [2, 3, 4];
    } else {
      // Opponent random/mid → main aman di sweet spot
      candidates = [3, 4, 5, 6, 7];
    }
  } else if (careerDist) {
    // Pakai distribusi global kalau tersedia
    const top = Object.entries(careerDist)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => parseInt(k, 10))
      .filter(Number.isInteger);
    if (top.length) {
      const mostLiked = top[0];
      // Hindari ngeklik nomor yang dia paling sering pick (kemungkinan tabrakan = 0)
      candidates = [3, 4, 5, 6, 7].filter((n) => n !== mostLiked);
    } else {
      candidates = [3, 4, 5, 6, 7];
    }
  } else {
    // No history → sweet spot
    candidates = [3, 4, 5, 6, 7];
  }

  // Filter forbidden
  candidates = candidates.filter((n) => !forbidden.has(n));
  if (candidates.length === 0) {
    // Fallback: any number 1-9 yang tidak forbidden
    candidates = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((n) => !forbidden.has(n));
  }

  return randomFrom(candidates);
}

export async function play({ tournamentId, roundNum }) {
  const pairing = await api.arena.pairing(tournamentId, roundNum);

  if (pairing?.my_pairing?.is_bye) {
    log.game(`[coin_snipe] R${roundNum}: BYE - skip submit`);
    return;
  }

  const lastPick = state.getLastPick(tournamentId, roundNum);
  const opp = pairing?.my_pairing?.opponent;
  const pick = decide(pairing.my_pairing || pairing, lastPick);
  const message = pickMessage(pick);

  log.game(
    `[coin_snipe] R${roundNum}: pick=${pick} vs ${opp?.name || opp?.id || '?'}`,
    { last: lastPick, msg: message },
  );

  try {
    const res = await api.arena.submit(tournamentId, roundNum, pick, message);
    state.recordPick(tournamentId, roundNum, pick);
    log.ok(`[coin_snipe] submitted pick=${pick}`, res);
  } catch (e) {
    if (e.status === 400 && /no_repeat/i.test(JSON.stringify(e.data))) {
      // Server reject karena sama dengan last → coba angka lain
      const fallback = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(
        (n) => n !== pick && n !== lastPick,
      );
      const retry = randomFrom(fallback);
      log.warn(`[coin_snipe] no_repeat, retry pick=${retry}`);
      const res = await api.arena.submit(
        tournamentId,
        roundNum,
        retry,
        pickMessage(retry),
      );
      state.recordPick(tournamentId, roundNum, retry);
      log.ok(`[coin_snipe] retry submitted`, res);
    } else if (e.status === 409) {
      log.warn(`[coin_snipe] already submitted, skip`);
    } else {
      throw e;
    }
  }
}
