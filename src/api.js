// HTTP client untuk AgentHansa API. Pakai fetch built-in (Node 18+).
const BASE = process.env.API_BASE_URL || 'https://www.agenthansa.com';

const API_KEY = process.env.AGENTHANSA_API_KEY || '';

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
  return h;
}

async function request(method, pathStr, body, opts = {}) {
  const url = pathStr.startsWith('http') ? pathStr : `${BASE}${pathStr}`;
  const init = {
    method,
    headers: headers(opts.headers),
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`Network error: ${e.message}`);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const err = new Error(
      `HTTP ${res.status} ${method} ${pathStr}: ${
        typeof data === 'string' ? data : JSON.stringify(data)
      }`,
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// --- Public helpers ---

export const api = {
  hasKey: () => Boolean(API_KEY),

  async me() {
    return request('GET', '/api/agents/me');
  },

  // --- Arena endpoints ---
  arena: {
    upcoming: () => request('GET', '/api/arena/tournaments/upcoming'),
    detail: (id) => request('GET', `/api/arena/tournaments/${id}`),
    join: (id) =>
      request('POST', `/api/arena/tournaments/${id}/participants`, {}),
    leave: (id) =>
      request('DELETE', `/api/arena/tournaments/${id}/participants/me`),
    pairing: (id, round) =>
      request('GET', `/api/arena/tournaments/${id}/rounds/${round}/my-pairing`),
    leaderboard: (id) =>
      request('GET', `/api/arena/tournaments/${id}/leaderboard`),
    submit: (id, round, submission, message) =>
      request(
        'POST',
        `/api/arena/tournaments/${id}/rounds/${round}/submission`,
        { submission, message },
      ),
    submitCaptcha: (id, round, selected) =>
      request(
        'POST',
        `/api/arena/tournaments/${id}/rounds/${round}/captcha-submit`,
        { selected },
      ),
    submitMaze: (id, round, directions) =>
      request(
        'POST',
        `/api/arena/tournaments/${id}/rounds/${round}/maze-move`,
        { directions },
      ),
    mazeCheck: (id, round) =>
      request(
        'POST',
        `/api/arena/tournaments/${id}/rounds/${round}/maze-check`,
        {},
      ),
    myStats: (agentId) =>
      request('GET', `/api/arena/agents/${agentId}/stats`),
  },

  // Helper: download bytes (pakai fetch, return Buffer + content-type)
  async fetchBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, contentType: res.headers.get('content-type') || '' };
  },
};
