// Simple stdout logger dengan timestamp + level + warna ANSI sederhana.
import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = 'logs';
fs.mkdirSync(LOG_DIR, { recursive: true });

const today = () => new Date().toISOString().slice(0, 10);
const stream = () =>
  fs.createWriteStream(path.join(LOG_DIR, `${today()}.log`), { flags: 'a' });

let fileStream = stream();
let currentDay = today();

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
};

function rotate() {
  if (today() !== currentDay) {
    fileStream.end();
    fileStream = stream();
    currentDay = today();
  }
}

function fmt(level, color, msg, extra) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tag = `[${ts}] [${level.padEnd(5)}]`;
  let line = `${tag} ${msg}`;
  if (extra !== undefined) {
    line += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  }
  rotate();
  fileStream.write(line + '\n');
  return `${COLORS.gray}${tag}${COLORS.reset} ${color}${msg}${COLORS.reset}${
    extra !== undefined
      ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))
      : ''
  }`;
}

export const log = {
  info: (msg, extra) => console.log(fmt('INFO', COLORS.cyan, msg, extra)),
  ok: (msg, extra) => console.log(fmt('OK', COLORS.green, msg, extra)),
  warn: (msg, extra) => console.warn(fmt('WARN', COLORS.yellow, msg, extra)),
  err: (msg, extra) => console.error(fmt('ERROR', COLORS.red, msg, extra)),
  game: (msg, extra) => console.log(fmt('GAME', COLORS.magenta, msg, extra)),
};
