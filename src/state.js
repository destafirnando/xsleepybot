// Simple JSON state persistence di file lokal.
// Dipakai untuk menyimpan: agent_id, last_pick_per_tournament, dll.
import fs from 'node:fs';
import path from 'node:path';

const STATE_DIR = 'state';
const STATE_FILE = path.join(STATE_DIR, 'bot.json');

fs.mkdirSync(STATE_DIR, { recursive: true });

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

export const state = {
  get(key, fallback = null) {
    const data = load();
    return key in data ? data[key] : fallback;
  },
  set(key, value) {
    const data = load();
    data[key] = value;
    save(data);
  },
  // Track pick history per tournament untuk anti-repeat coin_snipe
  recordPick(tournamentId, roundNum, pick) {
    const data = load();
    data.picks = data.picks || {};
    data.picks[tournamentId] = data.picks[tournamentId] || {};
    data.picks[tournamentId][roundNum] = pick;
    save(data);
  },
  getLastPick(tournamentId, currentRound) {
    const data = load();
    const history = data.picks?.[tournamentId] || {};
    return history[currentRound - 1] ?? null;
  },
  // Track maze state per tournament/round
  setMazeState(tournamentId, roundNum, value) {
    const data = load();
    data.maze = data.maze || {};
    data.maze[`${tournamentId}-${roundNum}`] = value;
    save(data);
  },
  getMazeState(tournamentId, roundNum) {
    const data = load();
    return data.maze?.[`${tournamentId}-${roundNum}`] ?? null;
  },
  // Cleanup old data (panggil sesekali biar file gak bengkak)
  pruneTournament(tournamentId) {
    const data = load();
    if (data.picks?.[tournamentId]) delete data.picks[tournamentId];
    if (data.maze) {
      for (const k of Object.keys(data.maze)) {
        if (k.startsWith(`${tournamentId}-`)) delete data.maze[k];
      }
    }
    save(data);
  },
};
