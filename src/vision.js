// Vision API helper untuk solve CAPTCHA Master.
// Provider: groq (default & gratis), gemini (gratis fallback), openai, anthropic.
// Image diunduh dulu (buffer + content-type), lalu dikirim ke provider.
// Output: array integer tile indices [0..8] yang sudah di-dedupe & sorted.
import { api } from './api.js';

// =====================================================================
// PROMPTS - 2 variasi untuk diversity
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

// Prompt B - pendekatan per-tile (analisa satu-satu)
const PROMPT_DETAILED = `This is a 3x3 captcha grid with 9 tiles indexed 0..8:
  Top row:    tile 0, tile 1, tile 2
  Middle row: tile 3, tile 4, tile 5
  Bottom row: tile 6, tile 7, tile 8

Step 1: Read the header text at top of image. What object are you asked to find?

Step 2: Examine EACH of the 9 tiles individually. For each tile, ask:
  "Does this tile contain the target object (even partially)?"

Step 3: Output ONLY the indices that contain the object as JSON array.
Example output: [1,4,7]

Be strict: include partial appearances but exclude tiles where you're unsure.
Output ONE LINE only - just the JSON array, no other text.`;

// =====================================================================
// Parse helper
// =====================================================================
function parseSelected(text) {
  if (!text || typeof text !== 'string') {
    throw new Error(`Empty response`);
  }
  const m = text.match(/\[[\s\d,]*\]/);
  if (!m) throw new Error(`No JSON array in: ${text.slice(0, 120)}`);
  let arr;
  try {
    arr = JSON.parse(m[0]);
  } catch (e) {
    throw new Error(`Parse fail: ${m[0]}`);
  }
  if (!Array.isArray(arr)) throw new Error(`Not array: ${m[0]}`);
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
export { PROMPT_DEFAULT, PROMPT_DETAILED };

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
