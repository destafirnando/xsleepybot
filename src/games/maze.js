// Maze Runner strategy.
//
// Aturan:
//   - Grid 21x21, start (10,10). Score = dist_from_center * 10 + final_tile_value.
//   - Step damage = tile value (median 5, max 50). Wall bump = 20 HP. HP=100.
//   - Tile collapse risk: 25% (2 agents), 50% (3), 75% (4), 100% (5+).
//
// Strategi sederhana:
//   - Pilih ARAH UTAMA random sekali (W/A/S/D) di awal round → menjauh dari center.
//   - Tiap iteration:
//     1. Lihat neighborhood. Direction utama tersedia? Pakai. Else cari open lain
//        yang bukan kebalikan (anti-bolak-balik).
//     2. Chain 3-5 step per request (cooldown 1s antar request).
//     3. Stop kalau HP < 35 ATAU sudah dist >= 14.
//   - Saat round mau habis (sisa <30 detik), submit /maze-check sekali.
//     Kalau ada >=2 agent di tile kita, gerak 1 langkah ke arah yang masih open
//     untuk menghindari collapse.

import { log } from '../logger.js';
import { api } from '../api.js';
import { state } from '../state.js';

const OPP = { W: 'S', S: 'W', A: 'D', D: 'A' };

function randomDir() {
  return ['W', 'A', 'S', 'D'][Math.floor(Math.random() * 4)];
}

function pickDir(neighborhood, primary, lastDir) {
  // neighborhood: { up: 'open'|'wall'|'oob', down, left, right } atau format mirip
  // Note: format eksak bisa beda — kita defensive.
  const map = {
    W: ['up', 'north', 'W'],
    S: ['down', 'south', 'S'],
    A: ['left', 'west', 'A'],
    D: ['right', 'east', 'D'],
  };

  function isOpen(dir) {
    if (!neighborhood) return true;
    for (const k of map[dir]) {
      const v = neighborhood[k];
      if (v === 'open' || v === 'floor' || v === true) return true;
      if (v === 'wall' || v === 'oob' || v === false) return false;
    }
    return true; // unknown → assume open
  }

  // Try primary first
  if (isOpen(primary)) return primary;

  // Try perpendiculars (avoid going back)
  const perps = primary === 'W' || primary === 'S' ? ['A', 'D'] : ['W', 'S'];
  for (const d of perps.sort(() => Math.random() - 0.5)) {
    if (isOpen(d) && d !== OPP[lastDir]) return d;
  }

  // Last resort: any open dir
  for (const d of ['W', 'A', 'S', 'D']) {
    if (isOpen(d)) return d;
  }
  return primary; // bump sengaja kalau buntu total
}

function distFromCenter(x, y) {
  return Math.abs(x - 10) + Math.abs(y - 10);
}

export async function play({ tournamentId, roundNum, roundEndsAt }) {
  const pairing = await api.arena.pairing(tournamentId, roundNum);
  const ms = pairing?.maze_state || pairing?.my_pairing?.maze_state;

  // Pilih primary direction sekali per round (dipersist)
  const stateKey = `primary-${tournamentId}-${roundNum}`;
  let primary = state.get(stateKey);
  if (!primary) {
    primary = randomDir();
    state.set(stateKey, primary);
  }

  let pos = ms?.position || [10, 10];
  let hp = ms?.health ?? 100;
  let lastDir = primary;
  let isDead = false;
  let neighborhood = ms?.neighborhood || null;

  const endTime = roundEndsAt
    ? new Date(roundEndsAt).getTime()
    : Date.now() + 9.5 * 60 * 1000;

  log.game(
    `[maze] R${roundNum}: start pos=${pos.join(',')} hp=${hp} primary=${primary}`,
  );

  // Phase 1: explore push
  while (!isDead && Date.now() < endTime - 30_000) {
    if (hp < 35) {
      log.game(`[maze] HP=${hp} low, stop pushing`);
      break;
    }
    if (distFromCenter(pos[0], pos[1]) >= 14) {
      log.game(`[maze] dist=${distFromCenter(pos[0], pos[1])} reached, stop`);
      break;
    }

    // Build chain 3-4 dirs
    const chain = [];
    for (let i = 0; i < 3; i++) {
      const d = pickDir(neighborhood, primary, lastDir);
      chain.push(d);
      lastDir = d;
    }

    let res;
    try {
      res = await api.arena.submitMaze(tournamentId, roundNum, chain.join(''));
    } catch (e) {
      if (e.status === 429) {
        await sleep(1100);
        continue;
      }
      log.err(`[maze] move error: ${e.message}`);
      break;
    }

    pos = res.final_position || pos;
    hp = res.health_left ?? hp;
    isDead = res.is_dead === true;
    // ambil neighborhood dari move terakhir
    const lastMove = res.moves?.[res.moves.length - 1];
    if (lastMove?.neighborhood) neighborhood = lastMove.neighborhood;

    log.game(
      `[maze] pos=${pos.join(',')} hp=${hp} dist=${distFromCenter(
        pos[0],
        pos[1],
      )}`,
    );

    if (isDead) {
      log.warn(`[maze] DIED — score=0`);
      return;
    }

    // honor cooldown server
    if (res.cooldown_until) {
      const wait = new Date(res.cooldown_until).getTime() - Date.now();
      if (wait > 0) await sleep(wait + 50);
    } else {
      await sleep(1100);
    }
  }

  // Phase 2: anti-crowd check
  if (!isDead && hp >= 10) {
    try {
      const check = await api.arena.mazeCheck(tournamentId, roundNum);
      log.game(
        `[maze] scan: occupants=${check.tile_occupants} hp=${check.health_left}`,
      );
      if (check.tile_occupants >= 2 && hp >= 25 && check.cooldown_until) {
        const wait = new Date(check.cooldown_until).getTime() - Date.now();
        if (wait > 0) await sleep(wait + 50);
        // Geser 1 langkah perpendicular
        const dodge = pickDir(neighborhood, primary === 'W' ? 'A' : 'W', lastDir);
        log.game(`[maze] dodge ${dodge}`);
        await api.arena.submitMaze(tournamentId, roundNum, dodge);
      }
    } catch (e) {
      log.warn(`[maze] scan/dodge error: ${e.message}`);
    }
  }

  log.ok(
    `[maze] R${roundNum} done: pos=${pos.join(',')} dist=${distFromCenter(
      pos[0],
      pos[1],
    )} hp=${hp}`,
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
