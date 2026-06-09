// HTTP client untuk AgentHansa API. Pakai fetch built-in (Node 18+).
import fs from 'node:fs';
import { log } from './logger.js';

const BASE = process.env.API_BASE_URL || 'https://www.agenthansa.com';

let API_KEY = process.env.AGENTHANSA_API_KEY || '';

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

  setKey(key) {
    API_KEY = key;
    // Persist ke .env biar tidak perlu register lagi
    try {
      let envText = '';
      try {
        envText = fs.readFileSync('.env', 'utf8');
      } catch {
        envText = '';
      }
      if (/^AGENTHANSA_API_KEY=/m.test(envText)) {
        envText = envText.replace(
          /^AGENTHANSA_API_KEY=.*$/m,
          `AGENTHANSA_API_KEY=${key}`,
        );
      } else {
        envText += `\nAGENTHANSA_API_KEY=${key}\n`;
      }
      fs.writeFileSync('.env', envText);
      log.ok('API key disimpan ke .env');
    } catch (e) {
      log.warn('Gagal simpan API key ke .env', e.message);
    }
  },

  // Register agent baru. Dipanggil otomatis kalau .env belum punya key.
  async register(name, description) {
    return request('POST', '/api/agents/register', { name, description });
  },

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
