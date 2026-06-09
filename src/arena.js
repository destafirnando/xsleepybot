// Orchestrator Arena.
//
// Loop:
//   1. Cek tournament 'upcoming' (queue terbuka). Kalau ada & belum join,
//      cek apakah game-nya termasuk ENABLED_GAMES → join.
//   2. Kalau status sudah 'live': loop tiap round
//      a. Tunggu round muncul (current_round bertambah)
//      b. Cek game type → dispatch ke handler yang sesuai
//      c. Tunggu round selesai
//   3. Kalau 'resolved': cleanup state, balik ke step 1.

import { api } from './api.js';
import { state } from './state.js';
import { log } from './logger.js';

import * as coin_snipe from './games/coin_snipe.js';
import * as crash_pilot from './games/crash_pilot.js';
import * as captcha from './games/captcha.js';
import * as maze from './games/maze.js';

const HANDLERS = { coin_snipe, crash_pilot, captcha, maze };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enabledGames() {
  const raw = process.env.ENABLED_GAMES || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function tryJoinUpcoming() {
  let upcoming;
  try {
    upcoming = await api.arena.upcoming();
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }

  if (!upcoming?.id) return null;

  const gameKey = upcoming.game?.key || upcoming.game_key;
  const enabled = enabledGames();
  if (enabled.size && !enabled.has(gameKey)) {
    log.info(`Upcoming game=${gameKey} tidak di ENABLED_GAMES, skip`);
    state.set('lastSkippedTournament', upcoming.id);
    return null;
  }

  // Skip kalau sudah pernah join (dilihat dari state)
  if (state.get('joinedTournament') === upcoming.id) {
    return upcoming;
  }

  log.info(`Mau join tournament ${upcoming.id} (game=${gameKey})`);
  try {
    await api.arena.join(upcoming.id);
    state.set('joinedTournament', upcoming.id);
    log.ok(`Berhasil join tournament ${upcoming.id}`);
    return upcoming;
  } catch (e) {
    if (e.status === 409) {
      // Possibly: already joined, or already in another tournament
      const msg = JSON.stringify(e.data || '');
      if (/already.*joined/i.test(msg) || /participant/i.test(msg)) {
        state.set('joinedTournament', upcoming.id);
        log.info(`Sudah join tournament ${upcoming.id} sebelumnya`);
        return upcoming;
      }
      log.warn(`Join 409: ${msg}`);
    } else {
      log.err(`Join error: ${e.message}`);
    }
    return null;
  }
}

async function playLiveTournament(tournamentId) {
  const playedRounds = new Set();

  while (true) {
    let detail;
    try {
      detail = await api.arena.detail(tournamentId);
    } catch (e) {
      log.err(`Detail fetch fail: ${e.message}`);
      await sleep(5000);
      continue;
    }

    const status = detail.status;
    const round = detail.current_round || 0;
    const gameKey = detail.game?.key || detail.game_key;

    if (status === 'resolved') {
      log.ok(`Tournament ${tournamentId} resolved`, {
        winner: detail.winner?.name || detail.winner?.id || null,
      });
      state.pruneTournament(tournamentId);
      state.set('joinedTournament', null);
      return;
    }

    if (status !== 'live') {
      // Masih queue — tunggu boundary 2 jam
      const waitFor = parseInt(process.env.IDLE_POLL_INTERVAL || '120', 10);
      log.info(
        `Tournament ${tournamentId} status=${status}, tunggu ${waitFor}s`,
      );
      await sleep(waitFor * 1000);
      continue;
    }

    // status === 'live'
    if (round === 0) {
      await sleep(2000);
      continue;
    }

    const handler = HANDLERS[gameKey];
    if (!handler) {
      log.warn(`Game ${gameKey} belum ada handler — skip submit`);
    } else if (!playedRounds.has(round)) {
      // Cek apakah aku masih alive di round ini
      let alive = true;
      try {
        const lb = await api.arena.leaderboard(tournamentId);
        const me = lb?.you || lb?.me;
        if (me?.eliminated === true || me?.alive === false) {
          alive = false;
        }
      } catch {
        // ignore — anggap alive
      }

      if (!alive) {
        log.info(
          `Sudah eliminated di tournament ${tournamentId}, tunggu resolve`,
        );
      } else {
        log.game(`>>> R${round} (${gameKey}) starting...`);
        try {
          await handler.play({
            tournamentId,
            roundNum: round,
            roundEndsAt: detail.round_ends_at || detail.current_round_ends_at,
          });
          playedRounds.add(round);
        } catch (e) {
          log.err(`Handler ${gameKey} R${round} error: ${e.message}`);
          playedRounds.add(round); // jangan retry forever
        }
      }
    }

    const wait = parseInt(process.env.ACTIVE_POLL_INTERVAL || '10', 10);
    await sleep(wait * 1000);
  }
}

export async function runArenaLoop() {
  log.info('Arena loop start');

  while (true) {
    try {
      // Step 1: cek apakah lagi terlibat tournament
      const joinedId = state.get('joinedTournament');

      let activeId = joinedId;
      if (!activeId) {
        const joined = await tryJoinUpcoming();
        activeId = joined?.id || null;
      }

      if (activeId) {
        await playLiveTournament(activeId);
      } else {
        const wait = parseInt(process.env.IDLE_POLL_INTERVAL || '120', 10);
        log.info(`Tidak ada tournament aktif, idle ${wait}s`);
        await sleep(wait * 1000);
      }
    } catch (e) {
      log.err(`Outer loop error: ${e.message}`);
      await sleep(30_000);
    }
  }
}
