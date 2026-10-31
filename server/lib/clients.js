// Clients: one profile per business you make videos for, with its brand kit
// (logo, colours, preferred creative direction, business details) and a media
// library of its photos. New projects for a client start with all of it, so a
// returning client never needs anything re-entered.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, loadProject, newId, projectDir, updateProject, createProject, saveProject } from './store.js';
import { convertImage } from './ads.js';
import { cleanProfile } from './pipeline.js';

export const CLIENTS_DIR = path.join(DATA_DIR, 'clients');
const ID_RE = /^[a-z0-9-]{4,40}$/;
const clientDir = (id) => {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Invalid client id'), { status: 400 });
  return path.join(CLIENTS_DIR, id);
};
const HEX = /^#[0-9a-f]{6}$/i;

export async function loadClient(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(clientDir(id), 'client.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveClient(c) {
  const dir = clientDir(c.id);
  await fs.mkdir(dir, { recursive: true });
  c.updatedAt = new Date().toISOString();
  const tmp = path.join(dir, `client.json.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(c, null, 2));
  await fs.rename(tmp, path.join(dir, 'client.json'));
  return c;
}

const locks = new Map();
export async function updateClient(id, mutate) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  locks.set(id, prev.then(() => mine));
  await prev;
  try {
    const c = await loadClient(id);
    if (!c) throw Object.assign(new Error('Client not found'), { status: 404 });
    await mutate(c);
    return await saveClient(c);
  } finally {
    release();
  }
}

export function cleanBrand(b = {}) {
  return {
    colors: (Array.isArray(b.colors) ? b.colors : []).filter((c) => HEX.test(c)).map((c) => c.toLowerCase()).slice(0, 4),
    direction: typeof b.direction === 'string' ? b.direction.slice(0, 30) : 'auto',
    tone: ['auto', 'dark', 'light'].includes(b.tone) ? b.tone : 'auto',
  };
}

export async function createClient(fields = {}) {
  const c = {
    id: newId('c'),
    name: String(fields.name || 'New client').trim().slice(0, 80),
    business: typeof fields.business === 'string' ? fields.business : 'other',
    businessCustom: String(fields.businessCustom || '').slice(0, 80),
    profile: cleanProfile(fields.profile || { name: fields.name }),
    brand: cleanBrand(fields.brand),
    logo: null,
    media: [],
    notes: String(fields.notes || '').slice(0, 2000),
    createdAt: new Date().toISOString(),
  };
  return saveClient(c);
}

export async function listClients() {
  await fs.mkdir(CLIENTS_DIR, { recursive: true });
  const out = [];
  for (const e of await fs.readdir(CLIENTS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    const c = await loadClient(e.name).catch(() => null);
    if (c) out.push({ id: c.id, name: c.name, business: c.business, businessCustom: c.businessCustom, logo: c.logo ? `/client-files/${c.id}/${c.logo.thumb}` : null, colors: c.brand.colors, photos: c.media.length, updatedAt: c.updatedAt });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function patchClient(id, b = {}) {
  return updateClient(id, (c) => {
    if (typeof b.name === 'string' && b.name.trim()) c.name = b.name.trim().slice(0, 80);
    if (typeof b.business === 'string') c.business = b.business;
    if (typeof b.businessCustom === 'string') c.businessCustom = b.businessCustom.slice(0, 80);
    if (b.profile && typeof b.profile === 'object') c.profile = cleanProfile(b.profile);
    if (b.brand && typeof b.brand === 'object') c.brand = cleanBrand({ ...c.brand, ...b.brand });
    if (typeof b.notes === 'string') c.notes = b.notes.slice(0, 2000);
  });
}

export async function deleteClient(id) {
  await fs.rm(clientDir(id), { recursive: true, force: true });
}

/** Add images to a client's library (kind 'logo' replaces the logo). Reuses the ad asset converter. */
export async function addClientMedia(id, files, kind) {
  const c = await loadClient(id);
  if (!c) throw Object.assign(new Error('Client not found'), { status: 404 });
  const dir = clientDir(id);
  await fs.mkdir(dir, { recursive: true });
  const added = [], failed = [];
  for (const f of files) {
    try {
      added.push(await convertImage(dir, f.path, f.originalname, kind));
    } catch (err) {
      failed.push({ name: f.originalname, error: err.message });
    }
  }
  let oldLogo = null;
  const client = await updateClient(id, (cl) => {
    if (kind === 'logo' && added[0]) {
      oldLogo = cl.logo;
      cl.logo = added[0];
      // Brand colours from the logo when none are set yet.
      if (!cl.brand.colors.length && added[0].analysis?.colors?.length) cl.brand.colors = added[0].analysis.colors.slice(0, 3);
    } else cl.media.push(...added);
  });
  if (oldLogo) for (const f of [oldLogo.file, oldLogo.thumb]) await fs.rm(path.join(dir, f), { force: true });
  return { added, failed, client };
}

export async function deleteClientMedia(id, mediaId) {
  let removed = null;
  const c = await updateClient(id, (cl) => {
    const i = cl.media.findIndex((m) => m.id === mediaId);
    if (i < 0) throw Object.assign(new Error('Photo not found'), { status: 404 });
    [removed] = cl.media.splice(i, 1);
  });
  for (const f of [removed.file, removed.thumb]) await fs.rm(path.join(clientDir(id), f), { force: true });
  return c;
}

/**
 * Start a project for a client: business details, brand and media come along.
 * `mediaIds` limits the photos to those (the logo always comes).
 */
export async function newProjectForClient(id, name, { mediaIds = null } = {}) {
  const c = await loadClient(id);
  if (!c) throw Object.assign(new Error('Client not found'), { status: 404 });
  const project = await createProject(name || `${c.name} ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`);
  const pdir = path.join(projectDir(project.id), 'ad-assets');
  await fs.mkdir(pdir, { recursive: true });
  const assets = [];
  const media = mediaIds ? c.media.filter((m) => mediaIds.includes(m.id)) : c.media;
  for (const m of [...(c.logo ? [c.logo] : []), ...media]) {
    const copy = { ...m, id: newId('i'), cut: null };
    copy.file = `${copy.id}${path.extname(m.file)}`;
    copy.thumb = `${copy.id}-t${path.extname(m.thumb)}`;
    await fs.copyFile(path.join(clientDir(id), m.file), path.join(pdir, copy.file));
    await fs.copyFile(path.join(clientDir(id), m.thumb), path.join(pdir, copy.thumb));
    assets.push(copy);
  }
  return updateProject(project.id, (p) => {
    Object.assign(p, { clientId: c.id, business: c.business, businessCustom: c.businessCustom, profile: c.profile, brand: c.brand, adAssets: assets });
  });
}

/** Keep a project's brand in step with its client (called before generating). */
export async function syncProjectBrand(projectId) {
  const p = await loadProject(projectId);
  if (!p?.clientId) return p;
  const c = await loadClient(p.clientId);
  if (!c) return p;
  return updateProject(projectId, (q) => {
    q.brand = c.brand;
  });
}

/** Duplicate a project (footage, photos, plans and renders) under a new name. */
export async function duplicateProject(id) {
  const src = await loadProject(id);
  if (!src) throw Object.assign(new Error('Project not found'), { status: 404 });
  const copy = { ...JSON.parse(JSON.stringify(src)), id: newId('p'), name: `${src.name} (copy)`.slice(0, 80), createdAt: new Date().toISOString() };
  await fs.cp(projectDir(id), projectDir(copy.id), { recursive: true, filter: (s) => !/project\.(prev\.)?json/.test(path.basename(s)) && !path.basename(s).startsWith('.') });
  return saveProject(copy);
}

export { clientDir };
