import './env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { aiConfigured, generateMarketing, MARKETING_SECTIONS, MODEL } from './lib/ai.js';
import { getBusiness, PLATFORMS, publicBusinessList } from './lib/businesses.js';
import { checkFfmpeg, probe, thumbnail } from './lib/ffmpeg.js';
import { generate, rerender } from './lib/pipeline.js';
import {
  activeJobFor, createProject, deleteProject, enqueueJob, getJob, listProjects,
  loadProject, newId, projectDir, PROJECTS_DIR, saveProject,
} from './lib/store.js';
import { transcriptionConfigured } from './lib/transcribe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
// Uploaded footage and rendered clips (supports range requests for scrubbing).
app.use('/media', express.static(PROJECTS_DIR, { dotfiles: 'deny', index: false, fallthrough: false }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function requireProject(req) {
  const project = await loadProject(req.params.id);
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  return project;
}

// --- status ---------------------------------------------------------------

let ffmpegStatus = null;
app.get('/api/status', wrap(async (req, res) => {
  ffmpegStatus ??= await checkFfmpeg();
  if (!ffmpegStatus.available) ffmpegStatus = await checkFfmpeg(); // re-check until it works
  res.json({
    ai: { configured: aiConfigured(), model: MODEL },
    transcription: { configured: transcriptionConfigured() },
    ffmpeg: ffmpegStatus,
    businesses: publicBusinessList(),
    platforms: Object.values(PLATFORMS),
    marketingSections: Object.keys(MARKETING_SECTIONS),
  });
}));

// --- projects -------------------------------------------------------------

app.get('/api/projects', wrap(async (req, res) => res.json(await listProjects())));

app.post('/api/projects', wrap(async (req, res) => res.json(await createProject(req.body?.name))));

app.get('/api/projects/:id', wrap(async (req, res) => {
  const project = await requireProject(req);
  const job = activeJobFor(project.id);
  res.json({ ...project, activeJob: job ? job.id : null });
}));

app.patch('/api/projects/:id', wrap(async (req, res) => {
  const project = await requireProject(req);
  const { name, business, businessCustom, platform, marketing } = req.body || {};
  if (typeof name === 'string' && name.trim()) project.name = name.trim().slice(0, 80);
  if (typeof business === 'string') project.business = business;
  if (typeof businessCustom === 'string') project.businessCustom = businessCustom.slice(0, 80);
  if (typeof platform === 'string' && PLATFORMS[platform]) project.platform = platform;
  if (marketing && typeof marketing === 'object') project.marketing = marketing;
  res.json(await saveProject(project));
}));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  const project = await requireProject(req);
  if (activeJobFor(project.id)) throw Object.assign(new Error('Wait for the current job to finish first.'), { status: 409 });
  await deleteProject(project.id);
  res.json({ ok: true });
}));

// --- uploads --------------------------------------------------------------

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts)$/i;
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        const dir = path.join(projectDir(req.params.id), 'videos');
        await fs.mkdir(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname).toLowerCase().match(VIDEO_EXT) ? path.extname(file.originalname).toLowerCase() : '.mp4');
      cb(null, newId('v') + ext);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('video/') || VIDEO_EXT.test(file.originalname);
    cb(ok ? null : Object.assign(new Error(`"${file.originalname}" is not a video file.`), { status: 400 }), ok);
  },
});

app.post('/api/projects/:id/videos', wrap(async (req, res, next) => {
  await requireProject(req);
  upload.array('videos', 20)(req, res, async (err) => {
    if (err) return next(Object.assign(err, { status: err.status || 400 }));
    try {
      const added = [];
      const failed = [];
      for (const f of req.files || []) {
        try {
          const meta = await probe(f.path);
          if (meta.duration < 1) throw new Error('Video is shorter than 1 second.');
          const id = path.basename(f.filename, path.extname(f.filename));
          const thumb = `${id}.jpg`;
          await thumbnail(f.path, path.join(path.dirname(f.path), thumb), Math.min(1, meta.duration / 3));
          added.push({ id, name: f.originalname, file: f.filename, size: f.size, thumb, meta, uploadedAt: new Date().toISOString() });
        } catch (e) {
          await fs.rm(f.path, { force: true });
          failed.push({ name: f.originalname, error: e.message.includes('ffprobe') ? 'Could not read this video (unsupported or corrupt file).' : e.message });
        }
      }
      // Re-load after the (possibly slow) upload so we don't clobber other edits.
      const project = await loadProject(req.params.id);
      project.videos.push(...added);
      await saveProject(project);
      res.json({ added, failed, videos: project.videos });
    } catch (e) {
      next(e);
    }
  });
}));

app.delete('/api/projects/:id/videos/:videoId', wrap(async (req, res) => {
  const project = await requireProject(req);
  if (activeJobFor(project.id)) throw Object.assign(new Error('Wait for the current job to finish first.'), { status: 409 });
  const idx = project.videos.findIndex((v) => v.id === req.params.videoId);
  if (idx === -1) throw Object.assign(new Error('Video not found'), { status: 404 });
  const [v] = project.videos.splice(idx, 1);
  const dir = projectDir(project.id);
  await fs.rm(path.join(dir, 'videos', v.file), { force: true });
  await fs.rm(path.join(dir, 'videos', v.thumb), { force: true });
  await fs.rm(path.join(dir, 'work', v.id), { recursive: true, force: true });
  // Segment indexes in the old plan point at the old video order.
  if (project.plan) project.plan.stale = true;
  res.json(await saveProject(project));
}));

// --- generation -----------------------------------------------------------

app.post('/api/projects/:id/generate', wrap(async (req, res) => {
  const project = await requireProject(req);
  if (activeJobFor(project.id)) throw Object.assign(new Error('A job is already running for this project.'), { status: 409 });
  const opts = req.body || {};
  const job = enqueueJob(project.id, 'generate', (ctx) => generate(project.id, opts, ctx));
  res.json({ jobId: job.id });
}));

app.post('/api/projects/:id/clips/:index/render', wrap(async (req, res) => {
  const project = await requireProject(req);
  if (activeJobFor(project.id)) throw Object.assign(new Error('A job is already running for this project.'), { status: 409 });
  const { clip, options } = req.body || {};
  const job = enqueueJob(project.id, 'render', (ctx) => rerender(project.id, req.params.index, clip || {}, options || {}, ctx));
  res.json({ jobId: job.id });
}));

app.get('/api/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found (the server may have restarted).' });
  const { id, projectId, kind, status, stage, progress, error, code } = job;
  res.json({ id, projectId, kind, status, stage, progress, error, code });
});

// --- marketing ------------------------------------------------------------

app.post('/api/marketing', wrap(async (req, res) => {
  const { profile = {}, section, previous, footageContext, projectId } = req.body || {};
  if (section && !MARKETING_SECTIONS[section]) throw Object.assign(new Error('Unknown section'), { status: 400 });
  const business = getBusiness(profile.businessType, profile.businessCustom);
  const result = await generateMarketing({
    profile,
    business,
    section,
    previous,
    footageContext: typeof footageContext === 'string' ? footageContext.slice(0, 3000) : '',
  });

  // Keep the latest marketing pack with the project so it reopens later.
  if (projectId) {
    const project = await loadProject(projectId).catch(() => null);
    if (project) {
      const data = section ? { ...(project.marketing?.data || {}), ...result.data } : result.data;
      project.marketing = { profile, data, updatedAt: new Date().toISOString() };
      await saveProject(project);
    }
  }
  res.json({ data: result.data });
}));

// --- errors ---------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.code === 'SETUP_REQUIRED' ? 400 : 500);
  if (status >= 500) console.error(err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/media')) return res.status(status).end();
  res.status(status).json({ error: err.message || 'Something went wrong', code: err.code || null });
});

app.listen(PORT, HOST, async () => {
  const ff = await checkFfmpeg();
  console.log(`\n  Cutline is running → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  console.log(`  FFmpeg:        ${ff.available ? `ok (${ff.version})` : 'NOT FOUND — install FFmpeg to edit videos'}`);
  console.log(`  Claude AI:     ${aiConfigured() ? `ok (${MODEL})` : 'not configured — add ANTHROPIC_API_KEY to .env'}`);
  console.log(`  Transcription: ${transcriptionConfigured() ? 'ok (Whisper)' : 'off — optional, add OPENAI_API_KEY for spoken subtitles'}\n`);
});
