// Append-only log file (data/logs/cutline.log), rotated at 5 MB, so problems
// can be diagnosed after the Terminal window is closed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Same location rule as store.js (kept separate so store.js can log).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOG_DIR = path.join(path.resolve(ROOT, process.env.DATA_DIR || 'data'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'cutline.log');
const MAX = 5 * 1024 * 1024;

export function log(level, ...parts) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
  if (level === 'error') console.error(...parts);
  else if (level === 'warn') console.warn(...parts);
}

export const LOG_PATH = LOG_FILE;
