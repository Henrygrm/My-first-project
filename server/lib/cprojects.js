// Client projects: one per Google Form submission (or created by hand). Each
// holds everything about that job (answers, resources, video versions, emails,
// invoice, client feedback, history) and moves through the workflow:
//
//   submitted → collecting → ready_for_review → producing → video_review
//   → email_review → sending → sent → (revision_requested → producing → …)
//   → completed            (or declined / failed / dismissed)
//
// The owner approves production, every video and every email. Nothing is
// emailed to a client without an explicit Approve & Send.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getJob, jobEvents, loadProject, newId, projectDir, updateProject } from './store.js';
import { addClientMedia, clientDir, createClient, listClients, loadClient, newProjectForClient, syncProjectBrand, updateClient } from './clients.js';
import {
  asText, CHECK_EVERY_MS, downloadFile, fetchResponses, formConfigured, loadConfig, mapAnswers, postScript, recordCheckError, updateConfig,
} from './intake.js';
import { createInvoice, getInvoice, invoicePdf, issueInvoice, refreshDraft, unvoidInvoice, voidInvoice } from './invoices.js';
import { getBusiness, takeNumber } from './business.js';
import { addActivity } from './activity.js';
import { cleanProfile } from './pipeline.js';
import { probe, thumbnail } from './ffmpeg.js';
import { aiConfigured, classifyReply } from './ai.js';
import { voiceConfigured } from '../providers/tts.js';
import { FORMATS } from '../../public/engine/compose.js';
import { log } from './log.js';

export const CP_DIR = path.join(DATA_DIR, 'cprojects');
const ID_RE = /^[a-z0-9-]{4,40}$/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const SIZE_NAMES = { '9:16': 'Vertical', '4:5': 'Feed', '1:1': 'Square', '16:9': 'Landscape' };
const MAX_SEND = 40 * 1024 * 1024;

export const STAGES = {
  submitted: 'Submission received',
  collecting: 'Collecting resources',
  ready_for_review: 'Awaiting your review',
  producing: 'AI video in production',
  video_review: 'Video awaiting approval',
  email_review: 'Email awaiting approval',
  sending: 'Sending email',
  sent: 'Sent · awaiting client feedback',
  revision_requested: 'Revision requested',
  needs_attention: 'Client reply needs your review',
  completed: 'Completed',
  declined: 'Declined',
  failed: 'Needs attention: something failed',
  dismissed: 'Dismissed',
};
export const PROGRESS = ['Form submitted', 'Submission received', 'Resources collected', 'AI video generation started', 'Video generated', 'Video awaiting approval', 'Email awaiting approval', 'Email sent to client', 'Client feedback received', 'Project completed'];
const STEP_DONE = { submitted: 2, collecting: 2, ready_for_review: 3, producing: 4, video_review: 6, email_review: 6, sending: 7, sent: 8, revision_requested: 9, needs_attention: 9, completed: 10, declined: 9, failed: 2, dismissed: 2 };

const cpDir = (id) => {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Invalid project id'), { status: 400 });
  return path.join(CP_DIR, id);
};
const notFound = () => Object.assign(new Error('Client project not found'), { status: 404 });
const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// ---------------------------------------------------------------------------
// Storage (one folder per project; all of them cached in memory)
// ---------------------------------------------------------------------------

const cache = new Map();
let loaded = false;

function loadAll() {
  if (loaded) return;
  loaded = true;
  let dirs = [];
  try {
    dirs = fsSync.readdirSync(CP_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && ID_RE.test(d.name));
  } catch {}
  for (const d of dirs) {
    try {
      cache.set(d.name, JSON.parse(fsSync.readFileSync(path.join(CP_DIR, d.name, 'project.json'), 'utf8')));
    } catch {}
  }
}

async function save(cp) {
  const dir = cpDir(cp.id);
  await fs.mkdir(dir, { recursive: true });
  cp.updatedAt = Date.now();
  const tmp = path.join(dir, `project.json.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(cp, null, 2), { mode: 0o600 });
  await fs.rename(tmp, path.join(dir, 'project.json'));
  cache.set(cp.id, cp);
  return cp;
}

const locks = new Map();
/** Change a project under its own lock; returns the saved project. */
export function updateCp(id, mutate) {
  loadAll();
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(async () => {
    const cp = cache.get(id);
    if (!cp) throw notFound();
    const copy = structuredClone(cp);
    await mutate(copy);
    return save(copy);
  });
  locks.set(id, run.catch(() => {}));
  return run;
}

export function getCp(id) {
  loadAll();
  const cp = cache.get(id);
  return cp ? structuredClone(cp) : null;
}

export function allCps() {
  loadAll();
  return [...cache.values()].map((c) => structuredClone(c)).sort((a, b) => b.createdAt - a.createdAt);
}

/** History on the project + the global activity feed. */
function note(cp, type, text, page = null) {
  cp.history = cp.history || [];
  cp.history.push({ t: Date.now(), type, text });
  if (cp.history.length > 300) cp.history.splice(0, cp.history.length - 300);
  addActivity({ type, text: `${cp.name}: ${text}`, cpId: cp.id, page }).catch(() => {});
}

function setStage(cp, stage) {
  cp.stage = stage;
  cp.stageAt = Date.now();
}

// ---------------------------------------------------------------------------
// New submissions
// ---------------------------------------------------------------------------

/** A new client project from a form answer (duplicates are skipped). */
export async function createFromSubmission(resp, { connectedAt, cfg }) {
  loadAll();
  if ([...cache.values()].some((c) => c.responseId === String(resp.id))) return null;
  const m = mapAnswers(resp.answers, resp.email);
  const n = await takeNumber('nextProject');
  const cp = {
    id: newId('cp'), number: `CP-${String(n).padStart(4, '0')}`, source: 'google-form', responseId: String(resp.id),
    submittedAt: Number(resp.time) || Date.now(), createdAt: Date.now(),
    name: m.name || m.email || 'Unnamed business',
    contact: { name: m.contactName, email: m.email, phone: m.profile.contact },
    answers: (resp.answers || []).slice(0, 80),
    resources: { logo: null, photos: [], clips: [], skipped: [] },
    stage: 'submitted', stageAt: Date.now(),
    production: null, versions: [], emails: [], invoiceId: null, thread: null, feedback: [], revisions: [], uploads: {},
    archived: false, notes: [], history: [],
  };
  // The same business sending the form twice in a few minutes: flag it, don't guess.
  const twin = [...cache.values()].find((c) => c.name.toLowerCase() === cp.name.toLowerCase() && (c.contact?.email || '') === cp.contact.email && Math.abs((c.submittedAt || 0) - cp.submittedAt) < 15 * 60_000);
  if (twin) cp.notes.push(`This looks like a repeat of ${twin.number} (same business and email, sent minutes apart). Dismiss whichever you don't need.`);
  if (cp.submittedAt < (connectedAt || 0)) cp.notes.push('Sent before your form was connected.');
  cp.autoProduce = Boolean(cfg.autoProduce) && cp.submittedAt >= (connectedAt || 0) && !twin;
  note(cp, 'submission', 'New form submission received', `projects/${cp.id}`);
  await save(cp);
  queueTask(() => collect(cp.id));
  return cp;
}

// Downloads and project setup run one at a time (renders have their own queue).
let tasks = Promise.resolve();
function queueTask(fn) {
  const run = tasks.then(fn).catch((err) => log('warn', `client project task failed: ${err.message}`));
  tasks = run;
  return run;
}

async function findClient(m) {
  const name = (m.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const c of await listClients()) {
    const full = await loadClient(c.id);
    if (m.email && full?.email && full.email.toLowerCase() === m.email.toLowerCase()) return full;
    if (name && c.name.toLowerCase().replace(/\s+/g, ' ').trim() === name) return full;
  }
  return null;
}

/** Download the client's uploads and set up (or update) their brand kit. */
export async function collect(id) {
  let cp = getCp(id);
  if (!cp) return;
  const m = mapAnswers(cp.answers, cp.contact?.email);
  cp = await updateCp(id, (c) => {
    setStage(c, 'collecting');
    c.error = null;
  });
  try {
    // Client (brand kit): matched by email, then by business name.
    let client = await findClient(m);
    const fill = (old = {}) => Object.fromEntries(Object.entries(m.profile).map(([k, v]) => [k, v || old[k] || '']));
    if (!client) {
      client = await createClient({ name: m.name || m.email || 'New client', business: m.business, businessCustom: m.businessCustom, profile: fill(), brand: { colors: m.colors, direction: m.direction } });
    }
    client = await updateClient(client.id, (c) => {
      c.profile = cleanProfile(fill(c.profile));
      if (m.email) c.email = m.email;
      if (m.contactName) c.contactName = m.contactName;
      if (m.business !== 'other' || !c.business) Object.assign(c, { business: m.business, businessCustom: m.businessCustom });
      if (m.colors.length) c.brand.colors = m.colors;
      if (m.direction !== 'auto') c.brand.direction = m.direction;
    });

    const res = { logo: null, photos: [], clips: [], skipped: [] };
    const files = [...m.files.logo.slice(0, 1).map((f) => ['logo', f]), ...m.files.photos.slice(0, 20).map((f) => ['photo', f]), ...m.files.clips.slice(0, 8).map((f) => ['clip', f])];
    const clipDir = path.join(cpDir(id), 'resources');
    for (const [i, [kind, f]] of files.entries()) {
      await updateCp(id, (c) => (c.stageNote = `Downloading ${i + 1} of ${files.length}: ${f.name || kind}`));
      let tmp = null;
      try {
        tmp = await downloadFile(cp.responseId, f);
        if (kind === 'clip') {
          await fs.mkdir(clipDir, { recursive: true });
          const cid = newId('v');
          const ext = (path.extname(f.name || '').toLowerCase().match(/^\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts)$/) || ['.mp4'])[0];
          const file = `${cid}${ext}`;
          await fs.rename(tmp, path.join(clipDir, file)).catch(async () => {
            await fs.copyFile(tmp, path.join(clipDir, file));
          });
          tmp = null;
          try {
            const meta = await probe(path.join(clipDir, file));
            if (meta.duration < 1) throw new Error('shorter than 1 second');
            await thumbnail(path.join(clipDir, file), path.join(clipDir, `${cid}.jpg`), Math.min(1, meta.duration / 3), meta);
            res.clips.push({ id: cid, name: f.name || 'clip', file, thumb: `${cid}.jpg`, duration: meta.duration, width: meta.width, height: meta.height, size: (await fs.stat(path.join(clipDir, file))).size });
          } catch (err) {
            await fs.rm(path.join(clipDir, file), { force: true });
            res.skipped.push({ name: f.name, reason: `Could not be read as a video (${err.message.includes('ffprobe') ? 'unsupported or corrupt file' : err.message}).` });
          }
          continue;
        }
        const out = await addClientMedia(client.id, [{ path: tmp, originalname: f.name || 'photo.jpg' }], kind);
        if (out.failed.length) res.skipped.push({ name: f.name, reason: out.failed[0].error });
        for (const a of out.added) {
          const item = { id: a.id, name: f.name || a.file, file: a.file, thumb: a.thumb, width: a.width || a.analysis?.width, height: a.height || a.analysis?.height, quality: a.quality || a.analysis?.quality || null };
          if (kind === 'logo') res.logo = item;
          else res.photos.push(item);
        }
      } catch (err) {
        res.skipped.push({ name: f.name, reason: err.message });
      } finally {
        if (tmp) await fs.rm(tmp, { force: true });
      }
    }
    // No new logo sent: a returning client's saved logo still counts.
    if (!res.logo && client.logo) res.logo = { id: client.logo.id, name: 'Saved logo', file: client.logo.file, thumb: client.logo.thumb, saved: true };
    cp = await updateCp(id, (c) => {
      c.clientId = client.id;
      c.resources = res;
      c.stageNote = null;
      setStage(c, 'ready_for_review');
      const count = res.photos.length + res.clips.length + (res.logo && !res.logo.saved ? 1 : 0);
      note(c, 'resources', count ? `Resources collected (${[res.photos.length && `${res.photos.length} photo${res.photos.length > 1 ? 's' : ''}`, res.clips.length && `${res.clips.length} clip${res.clips.length > 1 ? 's' : ''}`, res.logo && !res.logo.saved && 'logo'].filter(Boolean).join(', ')})` : 'Submission ready (no files were uploaded)', `projects/${c.id}`);
      if (res.skipped.length) c.notes.push(...res.skipped.map((s) => `${s.name}: ${s.reason}`));
    });
    if (cp.autoProduce) await autoProduce(cp);
  } catch (err) {
    await updateCp(id, (c) => {
      setStage(c, 'failed');
      c.failedStep = 'collect';
      c.error = `Collecting the resources failed: ${err.message}`;
      c.stageNote = null;
      note(c, 'error', c.error, `projects/${c.id}`);
    });
  }
}

async function autoProduce(cp) {
  const cfg = await loadConfig();
  const today = new Date().toDateString();
  const started = allCps().filter((c) => c.autoStartedAt && new Date(c.autoStartedAt).toDateString() === today).length;
  if (started >= cfg.dailyLimit) {
    await updateCp(cp.id, (c) => c.notes.push(`Not started automatically: today's limit of ${cfg.dailyLimit} was reached.`));
    return;
  }
  await updateCp(cp.id, (c) => (c.autoStartedAt = Date.now()));
  await approveProduction(cp.id, { auto: true });
}

/** Owner rejects a submission (spam, duplicate…). It stays listed as dismissed. */
export async function dismissSubmission(id, reason = '') {
  return updateCp(id, (c) => {
    if (!['submitted', 'ready_for_review', 'failed'].includes(c.stage)) throw conflict('Only a submission that has not gone into production can be dismissed.');
    setStage(c, 'dismissed');
    c.archived = true;
    note(c, 'dismissed', `Submission dismissed${reason ? `: ${reason}` : ''}`);
  });
}

export async function restoreSubmission(id) {
  return updateCp(id, (c) => {
    if (c.stage !== 'dismissed') throw conflict('Only a dismissed submission can be restored.');
    setStage(c, c.resources && (c.clientId) ? 'ready_for_review' : 'submitted');
    c.archived = false;
    note(c, 'restored', 'Submission restored');
  });
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

let startJob = null;

/** Approve a submission for production: make the editing project and start the AI. */
export async function approveProduction(id, { auto = false } = {}) {
  let cp = getCp(id);
  if (!cp) throw notFound();
  if (cp.stage === 'submitted' || cp.stage === 'collecting') throw conflict('The resources are still being collected. Try again in a moment.');
  if (!['ready_for_review', 'failed'].includes(cp.stage)) throw conflict('This project is already in production.');
  if (cp.stage === 'failed' && cp.failedStep === 'collect') {
    queueTask(() => collect(id));
    return getCp(id);
  }
  const cfg = await loadConfig();
  const m = mapAnswers(cp.answers, cp.contact?.email);
  const notes = [];
  let projectId = cp.production?.projectId;
  if (!projectId || !(await loadProject(projectId))) {
    const client = await loadClient(cp.clientId);
    if (!client) throw bad('The client for this project is missing. Collect the resources again.');
    const day = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    const photoIds = cp.resources.photos.map((p) => p.id).filter((pid) => client.media.some((x) => x.id === pid));
    const project = await newProjectForClient(client.id, `${cp.number} · ${client.name}${m.focus ? ` · ${m.focus}` : ''} · ${day}`.slice(0, 80), { mediaIds: photoIds.length ? photoIds : null });
    projectId = project.id;
    // Client footage goes into the project like an upload.
    for (const clip of cp.resources.clips) {
      const vdir = path.join(projectDir(projectId), 'videos');
      await fs.mkdir(vdir, { recursive: true });
      const vid = newId('v');
      const file = `${vid}${path.extname(clip.file)}`;
      await fs.copyFile(path.join(cpDir(id), 'resources', clip.file), path.join(vdir, file));
      const meta = await probe(path.join(vdir, file));
      await thumbnail(path.join(vdir, file), path.join(vdir, `${vid}.jpg`), Math.min(1, meta.duration / 3), meta);
      await updateProject(projectId, (p) => {
        p.videos.push({ id: vid, name: clip.name, file, size: clip.size, thumb: `${vid}.jpg`, meta, uploadedAt: new Date().toISOString() });
      });
    }
    await updateProject(projectId, (p) => {
      p.instructions = m.instructions;
      p.request = { cpId: id, number: cp.number, from: 'Google Form', submittedAt: cp.submittedAt, deadline: m.deadline, email: m.email };
    });
  }
  let mode = cfg.mode === 'auto' ? 'auto' : 'ai';
  if (mode === 'ai' && !aiConfigured()) {
    mode = 'auto';
    notes.push('No Claude key saved, so the free (no AI) engine was used.');
  }
  let voiceover = m.voiceover;
  if (voiceover && !cfg.voiceover) {
    voiceover = false;
    notes.push('The client asked for a voiceover, but voiceovers are switched off for form projects.');
  } else if (voiceover && !voiceConfigured()) {
    voiceover = false;
    notes.push('The client asked for a voiceover, but no OpenAI key is saved.');
  }
  const client = await loadClient(cp.clientId);
  const jobOpts = {
    mode, business: m.business, businessCustom: m.businessCustom, profile: client?.profile || m.profile,
    count: m.count, seconds: m.seconds, format: m.format, direction: m.direction, objective: m.objective,
    music: 'auto', musicMood: m.musicMood, voiceover, voice: m.voice || 'coral', instructions: m.instructions, review: true,
  };
  await syncProjectBrand(projectId);
  const run = startRun(projectId, 'ads', jobOpts, m.formats.slice(1).map((format) => ({ format })), 'first');
  cp = await updateCp(id, (c) => {
    c.production = { projectId, jobOpts, formats: m.formats, sizes: c.production?.sizes || [], run };
    setStage(c, 'producing');
    c.failedStep = null;
    c.error = null;
    c.notes.push(...notes.filter((n) => !c.notes.includes(n)));
    note(c, 'production', auto ? 'AI video generation started automatically' : 'Approved for production: AI video generation started', `projects/${c.id}`);
  });
  return cp;
}

/** Start the main job plus a size job for each extra format (they queue behind it). */
function startRun(projectId, kind, args, sizes, reason, extra = {}) {
  const job = startJob(projectId, kind, args);
  return {
    kind: reason, jobId: job.id, startedAt: Date.now(), ...extra,
    sizeJobs: sizes.map((s) => ({ format: s.format, into: s.projectId || null, jobId: startJob(projectId, 'ads-size', { format: s.format, into: s.projectId || null }).id, status: 'queued' })),
  };
}

/** Called whenever a render job ends: move the right project along. */
async function onJobFinished(job) {
  const cp = allCps().find((c) => c.production?.run && (c.production.run.jobId === job.id || c.production.run.sizeJobs.some((s) => s.jobId === job.id)));
  if (!cp) return;
  await updateCp(cp.id, (c) => advanceRun(c));
}

/** Check the current run's jobs; when all have ended, snapshot or report. */
function advanceRun(c) {
  const run = c.production?.run;
  if (!run || run.finishedAt) return false;
  const main = getJob(run.jobId);
  const ended = (j) => j && ['done', 'error', 'interrupted'].includes(j.status);
  if (!main) {
    Object.assign(run, { finishedAt: Date.now(), error: 'The job was lost when Cutline restarted.' });
  } else if (!ended(main)) {
    c.stageNote = main.stage;
    c.progress = main.progress;
    return false;
  }
  for (const s of run.sizeJobs) {
    const j = getJob(s.jobId);
    if (!j) s.status = 'error';
    else if (j.status === 'done') Object.assign(s, { status: 'done', projectId: j.result?.projectId || s.into });
    else if (ended(j)) Object.assign(s, { status: 'error', error: j.error });
    else {
      c.stageNote = `${SIZE_NAMES[s.format] || s.format} size: ${j.stage}`;
      return false;
    }
  }
  run.finishedAt = Date.now();
  c.stageNote = null;
  c.progress = null;
  if (!main || main.status !== 'done') {
    run.error = run.error || main?.error || 'The job failed.';
    setStage(c, 'failed');
    c.failedStep = 'produce';
    c.error = `Video generation failed: ${run.error}`;
    note(c, 'error', c.error, `projects/${c.id}`);
    return true;
  }
  // A change request the engine could not act on: no new version, back to where it was.
  if (['internal', 'client'].includes(run.kind) && Array.isArray(main.result?.changed) && !main.result.changed.length) {
    run.noChange = true;
    const reply = String(main.result.reply || 'Nothing was changed.').slice(0, 400);
    c.lastNoChange = { at: Date.now(), kind: run.kind, reply };
    if (run.kind === 'client') {
      const rev = c.revisions.at(-1);
      if (rev) rev.noChange = true;
      for (const f of c.feedback) if (rev?.feedbackIds.includes(f.id)) Object.assign(f, { handled: false, decision: null });
      setStage(c, 'revision_requested');
    } else setStage(c, 'video_review');
    note(c, 'error', `The video was not changed: ${reply}`, run.kind === 'client' ? 'revisions' : 'approval');
    return true;
  }
  for (const s of run.sizeJobs.filter((x) => x.status === 'done' && x.projectId)) {
    const i = c.production.sizes.findIndex((z) => z.format === s.format);
    if (i >= 0) c.production.sizes[i].projectId = s.projectId;
    else c.production.sizes.push({ format: s.format, projectId: s.projectId });
  }
  for (const s of run.sizeJobs.filter((x) => x.status === 'error')) c.notes.push(`The ${SIZE_NAMES[s.format] || s.format} size could not be made: ${s.error || 'unknown error'}`);
  c.pendingSnapshot = true; // copied outside this lock (see snapshotPending)
  return true;
}

const REASONS = { first: 'First version', regenerate: 'Regenerated', internal: 'Your changes', client: 'Client revision', editor: 'Edited in the editor' };

/** Copy the finished videos into the project's version history. */
async function snapshotPending(id) {
  const cp = getCp(id);
  if (!cp?.pendingSnapshot) return;
  const n = (cp.versions.at(-1)?.n || 0) + 1;
  const vdir = path.join(cpDir(id), 'versions', `v${n}`);
  await fs.mkdir(vdir, { recursive: true });
  const videos = [];
  // Hand edits in the editor only change the main size, so other sizes are left out of that version.
  const sizes = cp.production.run?.kind === 'editor' ? [] : cp.production.sizes.filter((s) => s.projectId);
  const sources = [[cp.production.projectId, null], ...sizes.map((s) => [s.projectId, s.format])];
  let description = '';
  for (const [pid, sizeFormat] of sources) {
    const p = await loadProject(pid).catch(() => null);
    if (!p) continue;
    const format = sizeFormat || p.adPlan?.format || '9:16';
    if (!sizeFormat) {
      const ads = p.adPlan?.ads || [];
      description = [p.adPlan?.strategy, ...ads.map((a, i) => `${ads.length > 1 ? `Version ${i + 1}: ` : ''}${a.title}${a.angle ? `: ${a.angle}` : ''}`)].filter(Boolean).join('\n');
    }
    for (const [i, r] of (p.adRenders || []).entries()) {
      if (!r?.file) continue;
      const base = `${sizeFormat ? sizeFormat.replace(':', 'x') : 'main'}-${i + 1}`;
      await fs.copyFile(path.join(projectDir(pid), 'ad-output', r.file), path.join(vdir, `${base}.mp4`));
      if (r.thumb) await fs.copyFile(path.join(projectDir(pid), 'ad-output', r.thumb), path.join(vdir, `${base}.jpg`)).catch(() => {});
      videos.push({
        key: `v${n}/${base}.mp4`, file: `${base}.mp4`, thumb: r.thumb ? `${base}.jpg` : null, format, adIndex: i, projectId: pid,
        label: `${(p.adPlan?.ads?.length || 1) > 1 ? `Version ${i + 1}` : 'Video'}${sources.length > 1 ? ` · ${SIZE_NAMES[format] || format}` : ''}`,
        duration: r.duration || null, qa: r.qa ? { score: r.qa.score, passed: r.qa.passed, warnings: (r.qa.checks || []).filter((x) => x.level !== 'ok').length } : null,
      });
    }
  }
  await updateCp(id, (c) => {
    c.pendingSnapshot = false;
    const kind = c.production.run?.kind || 'first';
    c.lastNoChange = null;
    c.versions.push({ n, at: Date.now(), reason: REASONS[kind] || kind, instructions: c.production.run?.instructions || '', videos, description, approvedAt: null });
    setStage(c, 'video_review');
    note(c, 'video_ready', kind === 'client' ? `Revised video (version ${n}) is ready for review` : `Video version ${n} is ready for review`, 'approval');
  });
}

async function finishRuns() {
  for (const cp of allCps().filter((c) => c.pendingSnapshot)) {
    await snapshotPending(cp.id).catch((err) => log('warn', `snapshot failed: ${err.message}`));
  }
}

/** Re-run whatever failed last (collection, production, a revision). */
export async function retry(id) {
  const cp = getCp(id);
  if (!cp) throw notFound();
  if (cp.stage !== 'failed') throw conflict('Nothing to retry.');
  if (cp.failedStep === 'collect' || !cp.production) {
    queueTask(() => collect(id));
    return getCp(id);
  }
  const run = cp.production.run;
  if (run?.kind && run.kind !== 'first' && run.args) return rerun(id, run.kind, run.jobKind, run.args, run.instructions);
  await updateCp(id, (c) => setStage(c, 'ready_for_review'));
  return approveProduction(id);
}

async function rerun(id, reason, jobKind, args, instructions = '') {
  const cp = getCp(id);
  const sizes = (cp.production.formats || []).slice(1).map((format) => ({ format, projectId: cp.production.sizes.find((s) => s.format === format)?.projectId || null }));
  const run = startRun(cp.production.projectId, jobKind, args, sizes, reason, { jobKind, args, instructions });
  return updateCp(id, (c) => {
    c.production.run = run;
    setStage(c, 'producing');
    c.failedStep = null;
    c.error = null;
  });
}

// ---------------------------------------------------------------------------
// Video approval centre
// ---------------------------------------------------------------------------

const latest = (cp) => cp.versions.at(-1) || null;

/** Approve the latest version (chosen videos) → invoice + pending email. */
export async function approveVideo(id, { videos } = {}) {
  const cp = getCp(id);
  if (!cp) throw notFound();
  if (cp.stage !== 'video_review') throw conflict('There is no video waiting for approval on this project.');
  const v = latest(cp);
  const chosen = Array.isArray(videos) && videos.length ? v.videos.filter((x) => videos.includes(x.key)) : v.videos;
  if (!chosen.length) throw bad('Choose at least one video to approve.');
  // The invoice: one per project (a new one only if the old one was voided).
  let inv = cp.invoiceId ? await getInvoice(cp.invoiceId) : null;
  if (!inv || inv.status === 'void') {
    const extra = new Set(chosen.map((x) => x.format)).size - 1;
    inv = await createInvoice({ cpId: id, cpNumber: cp.number, businessName: cp.name, contactName: cp.contact?.name, email: cp.contact?.email, extraFormats: Math.max(0, extra) });
  } else if (inv.status === 'draft') {
    inv = await refreshDraft(inv.id);
  }
  const b = await getBusiness();
  const sentBefore = cp.emails.some((e) => e.status === 'sent');
  const kind = sentBefore ? 'revision' : 'delivery';
  const vars = { client_name: firstName(cp.contact?.name) || 'there', business_name: cp.name, my_business: b.name || b.contactName || 'The team' };
  const t = b.templates;
  const email = {
    id: newId('em'), kind, status: 'pending', createdAt: Date.now(), version: v.n,
    to: cp.contact?.email || '', subject: fillVars(kind === 'revision' ? t.revisionSubject : t.deliverySubject, vars),
    body: fillVars(kind === 'revision' ? t.revisionBody : t.deliveryBody, vars),
    videoKeys: chosen.map((x) => x.key), attachInvoice: true, invoiceId: inv.id, threadId: cp.thread?.id || null,
  };
  return updateCp(id, (c) => {
    const ver = c.versions.at(-1);
    ver.approvedAt = Date.now();
    ver.approvedVideos = chosen.map((x) => x.key);
    c.invoiceId = inv.id;
    // An older unsent draft is replaced by this one.
    for (const e of c.emails) if (e.status === 'pending' || e.status === 'failed') e.status = 'discarded';
    c.emails.push(email);
    setStage(c, 'email_review');
    note(c, 'video_approved', `Video version ${ver.n} approved`, `projects/${c.id}`);
    note(c, 'email_pending', `${kind === 'revision' ? 'Revision' : 'Delivery'} email and invoice ${inv.number} are waiting for your approval`, 'pending');
  });
}

/** "Request internal changes": the AI revises the current video from my notes. */
export async function requestInternalChanges(id, { instructions, adIndex = null } = {}) {
  const cp = getCp(id);
  if (!cp) throw notFound();
  if (!['video_review', 'email_review'].includes(cp.stage)) throw conflict('Changes can be requested while the video is waiting for approval.');
  const text = String(instructions || '').trim();
  if (text.length < 3) throw bad('Describe what you want changed.');
  const m = mapAnswers(cp.answers, cp.contact?.email);
  const request = [
    `Changes I want before this video goes to the client: ${text.slice(0, 2000)}`,
    m.instructions ? `Keep honouring the client's original requirements:\n${m.instructions}` : '',
    'Keep everything else that already works, and keep using the client\'s own photos, footage and logo.',
  ].filter(Boolean).join('\n\n');
  const args = { request, adIndex: Number.isInteger(adIndex) ? adIndex : null, sceneIndex: null, mode: cfgMode(await loadConfig()) };
  await updateCp(id, (c) => {
    for (const e of c.emails) if (e.status === 'pending' || e.status === 'failed') e.status = 'discarded';
    note(c, 'changes', `Internal changes requested: "${text.slice(0, 140)}"`);
  });
  return rerun(id, 'internal', 'ads-revise', args, text);
}

/** "Regenerate video": a fresh take with the same brief. */
export async function regenerateVideo(id) {
  const cp = getCp(id);
  if (!cp) throw notFound();
  if (!['video_review', 'email_review', 'failed'].includes(cp.stage) || !cp.production?.jobOpts) throw conflict('This project has no video to regenerate yet.');
  await updateCp(id, (c) => {
    for (const e of c.emails) if (e.status === 'pending' || e.status === 'failed') e.status = 'discarded';
    note(c, 'regenerate', 'Regenerating the video');
  });
  return rerun(id, 'regenerate', 'ads', { ...cp.production.jobOpts, mode: cfgMode(await loadConfig()) });
}

/** I fine-tuned the video by hand in the editor: make that the new version to approve. */
export async function useEditorVersion(id) {
  const cp = getCp(id);
  if (!cp) throw notFound();
  if (!['video_review', 'email_review'].includes(cp.stage) || !cp.production?.projectId) throw conflict('Use this while the video is waiting for approval.');
  const p = await loadProject(cp.production.projectId);
  if (!(p?.adRenders || []).some(Boolean)) throw conflict('The editor project has no finished videos.');
  const newest = Math.max(...p.adRenders.filter(Boolean).map((r) => Date.parse(r.createdAt) || 0));
  if (newest <= (latest(cp)?.at || 0)) throw conflict('There are no newer edits in the editor than the current version. Save and render your changes in the editor first.');
  await updateCp(id, (c) => {
    for (const e of c.emails) if (e.status === 'pending' || e.status === 'failed') e.status = 'discarded';
    c.production.run = { kind: 'editor', jobId: null, startedAt: Date.now(), finishedAt: Date.now(), sizeJobs: [] };
    c.pendingSnapshot = true;
  });
  await snapshotPending(id);
  return getCp(id);
}

const cfgMode = (cfg) => (cfg.mode === 'auto' || !aiConfigured() ? 'auto' : 'ai');
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const fillVars = (t, vars) => String(t).replace(/\{(client_name|business_name|my_business)\}/g, (_, k) => vars[k] || '');

// ---------------------------------------------------------------------------
// Pending emails (sending ONLY on Approve & Send)
// ---------------------------------------------------------------------------

export async function editEmail(id, emailId, b = {}) {
  return updateCp(id, (c) => {
    const e = c.emails.find((x) => x.id === emailId);
    if (!e) throw notFound();
    if (!['pending', 'failed'].includes(e.status)) throw conflict('This email can no longer be edited.');
    if (typeof b.to === 'string') e.to = b.to.trim().slice(0, 200);
    if (typeof b.subject === 'string') e.subject = b.subject.slice(0, 200);
    if (typeof b.body === 'string') e.body = b.body.slice(0, 10000);
    if (typeof b.attachInvoice === 'boolean') e.attachInvoice = b.attachInvoice;
    if (Array.isArray(b.videoKeys)) {
      const ver = c.versions.find((v) => v.n === e.version);
      const keys = b.videoKeys.filter((k) => ver?.videos.some((x) => x.key === k));
      if (!keys.length) throw bad('Keep at least one video in the email.');
      e.videoKeys = keys;
    }
    e.editedAt = Date.now();
  });
}

export async function discardEmail(id, emailId) {
  return updateCp(id, (c) => {
    const e = c.emails.find((x) => x.id === emailId);
    if (!e) throw notFound();
    if (!['pending', 'failed'].includes(e.status)) throw conflict('This email can no longer be discarded.');
    e.status = 'discarded';
    setStage(c, 'video_review');
    note(c, 'email_discarded', 'Pending email discarded; the video is back in the approval centre', 'approval');
  });
}

/** The owner clicked Approve & Send. Runs in the background; idempotent. */
export async function approveAndSend(id, emailId) {
  const cfg = await loadConfig();
  if (!formConfigured()) throw bad('Connect your Google account first (Client Onboarding → Google connection).');
  if (cfg.scriptVersion < 3) throw bad('Your Google script needs updating before Cutline can send through Gmail. See "Update your Google script" on the Email Management page.');
  const cp = getCp(id);
  if (!cp) throw notFound();
  const e = cp.emails.find((x) => x.id === emailId);
  if (!e) throw notFound();
  if (e.status === 'sent') throw conflict('This email has already been sent.');
  if (e.status === 'sending') throw conflict('This email is already being sent.');
  if (!['pending', 'failed'].includes(e.status)) throw conflict('This email can no longer be sent.');
  if (!EMAIL_RE.test(e.to || '')) throw bad('Check the recipient: that email address does not look right.');
  if (!e.subject.trim() || !e.body.trim()) throw bad('The email needs a subject and a message.');
  const ver = cp.versions.find((v) => v.n === e.version);
  const vids = (ver?.videos || []).filter((x) => e.videoKeys.includes(x.key));
  if (!vids.length) throw bad('The email has no videos.');
  for (const v of vids) {
    const st = await fs.stat(path.join(cpDir(id), 'versions', v.key)).catch(() => null);
    if (!st) throw bad(`${v.label} is missing from the version history.`);
    if (st.size > MAX_SEND) throw bad(`${v.label} is over 40 MB, too big to send.`);
  }
  await updateCp(id, (c) => {
    const x = c.emails.find((y) => y.id === emailId);
    x.status = 'sending';
    x.approvedAt = Date.now();
    x.error = null;
    setStage(c, 'sending');
    c.stageNote = 'Saving the videos to your Google Drive';
  });
  queueTask(() => doSend(id, emailId));
  return getCp(id);
}

async function doSend(id, emailId) {
  const b = await getBusiness();
  try {
    let cp = getCp(id);
    const e = cp.emails.find((x) => x.id === emailId);
    const ver = cp.versions.find((v) => v.n === e.version);
    const vids = ver.videos.filter((x) => e.videoKeys.includes(x.key));
    const folder = `${cp.name} (${cp.number})`.replace(/[\\/:*?"<>|]+/g, '').slice(0, 70);
    const links = [];
    for (const [i, v] of vids.entries()) {
      let url = cp.uploads?.[v.key];
      if (!url) {
        await updateCp(id, (c) => (c.stageNote = `Saving video ${i + 1} of ${vids.length} to your Google Drive`));
        const data = (await fs.readFile(path.join(cpDir(id), 'versions', v.key))).toString('base64');
        const up = await postScript({ action: 'upload', folder, name: `${cp.name} - ${v.label.replace(/ · /g, ' ')} (v${ver.n}).mp4`, type: 'video/mp4', data });
        if (up.shared === false) throw new Error('Google Drive would not make a shareable link (your account blocks link sharing).');
        url = up.url;
        await updateCp(id, (c) => {
          c.uploads = c.uploads || {};
          c.uploads[v.key] = url;
        });
      }
      links.push({ name: vids.length > 1 ? `Watch ${v.label}` : 'Watch your video', url });
    }
    const attachments = [];
    let inv = null;
    if (e.attachInvoice && e.invoiceId) {
      inv = await getInvoice(e.invoiceId);
      if (inv && inv.status !== 'void') attachments.push({ name: `Invoice ${inv.number}.pdf`, type: 'application/pdf', data: (await invoicePdf(inv.id)).toString('base64') });
    }
    await updateCp(id, (c) => (c.stageNote = `Emailing ${e.to}`));
    cp = getCp(id);
    const res = await postScript({ action: 'send', ref: e.id, to: e.to, subject: e.subject, body: e.body, links, attachments, threadId: e.threadId || cp.thread?.id || null, senderName: b.name || b.contactName || '' });
    if (inv && inv.status === 'draft') await issueInvoice(inv.id);
    await updateCp(id, (c) => {
      const x = c.emails.find((y) => y.id === emailId);
      Object.assign(x, { status: 'sent', sentAt: Date.now(), links, threadId: res.threadId, messageId: res.messageId, from: res.from || '' });
      c.thread = { id: res.threadId, sentAt: c.thread?.sentAt || Date.now(), lastSentAt: Date.now(), lastChecked: Date.now() };
      c.stageNote = null;
      setStage(c, 'sent');
      c.versions.find((v) => v.n === x.version).sentAt = Date.now();
      note(c, 'email_sent', `${x.kind === 'revision' ? 'Revision' : 'Delivery'} email sent to ${x.to}${inv ? ` with invoice ${inv.number}` : ''}`, `projects/${c.id}`);
    });
  } catch (err) {
    await updateCp(id, (c) => {
      const x = c.emails.find((y) => y.id === emailId);
      Object.assign(x, { status: 'failed', error: err.message });
      c.stageNote = null;
      setStage(c, 'email_review');
      note(c, 'error', `Email not sent: ${err.message}`, 'pending');
    });
  }
}

// ---------------------------------------------------------------------------
// Client replies (Gmail) → feedback, revisions, declines
// ---------------------------------------------------------------------------

/** The client's own words, without the quoted conversation below. */
export function stripQuoted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/wrote:\s*$/.test(l) && (/^On\b/i.test(l) || /^On\b/i.test(lines[i - 1]?.trim() || ''))) {
      if (!/^On\b/i.test(l) && out.length) out.pop();
      break;
    }
    if (/^-{2,}\s*(Original Message|Forwarded)/i.test(l) || /^_{5,}$/.test(l) || (/^From:\s/.test(l) && out.some((x) => x.trim()))) break;
    if (/^>/.test(l)) continue;
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

const DECLINE_RE = /\b(not interested|no longer interested|(won'?t|will not|not) (be )?(proceed|proceeding|going ahead|moving forward|continu(e|ing))|don'?t (want|need) (it|the video|this|to proceed|to go ahead)|no,? thank(s| you)|decided (not|against)|not for us|pass on (this|it)|cancel (the|this|my)|please cancel|not what (we|i)('re| are| am)? (want|need|looking for)|we('ll| will) leave it)\b/i;
const CHANGE_RE = /\b(change|chang(ed|ing)|adjust|edit|swap|replace|could you|can you|would you|please (make|add|remove|use|put|show|change)|instead|more|less|longer|shorter|faster|slower|bigger|smaller|different|fix|wrong|tweak|remove|add|update|brighter|darker|louder|quieter|music|logo|colour|color|font|text)\b/i;
const ACCEPT_RE = /\b(love (it|this)|looks (great|amazing|awesome|perfect|good)|perfect|amazing|happy with|approved?|all good|great (job|work)|well done|thank(s| you) so much|it'?s great|we('ll| will) (pay|use it|post it)|paid|payment (made|sent))\b/i;

/** Conservative rules (no AI, or as a check on the AI): unclear when in doubt. */
export function classifyByRules(text) {
  const t = String(text || '');
  const decline = DECLINE_RE.test(t), change = CHANGE_RE.test(t), accept = ACCEPT_RE.test(t);
  if (decline && !change) return { intent: 'declined', confidence: 0.85, summary: 'The client does not want to proceed.', changes: [], reason: '' };
  if (change && !decline && !(accept && t.length < 60)) return { intent: 'revision', confidence: 0.75, summary: 'The client asked for changes.', changes: [], reason: '' };
  if (accept && !decline && !change) return { intent: 'accepted', confidence: 0.75, summary: 'The client is happy with the video.', changes: [], reason: '' };
  return { intent: 'unclear', confidence: 0.3, summary: 'Cutline could not tell what the client wants.', changes: [], reason: '' };
}

async function classify(text, cp) {
  const rules = classifyByRules(text);
  if (!aiConfigured()) return { ...rules, by: 'rules' };
  try {
    const r = await classifyReply({ text, businessName: cp.name });
    let out = { intent: r.intent, confidence: Number(r.confidence) || 0, summary: r.summary || '', changes: r.requested_changes || [], reason: r.decline_reason || '', by: 'ai' };
    // Never treat a message that asks for changes as a rejection, and never act on a guess.
    if (out.intent === 'declined' && CHANGE_RE.test(text) && rules.intent !== 'declined') out = { ...out, intent: 'unclear', summary: `${out.summary} (It also mentions changes, so please check.)` };
    if (out.confidence < 0.7 && out.intent !== 'unclear') out = { ...out, intent: 'unclear', summary: `${out.summary} (Not certain, so please check.)` };
    return out;
  } catch (err) {
    log('warn', `reply classification fell back to rules: ${err.message}`);
    return { ...rules, by: 'rules' };
  }
}

let inboxBusy = false;

/** Ask Gmail for replies to delivery emails and file them under their projects. */
export async function checkInbox() {
  if (inboxBusy) return { ok: true, added: 0 };
  const cfg = await loadConfig();
  if (!formConfigured() || cfg.scriptVersion < 3) return { ok: false, added: 0, message: 'Gmail is not connected yet.' };
  const watch = allCps().filter((c) => c.thread?.id && !['declined', 'dismissed'].includes(c.stage) && !c.archived);
  if (!watch.length) {
    await updateConfig((x) => Object.assign(x, { lastInboxCheck: Date.now(), inboxError: null }));
    return { ok: true, added: 0 };
  }
  inboxBusy = true;
  let added = 0;
  try {
    const items = watch.map((c) => ({ ref: c.id, threadId: c.thread.id, from: c.contact?.email || '', after: Math.max(c.thread.sentAt || 0, ...c.feedback.map((f) => f.at || 0)) }));
    const res = await postScript({ action: 'inbox', items });
    for (const msg of res.messages || []) {
      const cp = getCp(msg.ref);
      if (!cp || cp.feedback.some((f) => f.id === msg.id)) continue;
      const text = stripQuoted(msg.text);
      if (!text) continue;
      const verdict = await classify(text, cp);
      added++;
      await updateCp(cp.id, (c) => applyFeedback(c, { id: msg.id, threadId: msg.threadId, at: Number(msg.date) || Date.now(), from: msg.from, subject: msg.subject, text, ...verdict }));
    }
    await updateConfig((x) => Object.assign(x, { lastInboxCheck: Date.now(), inboxError: null }));
    return { ok: true, added };
  } catch (err) {
    await updateConfig((x) => Object.assign(x, { lastInboxCheck: Date.now(), inboxError: err.message }));
    log('warn', `inbox check failed: ${err.message}`);
    return { ok: false, added, message: err.message };
  } finally {
    inboxBusy = false;
  }
}

/** File a client message and act on it (or flag it for the owner). */
function applyFeedback(c, f) {
  const fb = { ...f, receivedAt: Date.now(), handled: false, decision: null };
  c.feedback.push(fb);
  if (f.threadId && !c.thread?.id) c.thread = { ...(c.thread || {}), id: f.threadId };
  const busy = ['producing'].includes(c.stage);
  if (f.intent === 'revision') {
    if (!busy) setStage(c, 'revision_requested');
    note(c, 'revision', `Client requested changes: "${f.text.slice(0, 120)}${f.text.length > 120 ? '…' : ''}"`, 'revisions');
  } else if (f.intent === 'declined') {
    fb.handled = true;
    fb.decision = 'declined';
    declineInPlace(c, f.reason || f.text.slice(0, 200), 'client email');
  } else if (f.intent === 'accepted') {
    fb.handled = true;
    fb.decision = 'completed';
    setStage(c, 'completed');
    c.completedAt = Date.now();
    note(c, 'completed', 'Client is happy with the video. Project completed', `projects/${c.id}`);
  } else {
    if (!busy) setStage(c, 'needs_attention');
    note(c, 'needs_attention', `Client replied, but it's unclear what they want. Please review: "${f.text.slice(0, 100)}"`, 'revisions');
  }
}

function declineInPlace(c, reason, by) {
  setStage(c, 'declined');
  c.archived = true;
  c.declined = { at: Date.now(), reason: String(reason || '').slice(0, 300), by };
  for (const e of c.emails) if (e.status === 'pending' || e.status === 'failed') e.status = 'discarded';
  c.pendingVoid = true; // the invoice is voided right after this save
  note(c, 'declined', `Project declined (${by})${reason ? `: "${String(reason).slice(0, 120)}"` : ''}. Invoice cancelled, no charge`, `projects/${c.id}`);
}

async function voidPending() {
  for (const cp of allCps().filter((c) => c.pendingVoid)) {
    if (cp.invoiceId) await voidInvoice(cp.invoiceId, `Client declined${cp.declined?.reason ? `: ${cp.declined.reason}` : ''}`).catch((err) => log('warn', `void failed: ${err.message}`));
    await updateCp(cp.id, (c) => (c.pendingVoid = false));
  }
}

/** The owner decides what an unclear (or any) client message means. */
export async function resolveFeedback(id, feedbackId, decision) {
  if (!['revision', 'declined', 'completed', 'ignore'].includes(decision)) throw bad('Unknown decision');
  const cp = await updateCp(id, (c) => {
    const f = c.feedback.find((x) => x.id === feedbackId);
    if (!f) throw notFound();
    f.decision = decision;
    f.handled = decision !== 'revision';
    if (decision === 'revision') {
      f.intent = 'revision';
      setStage(c, 'revision_requested');
      note(c, 'revision', 'You marked the client\'s reply as a change request', 'revisions');
    } else if (decision === 'declined') {
      declineInPlace(c, f.text.slice(0, 200), 'you');
    } else if (decision === 'completed') {
      setStage(c, 'completed');
      c.completedAt = Date.now();
      note(c, 'completed', 'Project marked completed');
    } else {
      if (['needs_attention', 'revision_requested'].includes(c.stage) && !c.feedback.some((x) => !x.handled && x.id !== f.id)) setStage(c, 'sent');
      note(c, 'feedback_ignored', 'Client reply marked as needing no action');
    }
  });
  await voidPending();
  return cp;
}

/** Start the revision: the AI gets the brief, resources, the client's feedback and my instructions. */
export async function startRevision(id, { instructions } = {}) {
  const cp = getCp(id);
  if (!cp) throw notFound();
  if (!['revision_requested', 'needs_attention', 'sent', 'completed'].includes(cp.stage)) throw conflict('This project is not waiting for a revision.');
  if (!cp.production?.projectId) throw conflict('This project has no video to revise.');
  const mine = String(instructions || '').trim();
  const open = cp.feedback.filter((f) => !f.handled);
  if (!mine && !open.length) throw bad('Write your revision instructions.');
  const m = mapAnswers(cp.answers, cp.contact?.email);
  const request = [
    'REVISION FOR THE CLIENT.',
    open.length ? `What the client said in their email:\n${open.map((f) => `"${f.text.slice(0, 1200)}"`).join('\n')}` : '',
    mine ? `My instructions (follow these first; they interpret the client's feedback):\n${mine.slice(0, 2000)}` : '',
    m.instructions ? `The client's original requirements (still apply):\n${m.instructions}` : '',
    'Keep everything the client did not ask to change. Keep using their own photos, footage and logo.',
  ].filter(Boolean).join('\n\n').slice(0, 4000);
  const args = { request, adIndex: null, sceneIndex: null, mode: cfgMode(await loadConfig()) };
  await updateCp(id, (c) => {
    for (const f of c.feedback) if (!f.handled) Object.assign(f, { handled: true, decision: 'revision' });
    c.revisions.push({ at: Date.now(), feedbackIds: open.map((f) => f.id), instructions: mine, fromVersion: latest(c)?.n || null });
    note(c, 'revision_started', `Revision ${c.revisions.length} started${mine ? `: "${mine.slice(0, 120)}"` : ''}`, `projects/${c.id}`);
  });
  return rerun(id, 'client', 'ads-revise', args, mine || open.map((f) => f.text).join(' ').slice(0, 300));
}

/** Decline by hand (e.g. the client phoned). */
export async function declineProject(id, { reason = '' } = {}) {
  const cp = await updateCp(id, (c) => {
    if (c.stage === 'declined') throw conflict('Already declined.');
    declineInPlace(c, reason, 'you');
  });
  await voidPending();
  return cp;
}

export async function undoDecline(id) {
  const cp = getCp(id);
  if (!cp) throw notFound();
  if (cp.stage !== 'declined') throw conflict('This project is not declined.');
  if (cp.invoiceId) await unvoidInvoice(cp.invoiceId).catch(() => {});
  return updateCp(id, (c) => {
    c.archived = false;
    c.declined = null;
    setStage(c, c.emails.some((e) => e.status === 'sent') ? 'sent' : latest(c) ? 'video_review' : 'ready_for_review');
    note(c, 'restored', 'Decline undone; invoice restored');
  });
}

export async function completeProject(id) {
  return updateCp(id, (c) => {
    if (['declined', 'dismissed'].includes(c.stage)) throw conflict('Restore the project first.');
    setStage(c, 'completed');
    c.completedAt = Date.now();
    note(c, 'completed', 'Project marked completed');
  });
}

export async function setArchived(id, archived) {
  return updateCp(id, (c) => {
    c.archived = Boolean(archived);
    note(c, 'archive', archived ? 'Project archived' : 'Project restored from the archive');
  });
}

export async function addNote(id, text) {
  const t = String(text || '').trim().slice(0, 1000);
  if (!t) throw bad('Write a note first.');
  return updateCp(id, (c) => {
    c.history.push({ t: Date.now(), type: 'note', text: t });
  });
}

// ---------------------------------------------------------------------------
// Views for the pages
// ---------------------------------------------------------------------------

function progressOf(cp) {
  const done = STEP_DONE[cp.stage] ?? 0;
  return { steps: PROGRESS, done, revisions: cp.revisions?.length || 0 };
}

function clientFileUrl(cp, file) {
  return cp.clientId && file ? `/client-files/${cp.clientId}/${file}` : null;
}

export async function summary(cp) {
  const inv = cp.invoiceId ? await getInvoice(cp.invoiceId) : null;
  const v = latest(cp);
  const m = mapAnswers(cp.answers, cp.contact?.email);
  const pending = cp.emails.find((e) => ['pending', 'failed', 'sending'].includes(e.status));
  return {
    id: cp.id, number: cp.number, name: cp.name, contact: cp.contact, stage: cp.stage, stageLabel: STAGES[cp.stage] || cp.stage, stageAt: cp.stageAt,
    stageNote: cp.stageNote || null, progressPct: cp.progress ?? null, error: cp.error || null,
    createdAt: cp.createdAt, submittedAt: cp.submittedAt, updatedAt: cp.updatedAt, archived: cp.archived,
    business: m.business, businessCustom: m.businessCustom, deadline: m.deadline,
    thumb: v?.videos[0]?.thumb ? `/cp-files/${cp.id}/versions/v${v.n}/${v.videos[0].thumb}` : clientFileUrl(cp, cp.resources?.photos[0]?.thumb),
    logo: clientFileUrl(cp, cp.resources?.logo?.thumb),
    versions: cp.versions.length, openFeedback: cp.feedback.filter((f) => !f.handled).length,
    emailStatus: pending ? pending.status : cp.emails.some((e) => e.status === 'sent') ? 'sent' : 'none',
    invoice: inv ? { id: inv.id, number: inv.number, status: inv.status, total: inv.total, currency: inv.currency } : null,
    progress: progressOf(cp), notes: cp.notes || [], lastNoChange: cp.lastNoChange || null,
  };
}

export async function detail(id) {
  const cp = getCp(id);
  if (!cp) throw notFound();
  const m = mapAnswers(cp.answers, cp.contact?.email);
  const base = await summary(cp);
  const inv = cp.invoiceId ? await getInvoice(cp.invoiceId) : null;
  const vurl = (n, f) => (f ? `/cp-files/${cp.id}/versions/v${n}/${f}` : null);
  return {
    ...base,
    requirements: {
      business: m.business, businessCustom: m.businessCustom, objective: m.objective, direction: m.direction, formats: m.formats, seconds: m.seconds,
      count: m.count, musicMood: m.musicMood, voiceover: m.voiceover, colors: m.colors, deadline: m.deadline, focus: m.focus, instructions: m.instructions, profile: m.profile,
    },
    answers: cp.answers.filter((a) => a.type !== 'FILE_UPLOAD').map((a) => ({ title: a.title, answer: asText(a.answer) })),
    resources: {
      logo: cp.resources.logo ? { ...cp.resources.logo, url: clientFileUrl(cp, cp.resources.logo.file), thumbUrl: clientFileUrl(cp, cp.resources.logo.thumb) } : null,
      photos: cp.resources.photos.map((p) => ({ ...p, url: clientFileUrl(cp, p.file), thumbUrl: clientFileUrl(cp, p.thumb) })),
      clips: cp.resources.clips.map((c) => ({ ...c, url: `/cp-files/${cp.id}/resources/${c.file}`, thumbUrl: `/cp-files/${cp.id}/resources/${c.thumb}` })),
      skipped: cp.resources.skipped,
      expected: { photos: m.files.photos.length, clips: m.files.clips.length, logo: m.files.logo.length > 0 },
    },
    clientId: cp.clientId || null,
    production: cp.production ? { projectId: cp.production.projectId, sizes: cp.production.sizes, formats: cp.production.formats, run: cp.production.run ? { kind: cp.production.run.kind, startedAt: cp.production.run.startedAt, finishedAt: cp.production.run.finishedAt || null, error: cp.production.run.error || null } : null } : null,
    versions: cp.versions.map((v) => ({ ...v, videos: v.videos.map((x) => ({ ...x, url: vurl(v.n, x.file), thumbUrl: vurl(v.n, x.thumb) })) })).reverse(),
    emails: cp.emails.filter((e) => e.status !== 'discarded').map((e) => ({ ...e })).reverse(),
    invoiceFull: inv,
    feedback: [...cp.feedback].reverse(),
    revisions: cp.revisions,
    history: [...cp.history].reverse(),
    declined: cp.declined || null,
  };
}

export async function listView({ includeArchived = true } = {}) {
  const out = [];
  for (const cp of allCps()) if (includeArchived || !cp.archived) out.push(await summary(cp));
  return out;
}

/** Everything waiting in the approval centre (latest version of each). */
export async function approvalQueue() {
  const out = [];
  for (const cp of allCps().filter((c) => c.stage === 'video_review' || (c.stage === 'producing'))) {
    const d = await detail(cp.id);
    out.push({ ...d, current: d.versions[0] || null, previous: d.versions.slice(1) });
  }
  return out;
}

/** Pending emails across projects, with what's needed to review them. */
export async function pendingEmails() {
  const out = [];
  for (const cp of allCps()) {
    for (const e of cp.emails.filter((x) => ['pending', 'failed', 'sending'].includes(x.status))) {
      const ver = cp.versions.find((v) => v.n === e.version);
      const inv = e.invoiceId ? await getInvoice(e.invoiceId) : null;
      const m = mapAnswers(cp.answers, cp.contact?.email);
      out.push({
        cpId: cp.id, number: cp.number, name: cp.name, contact: cp.contact, stage: cp.stage, stageNote: cp.stageNote || null, email: e,
        videos: (ver?.videos || []).map((x) => ({ ...x, url: `/cp-files/${cp.id}/versions/v${ver.n}/${x.file}`, thumbUrl: x.thumb ? `/cp-files/${cp.id}/versions/v${ver.n}/${x.thumb}` : null, included: e.videoKeys.includes(x.key) })),
        invoice: inv, requirements: { instructions: m.instructions, formats: m.formats, seconds: m.seconds, deadline: m.deadline },
        answers: cp.answers.filter((a) => a.type !== 'FILE_UPLOAD').map((a) => ({ title: a.title, answer: asText(a.answer) })),
        version: ver?.n || null,
      });
    }
  }
  return out.sort((a, b) => b.email.createdAt - a.email.createdAt);
}

export async function sentEmails() {
  const out = [];
  for (const cp of allCps()) for (const e of cp.emails.filter((x) => x.status === 'sent')) out.push({ cpId: cp.id, number: cp.number, name: cp.name, email: { id: e.id, kind: e.kind, to: e.to, subject: e.subject, sentAt: e.sentAt, links: e.links, version: e.version } });
  const replies = [];
  for (const cp of allCps()) for (const f of cp.feedback) replies.push({ cpId: cp.id, number: cp.number, name: cp.name, feedback: f });
  return { sent: out.sort((a, b) => b.email.sentAt - a.email.sentAt), replies: replies.sort((a, b) => b.feedback.at - a.feedback.at) };
}

export async function revisionsView() {
  const out = [];
  for (const cp of allCps().filter((c) => c.feedback.length || c.revisions.length)) {
    const d = await detail(cp.id);
    out.push(d);
  }
  const rank = (s) => (s === 'needs_attention' ? 0 : s === 'revision_requested' ? 1 : s === 'producing' ? 2 : s === 'video_review' ? 3 : 4);
  return out.sort((a, b) => rank(a.stage) - rank(b.stage) || b.updatedAt - a.updatedAt);
}

export async function dashboard() {
  const cps = allCps();
  const by = (fn) => cps.filter(fn).length;
  const week = Date.now() - 7 * 86400_000;
  const clients = await listClients();
  const emailsSent = cps.reduce((n, c) => n + c.emails.filter((e) => e.status === 'sent').length, 0);
  return {
    stats: {
      clients: clients.length,
      newSubmissions: by((c) => ['submitted', 'collecting', 'ready_for_review'].includes(c.stage)),
      submissionsThisWeek: by((c) => c.createdAt > week),
      inProduction: by((c) => c.stage === 'producing'),
      awaitingVideoApproval: by((c) => c.stage === 'video_review'),
      awaitingEmailApproval: by((c) => ['email_review', 'sending'].includes(c.stage)),
      emailsSent,
      revisionsRequested: by((c) => ['revision_requested', 'needs_attention'].includes(c.stage)),
      completed: by((c) => c.stage === 'completed'),
      declined: by((c) => c.stage === 'declined'),
      failed: by((c) => c.stage === 'failed'),
      total: cps.length,
    },
    pipeline: Object.keys(STAGES).map((s) => ({ stage: s, label: STAGES[s], count: by((c) => c.stage === s) })).filter((x) => x.count),
    attention: await Promise.all(cps.filter((c) => ['ready_for_review', 'video_review', 'email_review', 'revision_requested', 'needs_attention', 'failed'].includes(c.stage)).slice(0, 12).map(summary)),
  };
}

// ---------------------------------------------------------------------------
// Background loop
// ---------------------------------------------------------------------------

let checking = null;

/** Check the form for new submissions (and Gmail for replies). */
export function checkNow() {
  if (!checking) {
    checking = (async () => {
      if (!formConfigured()) return { ok: false, added: 0, message: 'Connect your Google Form first.' };
      let added = 0;
      try {
        const { responses, connectedAt, config } = await fetchResponses();
        for (const r of responses) if (await createFromSubmission(r, { connectedAt, cfg: config })) added++;
      } catch (err) {
        await recordCheckError(err);
        log('warn', `form check failed: ${err.message}`);
        return { ok: false, added, message: err.message };
      }
      const inbox = await checkInbox();
      await voidPending();
      const cfg = await loadConfig();
      const parts = [added ? `${added} new submission${added > 1 ? 's' : ''}` : 'No new submissions', inbox.added ? `${inbox.added} new client repl${inbox.added > 1 ? 'ies' : 'y'}` : null].filter(Boolean);
      return { ok: true, added, replies: inbox.added || 0, message: `Connected to "${cfg.formTitle || 'your form'}". ${parts.join(', ')}.`, inboxError: inbox.ok ? null : inbox.message };
    })().finally(() => (checking = null));
  }
  return checking;
}

/** Old (v3.1/3.2) request list → client projects, once. */
async function migrateOldRequests() {
  const file = path.join(DATA_DIR, 'intake', 'requests.json');
  let list;
  try {
    list = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return;
  }
  for (const r of [...list].reverse()) {
    if (allCps().some((c) => c.responseId === r.responseId)) continue;
    const m = mapAnswers(r.answers, r.email);
    const n = await takeNumber('nextProject');
    const cp = {
      id: newId('cp'), number: `CP-${String(n).padStart(4, '0')}`, source: 'google-form', responseId: r.responseId, submittedAt: r.submittedAt || Date.now(), createdAt: r.receivedAt || Date.now(),
      name: r.name, contact: { name: m.contactName, email: r.email || m.email, phone: m.profile.contact }, answers: r.answers || [],
      resources: { logo: null, photos: [], clips: [], skipped: [] }, stage: r.status === 'dismissed' ? 'dismissed' : 'submitted', stageAt: Date.now(),
      production: null, versions: [], emails: [], invoiceId: null, thread: null, feedback: [], revisions: [], uploads: {}, archived: r.status === 'dismissed',
      notes: ['Moved from the old Requests page. Approve production to make the video with the new workflow.'], history: [{ t: Date.now(), type: 'migrated', text: 'Moved from the old Requests page' }],
      clientId: r.clientId || null,
    };
    await save(cp);
    if (cp.stage === 'submitted') queueTask(() => collect(cp.id));
  }
  await fs.rename(file, `${file}.migrated`).catch(() => {});
}

export function startOps(run) {
  startJob = run;
  loadAll();
  jobEvents.on('finished', (job) => {
    onJobFinished(job).then(finishRuns).catch((err) => log('warn', `client project update failed: ${err.message}`));
  });
  (async () => {
    await migrateOldRequests();
    // Interrupted work after a restart.
    for (const cp of allCps()) {
      if (cp.stage === 'collecting' || cp.stage === 'submitted') queueTask(() => collect(cp.id));
      if (cp.stage === 'producing') await updateCp(cp.id, (c) => advanceRun(c));
      if (cp.stage === 'sending') {
        await updateCp(cp.id, (c) => {
          for (const e of c.emails) if (e.status === 'sending') Object.assign(e, { status: 'failed', error: 'Cutline was closed while sending. Press Approve & Send again (it will not be sent twice).' });
          setStage(c, 'email_review');
          c.stageNote = null;
        });
      }
    }
    await finishRuns();
    await voidPending();
  })().catch((err) => log('warn', `client projects start-up: ${err.message}`));
  const tick = () => formConfigured() && checkNow().catch(() => {});
  setTimeout(tick, 5000).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

export { cpDir, clientDir };
