// File-based project storage and a job queue whose records survive restarts.
// Each project is a folder under data/projects/<id>/ with a project.json
// manifest (plus project.prev.json, the previous save) — no database.
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');

const ID_RE = /^[a-z0-9-]{4,40}$/;

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export function projectDir(id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Invalid project id'), { status: 400 });
  return path.join(PROJECTS_DIR, id);
}

export async function loadProject(id) {
  const dir = projectDir(id);
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // A damaged manifest (e.g. the disk filled up mid-write): fall back to the previous save.
    try {
      const prev = JSON.parse(await fs.readFile(path.join(dir, 'project.prev.json'), 'utf8'));
      log('warn', `project ${id}: project.json unreadable (${err.message}); using the previous save`);
      return prev;
    } catch {
      throw err;
    }
  }
}

export async function saveProject(project) {
  const dir = projectDir(project.id);
  await fs.mkdir(dir, { recursive: true });
  project.updatedAt = new Date().toISOString();
  const tmp = path.join(dir, `project.json.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(project, null, 2));
  await fs.copyFile(path.join(dir, 'project.json'), path.join(dir, 'project.prev.json')).catch(() => {});
  await fs.rename(tmp, path.join(dir, 'project.json'));
  return project;
}

// Serialise read-modify-write per project so a long render and, say, a
// change request finishing at the same time can't overwrite each other.
const locks = new Map();

export async function updateProject(id, mutate) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  const chain = prev.then(() => mine);
  locks.set(id, chain);
  await prev;
  try {
    const project = await loadProject(id);
    if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
    const result = await mutate(project);
    return result === false ? project : await saveProject(project);
  } finally {
    release();
    if (locks.get(id) === chain) locks.delete(id);
  }
}

export async function createProject(name) {
  const project = {
    id: newId('p'),
    name: (name || 'Untitled project').slice(0, 80),
    createdAt: new Date().toISOString(),
    business: 'restaurant',
    businessCustom: '',
    platform: 'tiktok',
    videos: [],
    plan: null,
    clips: [],
    chat: [],
  };
  return saveProject(project);
}

export async function listProjects() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    const p = await loadProject(e.name).catch(() => null);
    if (!p) continue;
    projects.push({
      id: p.id,
      name: p.name,
      clientId: p.clientId || null,
      adCount: (p.adRenders || []).filter(Boolean).length,
      business: p.business,
      businessCustom: p.businessCustom,
      platform: p.platform,
      videoCount: p.videos.length,
      clipCount: p.clips.filter(Boolean).length,
      thumb: p.clips.find(Boolean)?.thumb ? `/media/${p.id}/output/${p.clips.find(Boolean).thumb}` : p.videos[0] ? `/media/${p.id}/videos/${p.videos[0].thumb}` : null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  }
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteProject(id) {
  await fs.rm(projectDir(id), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Jobs: one heavy job at a time so renders don't fight for CPU.
// ---------------------------------------------------------------------------

const jobs = new Map();
let queue = Promise.resolve();

const PUBLIC_FIELDS = ['id', 'projectId', 'kind', 'status', 'stage', 'progress', 'error', 'code', 'createdAt', 'startedAt', 'finishedAt', 'log'];
const jobFile = (id) => path.join(JOBS_DIR, `${id}.json`);

function persist(job, force = false) {
  const now = Date.now();
  if (!force && now - (job.savedAt || 0) < 1000) return;
  job.savedAt = now;
  try {
    fsSync.mkdirSync(JOBS_DIR, { recursive: true });
    const rec = Object.fromEntries([...PUBLIC_FIELDS, 'args', 'result'].map((k) => [k, job[k]]));
    fsSync.writeFileSync(`${jobFile(job.id)}.tmp`, JSON.stringify(rec));
    fsSync.renameSync(`${jobFile(job.id)}.tmp`, jobFile(job.id));
  } catch {}
}

// On start-up, jobs that were queued or running when Cutline stopped are
// marked interrupted (with their arguments kept, so they can be retried).
function loadJobRecords() {
  let files = [];
  try {
    files = fsSync.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of files) {
    try {
      const rec = JSON.parse(fsSync.readFileSync(path.join(JOBS_DIR, f), 'utf8'));
      if (Date.now() - rec.createdAt > 7 * 86400_000) {
        fsSync.rmSync(path.join(JOBS_DIR, f), { force: true });
        continue;
      }
      if (rec.status === 'queued' || rec.status === 'running') {
        Object.assign(rec, { status: 'interrupted', error: 'Cutline was stopped before this finished. Press Try again to run it again.', finishedAt: Date.now() });
        persist(rec, true);
      }
      jobs.set(rec.id, rec);
    } catch {}
  }
}
loadJobRecords();

export function getJob(id) {
  return jobs.get(id) || null;
}

/** The public view of a job (no internal arguments). */
export function jobView(job) {
  return Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, job[k]]));
}

export function activeJobFor(projectId) {
  for (const j of jobs.values()) {
    if (j.projectId === projectId && (j.status === 'queued' || j.status === 'running')) return j;
  }
  return null;
}

/** Most recent finished job for a project (to offer "Try again" after a failure or restart). */
export function lastJobFor(projectId) {
  let last = null;
  for (const j of jobs.values()) {
    if (j.projectId === projectId && (!last || j.createdAt > last.createdAt)) last = j;
  }
  return last;
}

/**
 * Queue a job. `args` must be plain JSON: it is saved so the job can be retried.
 * `fn(ctx)` does the work; ctx.stage/progress/log report to the UI and the job log.
 */
export function enqueueJob(projectId, kind, fn, args = {}) {
  const job = {
    id: newId('j'),
    projectId,
    kind,
    args,
    status: 'queued',
    stage: 'Waiting for another job to finish…',
    progress: 0,
    log: [],
    error: null,
    code: null,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  persist(job, true);

  const note = (msg) => {
    job.log.push({ t: Date.now(), msg: String(msg).slice(0, 500) });
    if (job.log.length > 200) job.log.shift();
  };
  const ctx = {
    stage(label, progress) {
      job.stage = label;
      if (progress !== undefined) job.progress = Math.max(0, Math.min(1, progress));
      note(label);
      persist(job);
    },
    progress(p) {
      job.progress = Math.max(0, Math.min(1, p));
    },
    log: note,
  };

  queue = queue.then(async () => {
    job.status = 'running';
    job.startedAt = Date.now();
    ctx.stage('Starting…', 0);
    try {
      job.result = await fn(ctx);
      job.status = 'done';
      job.progress = 1;
      job.stage = 'Done';
      note(`Finished in ${((Date.now() - job.startedAt) / 1000).toFixed(1)}s`);
    } catch (err) {
      log('error', `[job ${job.id} ${kind}]`, err);
      job.status = 'error';
      job.error = err.message || String(err);
      job.code = err.code || null;
      note(`Failed: ${job.error}`);
    }
    job.finishedAt = Date.now();
    log('info', `[job ${job.id}] ${kind} ${job.status} in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s${job.error ? `: ${job.error}` : ''}`);
    persist(job, true);
  });

  // Forget finished jobs from memory after a day (their records stay on disk for a week).
  for (const [id, j] of jobs) {
    if (Date.now() - j.createdAt > 86400_000 && j.status !== 'running' && j.status !== 'queued') jobs.delete(id);
  }
  return job;
}
