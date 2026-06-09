// Helper untuk solve CAPTCHA pakai vision API (OpenAI / Anthropic / Gemini).
// Fungsi tunggal `solveWithVision()`. Image diubah ke base64 dulu lalu kirim ke provider.
import { api } from './api.js';

const PROMPT = `Look at this 3x3 captcha grid. Tiles are indexed 0-8 row-major (top-left=0, top-right=2, bottom-left=6, bottom-right=8).
The header at the top of the image tells you what to find. Read it.
Reply with ONLY a JSON array of integer indices for tiles that match. Example: [0,3,7]
No prose. No markdown. Just the JSON array.`;

function parseSelected(text) {
  // Cari JSON array pertama [..]
  const m = text.match(/\[[\s\d,]+\]/);
  if (!m) throw new Error(`No JSON array in: ${text.slice(0, 100)}`);
  const arr = JSON.parse(m[0]);
  return [
    ...new Set(
      arr
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 8),
    ),
  ].sort((a, b) => a - b);
}

async function solveOpenAI(apiKey, imageUrl) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseSelected(data.choices[0].message.content);
}

async function solveAnthropic(apiKey, imageUrl) {
  // Anthropic butuh image jadi base64
  const { buffer, contentType } = await api.fetchBytes(imageUrl);
  const b64 = buffer.toString('base64');
  const mediaType = contentType.includes('jpeg')
    ? 'image/jpeg'
    : 'image/png';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: b64 },
            },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseSelected(data.content[0].text);
}

async function solveGemini(apiKey, imageUrl) {
  const { buffer, contentType } = await api.fetchBytes(imageUrl);
  const b64 = buffer.toString('base64');
  const mimeType = contentType.includes('jpeg') ? 'image/jpeg' : 'image/png';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mimeType, data: b64 } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseSelected(data.candidates[0].content.parts[0].text);
}

export async function solveWithVision({ provider, apiKey, imageUrl }) {
  switch (provider) {
    case 'openai':
      return solveOpenAI(apiKey, imageUrl);
    case 'anthropic':
      return solveAnthropic(apiKey, imageUrl);
    case 'gemini':
      return solveGemini(apiKey, imageUrl);
    default:
      throw new Error(`Unknown vision provider: ${provider}`);
  }
}
