import './env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { aiConfigured, checkKey, getModel, MODELS } from './lib/ai.js';
import { getBusiness, PLATFORMS, publicBusinessList } from './lib/businesses.js';
import { checkFfmpeg, probe, thumbnail } from './lib/ffmpeg.js';
import { cleanProfile, generate, rerender, revise } from './lib/pipeline.js';
import { publicSettings, saveSettings } from './lib/settings.js';
import { createRequire } from 'node:module';
import { addTrack, deleteTrack, listTracks, MOODS, MUSIC_DIR, updateTrack } from './lib/music.js';
import { publicStyleList } from './lib/styles.js';
import { AD_THEMES, FORMATS } from './lib/adRender.js';
import { AD_LENGTHS, addAsset, deleteAsset, generateAds, rerenderAd, reviseAdsJob, rotateAsset, stillsFromFootage } from './lib/ads.js';
import {
  activeJobFor, createProject, DATA_DIR, deleteProject, enqueueJob, getJob, listProjects,
  loadProject, newId, projectDir, PROJECTS_DIR, updateProject,
} from './lib/store.js';
import { transcriptionConfigured } from './lib/transcribe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_VERSION = createRequire(import.meta.url)('../package.json').version;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
// Uploaded footage and rendered clips (supports range requests for scrubbing).
app.use('/media', express.static(PROJECTS_DIR, { dotfiles: 'deny', index: false, fallthrough: false }));
app.use('/music-files', express.static(MUSIC_DIR, { dotfiles: 'deny', index: false, fallthrough: false }));

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
    version: APP_VERSION,
    ai: { configured: aiConfigured(), model: getModel(), models: MODELS },
    transcription: { configured: transcriptionConfigured() },
    ffmpeg: ffmpegStatus,
    businesses: publicBusinessList(),
    platforms: Object.values(PLATFORMS),
    styles: publicStyleList(),
    moods: MOODS,
    ads: {
      themes: Object.entries(AD_THEMES).map(([id, t]) => ({ id, label: t.label, brief: t.brief, accent: t.accent, bg: t.bg })),
      formats: Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label })),
      lengths: AD_LENGTHS,
    },
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
  await requireProject(req);
  const { name, business, businessCustom, platform, profile } = req.body || {};
  res.json(await updateProject(req.params.id, (project) => {
    if (typeof name === 'string' && name.trim()) project.name = name.trim().slice(0, 80);
    if (typeof business === 'string') project.business = business;
    if (typeof businessCustom === 'string') project.businessCustom = businessCustom.slice(0, 80);
    if (typeof platform === 'string' && PLATFORMS[platform]) project.platform = platform;
    if (profile && typeof profile === 'object') project.profile = cleanProfile(profile);
  }));
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
  if (activeJobFor(req.params.id)) throw Object.assign(new Error('Wait for the current job to finish before adding videos.'), { status: 409 });
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
          await thumbnail(f.path, path.join(path.dirname(f.path), thumb), Math.min(1, meta.duration / 3), meta);
          added.push({ id, name: f.originalname, file: f.filename, size: f.size, thumb, meta, uploadedAt: new Date().toISOString() });
        } catch (e) {
          await fs.rm(f.path, { force: true });
          failed.push({ name: f.originalname, error: e.message.includes('ffprobe') ? 'Could not read this video (unsupported or corrupt file).' : e.message });
        }
      }
      // Re-load after the (possibly slow) upload so we don't clobber other edits.
      const project = await updateProject(req.params.id, (p) => {
        p.videos.push(...added);
      });
      res.json({ added, failed, videos: project.videos });
    } catch (e) {
      next(e);
    }
  });
}));

app.delete('/api/projects/:id/videos/:videoId', wrap(async (req, res) => {
  const { id } = await requireProject(req);
  if (activeJobFor(id)) throw Object.assign(new Error('Wait for the current job to finish first.'), { status: 409 });
  let removed;
  const project = await updateProject(id, (p) => {
    const idx = p.videos.findIndex((v) => v.id === req.params.videoId);
    if (idx === -1) throw Object.assign(new Error('Video not found'), { status: 404 });
    [removed] = p.videos.splice(idx, 1);
    // Segment indexes in the old plan point at the old video order.
    if (p.plan) p.plan.stale = true;
  });
  const dir = projectDir(id);
  await fs.rm(path.join(dir, 'videos', removed.file), { force: true });
  await fs.rm(path.join(dir, 'videos', removed.thumb), { force: true });
  await fs.rm(path.join(dir, 'work', removed.id), { recursive: true, force: true });
  res.json(project);
}));

// --- music library ----------------------------------------------------------

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
const musicUpload = multer({
  dest: path.join(MUSIC_DIR, '.incoming'),
  limits: { fileSize: 200 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('audio/') || AUDIO_EXT.test(file.originalname);
    cb(ok ? null : Object.assign(new Error(`"${file.originalname}" is not an audio file.`), { status: 400 }), ok);
  },
});

app.get('/api/music', wrap(async (req, res) => res.json(await listTracks())));

app.post('/api/music', (req, res, next) => {
  musicUpload.array('tracks', 10)(req, res, async (err) => {
    if (err) return next(Object.assign(err, { status: err.status || 400 }));
    const added = [];
    const failed = [];
    for (const f of req.files || []) {
      try {
        added.push(await addTrack(f.path, f.originalname));
      } catch (e) {
        await fs.rm(f.path, { force: true });
        failed.push({ name: f.originalname, error: /ffprobe|Invalid data/.test(e.message) ? 'Could not read this audio file.' : e.message });
      }
    }
    res.json({ added, failed, tracks: await listTracks() });
  });
});

app.patch('/api/music/:id', wrap(async (req, res) => res.json(await updateTrack(req.params.id, req.body || {}))));

app.delete('/api/music/:id', wrap(async (req, res) => {
  await deleteTrack(req.params.id);
  res.json({ ok: true, tracks: await listTracks() });
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

// --- animated ads -------------------------------------------------------------

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i;
const imageUpload = multer({
  dest: path.join(DATA_DIR, 'tmp'),
  limits: { fileSize: 40 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || IMAGE_EXT.test(file.originalname);
    cb(ok ? null : Object.assign(new Error(`"${file.originalname}" is not an image.`), { status: 400 }), ok);
  },
});

const noJob = (project) => {
  if (activeJobFor(project.id)) throw Object.assign(new Error('Wait for the current job to finish first.'), { status: 409 });
};

app.post('/api/projects/:id/ad-assets', wrap(async (req, res, next) => {
  const project = await requireProject(req);
  noJob(project);
  const kind = req.query.kind === 'logo' ? 'logo' : 'photo';
  imageUpload.array('images', kind === 'logo' ? 1 : 20)(req, res, async (err) => {
    if (err) return next(Object.assign(err, { status: err.status || 400 }));
    try {
      const added = [];
      const failed = [];
      for (const f of req.files || []) {
        try {
          added.push(await addAsset(project.id, f.path, f.originalname, kind));
        } catch (e) {
          failed.push({ name: f.originalname, error: e.message });
        } finally {
          await fs.rm(f.path, { force: true });
        }
      }
      let oldLogos = [];
      const updated = await updateProject(project.id, (p) => {
        p.adAssets = p.adAssets || [];
        if (kind === 'logo' && added.length) {
          oldLogos = p.adAssets.filter((a) => a.kind === 'logo');
          p.adAssets = p.adAssets.filter((a) => a.kind !== 'logo');
        }
        p.adAssets.push(...added);
      });
      for (const a of oldLogos) {
        for (const f of [a.file, a.thumb]) await fs.rm(path.join(projectDir(project.id), 'ad-assets', f), { force: true });
      }
      res.json({ added, failed, adAssets: updated.adAssets });
    } catch (e) {
      next(e);
    }
  });
}));

app.post('/api/projects/:id/ad-assets/stills', wrap(async (req, res) => {
  const project = await requireProject(req);
  noJob(project);
  res.json(await stillsFromFootage(project.id, Math.max(1, Math.min(10, Number(req.body?.count) || 6))));
}));

app.post('/api/projects/:id/ad-assets/:assetId/rotate', wrap(async (req, res) => {
  const project = await requireProject(req);
  noJob(project);
  res.json(await rotateAsset(project.id, req.params.assetId));
}));

app.delete('/api/projects/:id/ad-assets/:assetId', wrap(async (req, res) => {
  const project = await requireProject(req);
  noJob(project);
  res.json(await deleteAsset(project.id, req.params.assetId));
}));

app.post('/api/projects/:id/ads/generate', wrap(async (req, res) => {
  const project = await requireProject(req);
  noJob(project);
  const opts = req.body || {};
  const job = enqueueJob(project.id, 'ads', (ctx) => generateAds(project.id, opts, ctx));
  res.json({ jobId: job.id });
}));

app.post('/api/projects/:id/ads/revise', wrap(async (req, res) => {
  const project = await requireProject(req);
  if (!project.adPlan) throw Object.assign(new Error('Make ads first, then ask for changes.'), { status: 400 });
  noJob(project);
  const request = String(req.body?.request || '').trim();
  if (!request) throw Object.assign(new Error('Type what you want changed.'), { status: 400 });
  const adIndex = Number.isInteger(req.body?.adIndex) ? req.body.adIndex : null;
  const mode = req.body?.mode === 'auto' ? 'auto' : 'ai';
  const job = enqueueJob(project.id, 'ads-revise', (ctx) => reviseAdsJob(project.id, { request, adIndex, mode }, ctx));
  res.json({ jobId: job.id });
}));

app.post('/api/projects/:id/ads/:index/render', wrap(async (req, res) => {
  const project = await requireProject(req);
  noJob(project);
  if (!project.adPlan?.ads?.[Number(req.params.index)]) throw Object.assign(new Error('Ad not found'), { status: 404 });
  const job = enqueueJob(project.id, 'ad-render', (ctx) => rerenderAd(project.id, req.params.index, req.body?.ad || {}, ctx));
  res.json({ jobId: job.id });
}));

// --- ask for changes --------------------------------------------------------

app.post('/api/projects/:id/revise', wrap(async (req, res) => {
  const project = await requireProject(req);
  if (!project.plan) throw Object.assign(new Error('Generate clips first, then ask for changes.'), { status: 400 });
  if (activeJobFor(project.id)) throw Object.assign(new Error('Wait for the current job to finish first.'), { status: 409 });
  const request = String(req.body?.request || '').trim();
  if (!request) throw Object.assign(new Error('Type what you want changed.'), { status: 400 });
  const clipIndex = Number.isInteger(req.body?.clipIndex) ? req.body.clipIndex : null;
  const mode = req.body?.mode === 'auto' ? 'auto' : 'ai';
  const job = enqueueJob(project.id, 'revise', (ctx) => revise(project.id, { request, clipIndex, mode }, ctx));
  res.json({ jobId: job.id });
}));

// --- settings (this computer only) --------------------------------------------

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

app.get('/api/settings', (req, res) => res.json({ ...publicSettings(), editable: isLocal(req) }));

app.post('/api/settings', wrap(async (req, res) => {
  if (!isLocal(req)) throw Object.assign(new Error('Settings can only be changed on the computer running Cutline.'), { status: 403 });
  const b = req.body || {};
  const updates = {};
  if (typeof b.anthropicKey === 'string') updates.ANTHROPIC_API_KEY = b.anthropicKey;
  if (typeof b.openaiKey === 'string') updates.OPENAI_API_KEY = b.openaiKey;
  if (typeof b.model === 'string') {
    if (b.model && !MODELS[b.model]) throw Object.assign(new Error('Unknown model'), { status: 400 });
    updates.CLAUDE_MODEL = b.model;
  }
  res.json(await saveSettings(updates));
}));

app.post('/api/settings/check', wrap(async (req, res) => {
  if (!aiConfigured()) return res.json({ ok: false, message: 'No Claude key saved yet.' });
  res.json(await checkKey());
}));

// --- errors ---------------------------------------------------------------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.code === 'SETUP_REQUIRED' ? 400 : 500);
  if (status >= 500) console.error(err);
  if (res.headersSent) return next(err);
  if (/^\/(media|music-files)\//.test(req.originalUrl)) return res.status(status).end();
  res.status(status).json({ error: err.message || 'Something went wrong', code: err.code || null });
});

const server = app.listen(PORT, HOST, async () => {
  console.log(`\n  Cutline is running → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  const ff = await checkFfmpeg();
  console.log(`  FFmpeg:        ${ff.available ? `ok (${ff.version})` : 'NOT FOUND — install FFmpeg to edit videos'}`);
  console.log(`  Claude AI:     ${aiConfigured() ? `ok (${getModel()})` : 'off: add your key on the Settings page'}`);
  console.log(`  Transcription: ${transcriptionConfigured() ? 'ok (Whisper)' : 'off — optional, add OPENAI_API_KEY for spoken subtitles'}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — Cutline is probably already running in another Terminal window.`);
    console.error(`  Open http://127.0.0.1:${PORT} in your browser, or close the other window and run npm start again.\n`);
  } else {
    console.error('\n  Cutline could not start:', err.message, '\n');
  }
  process.exit(1);
});
