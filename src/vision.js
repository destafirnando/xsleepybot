// Vision API helper untuk solve CAPTCHA Master.
// Provider: groq (default & gratis), gemini (gratis fallback), openai, anthropic.
// Image diunduh dulu (buffer + content-type), lalu dikirim ke provider.
// Output: array integer tile indices [0..8] yang sudah di-dedupe & sorted.
import { api } from './api.js';

// =====================================================================
// PROMPTS - 3 variasi untuk diversity (Default + Strict + Minimal)
// =====================================================================
const PROMPT_DEFAULT = `Look at this 3x3 captcha grid. Tiles are indexed 0..8 row-major.
Layout:
  0 1 2
  3 4 5
  6 7 8

The header text at the top of the image describes which object to find
(for example "select all trucks", "select all motorcycles", "select all
traffic lights"). Read the header carefully.

Then identify which of the 9 tiles below contain that object. A tile counts
even if the object only partially appears in it. Be precise.

Reply with ONLY a JSON array of integer indices, sorted ascending.
Example: [0,3,7]
No prose. No markdown. Just the JSON array on a single line.`;

// PROMPT B - STRICT alternative reasoning, NO step-by-step
const PROMPT_STRICT = `Task: Identify tiles in 3x3 grid containing target object.
Header text tells you what object to find.
Tiles indexed 0-8 (row-major: top-left=0, top-right=2, bottom-right=8).

CRITICAL: Your entire response must be ONLY a JSON array. No words, no explanation.
Just brackets and numbers. Like: [0,2,5]

If unsure about a tile, INCLUDE it (better false-positive than miss).
If header asks for X but tile shows partial X, INCLUDE that tile.

Output format: [<numbers>]
Output now:`;

// PROMPT C - MINIMAL (radikal pendek, force concise)
const PROMPT_MINIMAL = `3x3 captcha. Header says what to find. Tiles 0-8 (row-major).
Output JSON array only. Example: [1,4,7]
Answer:`;

// =====================================================================
// Parse helper - LENIENT mode handles prose-prefix output
// =====================================================================
function parseSelected(text) {
  if (!text || typeof text !== 'string') {
    throw new Error(`Empty response`);
  }
  // Cari SEMUA JSON array, ambil yang terakhir (biasanya answer final)
  const matches = [...text.matchAll(/\[[\s\d,]*\]/g)];
  if (matches.length === 0) {
    // Fallback: cari angka individual yang valid (e.g. "tiles 1, 4, 7")
    const nums = text.match(/\b[0-8]\b/g);
    if (nums && nums.length > 0 && nums.length <= 9) {
      const arr = nums.map(Number).filter((n) => n >= 0 && n <= 8);
      if (arr.length > 0) {
        return [...new Set(arr)].sort((a, b) => a - b);
      }
    }
    throw new Error(`No JSON array in: ${text.slice(0, 120)}`);
  }
  // Pakai array TERAKHIR (biasanya answer setelah reasoning prose)
  const m = matches[matches.length - 1][0];
  let arr;
  try {
    arr = JSON.parse(m);
  } catch (e) {
    throw new Error(`Parse fail: ${m}`);
  }
  if (!Array.isArray(arr)) throw new Error(`Not array: ${m}`);
  return [
    ...new Set(
      arr.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 8),
    ),
  ].sort((a, b) => a - b);
}

// =====================================================================
// Provider implementations
// =====================================================================

// Groq - param `temperature` & `prompt` bisa di-override via opts
async function solveGroq(apiKey, imageUrl, opts = {}) {
  const {
    model = 'meta-llama/llama-4-scout-17b-16e-instruct',
    temperature = 0,
    prompt = PROMPT_DEFAULT,
  } = opts;

  const { buffer, contentType } = await api.fetchBytes(imageUrl);
  const b64 = buffer.toString('base64');
  const mediaType = contentType.includes('jpeg') ? 'image/jpeg' : 'image/png';
  const dataUrl = `data:${mediaType};base64,${b64}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      temperature,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return parseSelected(text);
}

// Gemini 2.5 Flash Lite
async function solveGemini(apiKey, imageUrl, opts = {}) {
  const {
    model = 'gemini-2.5-flash-lite',
    temperature = 0,
    prompt = PROMPT_DEFAULT,
  } = opts;

  const { buffer, contentType } = await api.fetchBytes(imageUrl);
  const b64 = buffer.toString('base64');
  const mimeType = contentType.includes('jpeg') ? 'image/jpeg' : 'image/png';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: b64 } },
          ],
        },
      ],
      generationConfig: { temperature, maxOutputTokens: 100 },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini(${model}) ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseSelected(text);
}

// Freemodel.dev - OpenAI-compatible, GPT-5 class (GRATIS). PRIORITAS UTAMA.
// Endpoint: https://api.freemodel.dev/v1/chat/completions
// Models: gpt-5.5 (best vision), gpt-5.4, gpt-5.4-mini (fast)
async function solveFreemodel(apiKey, imageUrl, opts = {}) {
  const { model = 'gpt-5.5', temperature = 0, prompt = PROMPT_DEFAULT } = opts;
  const { buffer, contentType } = await api.fetchBytes(imageUrl);
  const b64 = buffer.toString('base64');
  const mediaType = contentType.includes('jpeg') ? 'image/jpeg' : 'image/png';
  const dataUrl = `data:${mediaType};base64,${b64}`;

  const res = await fetch('https://api.freemodel.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      temperature,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Freemodel(${model}) ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return parseSelected(text);
}

// OpenAI gpt-4o-mini
async function solveOpenAI(apiKey, imageUrl, opts = {}) {
  const { temperature = 0, prompt = PROMPT_DEFAULT } = opts;
  const { buffer, contentType } = await api.fetchBytes(imageUrl);
  const b64 = buffer.toString('base64');
  const mediaType = contentType.includes('jpeg') ? 'image/jpeg' : 'image/png';
  const dataUrl = `data:${mediaType};base64,${b64}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      temperature,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return parseSelected(data?.choices?.[0]?.message?.content);
}

// Anthropic claude-3-5-haiku
async function solveAnthropic(apiKey, imageUrl, opts = {}) {
  const { prompt = PROMPT_DEFAULT } = opts;
  const { buffer, contentType } = await api.fetchBytes(imageUrl);
  const b64 = buffer.toString('base64');
  const mediaType = contentType.includes('jpeg') ? 'image/jpeg' : 'image/png';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: b64 },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return parseSelected(data?.content?.[0]?.text);
}

// =====================================================================
// Single-provider entry point - pakai opts untuk diversity
// =====================================================================
export async function solveWithVision({ provider, apiKey, imageUrl, opts = {} }) {
  if (!apiKey) throw new Error(`No API key for provider=${provider}`);
  switch (provider) {
    case 'freemodel':       return solveFreemodel(apiKey, imageUrl, opts);
    case 'freemodel-mini':  return solveFreemodel(apiKey, imageUrl, { ...opts, model: 'gpt-5.4-mini' });
    case 'freemodel-54':    return solveFreemodel(apiKey, imageUrl, { ...opts, model: 'gpt-5.4' });
    case 'groq':         return solveGroq(apiKey, imageUrl, opts);
    case 'groq-scout':   return solveGroq(apiKey, imageUrl, opts);
    // groq-maverick model 404 - fallback to scout
    case 'groq-maverick':return solveGroq(apiKey, imageUrl, opts);
    case 'groq-90b':     return solveGroq(apiKey, imageUrl, opts);
    case 'gemini':         return solveGemini(apiKey, imageUrl, opts);
    case 'gemini-flash':   return solveGemini(apiKey, imageUrl, { ...opts, model: 'gemini-2.5-flash' });
    case 'gemini-1.5':     return solveGemini(apiKey, imageUrl, { ...opts, model: 'gemini-1.5-flash' });
    case 'openai':     return solveOpenAI(apiKey, imageUrl, opts);
    case 'anthropic':  return solveAnthropic(apiKey, imageUrl, opts);
    default:
      throw new Error(`Unknown vision provider: ${provider}`);
  }
}

// Export prompts untuk dipakai di captcha.js
export { PROMPT_DEFAULT, PROMPT_STRICT, PROMPT_MINIMAL };

// =====================================================================
// Multi-provider chain - coba primary, kalau fail fallback
// =====================================================================
export async function solveWithChain(providers, imageUrl) {
  const errors = [];
  for (const { provider, apiKey, label, opts } of providers) {
    if (!apiKey) {
      errors.push(`${label}: no key`);
      continue;
    }
    try {
      const result = await solveWithVision({ provider, apiKey, imageUrl, opts });
      return { result, providerUsed: label };
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
    }
  }
  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}
