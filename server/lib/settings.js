// Reads and writes the keys/model in .env from the Settings page, and applies
// them to the running server immediately (no restart needed).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_FILE = path.resolve(ROOT, process.env.ENV_FILE || '.env');

export const EDITABLE = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_MODEL'];
const LABELS = { ANTHROPIC_API_KEY: 'Claude key', OPENAI_API_KEY: 'OpenAI key', CLAUDE_MODEL: 'model name' };

const mask = (v) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : '');

export function publicSettings() {
  return {
    anthropicKey: mask(process.env.ANTHROPIC_API_KEY || ''),
    openaiKey: mask(process.env.OPENAI_API_KEY || ''),
    model: process.env.CLAUDE_MODEL || '',
    envFile: ENV_FILE,
  };
}

/** Update keys in .env (keeping every other line as it was) and in process.env. */
export async function saveSettings(updates) {
  const clean = {};
  for (const key of EDITABLE) {
    if (!(key in updates)) continue;
    const v = String(updates[key] ?? '').trim();
    if (/[\s"'`$\\]/.test(v)) throw Object.assign(new Error(`That ${LABELS[key]} has spaces or quote marks in it. Copy it again exactly as shown.`), { status: 400 });
    clean[key] = v;
  }
  let lines = [];
  try {
    lines = (await fs.readFile(ENV_FILE, 'utf8')).split('\n');
  } catch {}
  for (const [key, value] of Object.entries(clean)) {
    const i = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${key}=`).test(l));
    const line = value ? `${key}=${value}` : `# ${key}=`;
    if (i >= 0) lines[i] = line;
    else lines.push(line);
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
  const text = lines.join('\n').replace(/\n*$/, '\n');
  const tmp = `${ENV_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, ENV_FILE);
  return publicSettings();
}
