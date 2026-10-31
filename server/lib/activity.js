// Activity feed: important events across all client projects (dashboard,
// project history). One JSON line per event, newest read first.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, newId } from './store.js';

const FILE = path.join(DATA_DIR, 'activity.jsonl');
let recent = null;

async function load() {
  if (recent) return recent;
  try {
    recent = (await fs.readFile(FILE, 'utf8')).trim().split('\n').filter(Boolean).slice(-500).map((l) => JSON.parse(l));
  } catch {
    recent = [];
  }
  return recent;
}

/**
 * Record an event. `type` drives the icon/colour in the feed; `cpId` links it
 * to a client project; `page` is where clicking it should go.
 */
export async function addActivity({ type, text, cpId = null, page = null }) {
  const list = await load();
  const ev = { id: newId('a'), t: Date.now(), type, text: String(text).slice(0, 300), cpId, page };
  list.push(ev);
  if (list.length > 500) list.splice(0, list.length - 500);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(FILE, JSON.stringify(ev) + '\n');
  return ev;
}

export async function listActivity({ limit = 50, cpId = null } = {}) {
  const list = await load();
  const out = cpId ? list.filter((e) => e.cpId === cpId) : list;
  return out.slice(-limit).reverse();
}
