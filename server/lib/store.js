// File-based project storage and an in-memory job queue. Each project is a
// folder under data/projects/<id>/ with a project.json manifest — no database.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

const ID_RE = /^[a-z0-9-]{4,40}$/;

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export function projectDir(id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Invalid project id'), { status: 400 });
  return path.join(PROJECTS_DIR, id);
}

export async function loadProject(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir(id), 'project.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveProject(project) {
  const dir = projectDir(project.id);
  await fs.mkdir(dir, { recursive: true });
  project.updatedAt = new Date().toISOString();
  const tmp = path.join(dir, `project.json.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(project, null, 2));
  await fs.rename(tmp, path.join(dir, 'project.json'));
  return project;
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
    marketing: null,
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

export function getJob(id) {
  return jobs.get(id) || null;
}

export function activeJobFor(projectId) {
  for (const j of jobs.values()) {
    if (j.projectId === projectId && (j.status === 'queued' || j.status === 'running')) return j;
  }
  return null;
}

export function enqueueJob(projectId, kind, fn) {
  const job = {
    id: newId('j'),
    projectId,
    kind,
    status: 'queued',
    stage: 'Waiting for another job to finish…',
    progress: 0,
    log: [],
    result: null,
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);

  const ctx = {
    stage(label, progress) {
      job.stage = label;
      if (progress !== undefined) job.progress = Math.max(0, Math.min(1, progress));
      job.log.push({ t: Date.now(), msg: label });
      if (job.log.length > 100) job.log.shift();
    },
    progress(p) {
      job.progress = Math.max(0, Math.min(1, p));
    },
  };

  queue = queue.then(async () => {
    job.status = 'running';
    ctx.stage('Starting…', 0);
    try {
      job.result = await fn(ctx);
      job.status = 'done';
      job.progress = 1;
      job.stage = 'Done';
    } catch (err) {
      console.error(`[job ${job.id}]`, err);
      job.status = 'error';
      job.error = err.message || String(err);
      job.code = err.code || null;
    }
  });

  // Forget finished jobs after an hour.
  for (const [id, j] of jobs) {
    if (Date.now() - j.createdAt > 3600_000 && j.status !== 'running') jobs.delete(id);
  }
  return job;
}
