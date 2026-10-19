import fs from 'node:fs/promises';
import path from 'node:path';
import { aiConfigured, planEdit, SetupError } from './ai.js';
import { getBusiness, getPlatform } from './businesses.js';
import { analyzeSignals, frameAt, pool } from './ffmpeg.js';
import { autoPlan, normalizeAiPlan, sanitizeClip } from './planner.js';
import { renderClip } from './render.js';
import { loadProject, projectDir, updateProject } from './store.js';
import { transcribe, transcriptionConfigured } from './transcribe.js';

// Claude accepts at most 100 images per request; stay well under it.
const MAX_FRAMES = Math.min(90, Number(process.env.AI_MAX_FRAMES || 40));

function videoCtx(project) {
  const dir = projectDir(project.id);
  return project.videos.map((v) => ({
    ...v,
    path: path.join(dir, 'videos', v.file),
    work: path.join(dir, 'work', v.id),
  }));
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function ensureSignals(v) {
  const cache = path.join(v.work, 'signals.json');
  const cached = await readJson(cache);
  if (cached?.version === 2) return cached;
  const signals = await analyzeSignals(v.path, v.meta, v.work);
  await fs.writeFile(cache, JSON.stringify(signals));
  return signals;
}

async function ensureTranscript(v) {
  const cache = path.join(v.work, 'transcript.json');
  const cached = await readJson(cache);
  if (cached) return cached;
  const t = await transcribe(v.path, v.work);
  if (t) await fs.writeFile(cache, JSON.stringify(t));
  return t;
}

/** Spread the frame budget across videos in proportion to their length. */
function frameTimes(videos) {
  const total = videos.reduce((s, v) => s + v.meta.duration, 0) || 1;
  const minEach = Math.max(1, Math.min(3, Math.floor(MAX_FRAMES / videos.length)));
  return videos.map((v) => {
    const d = v.meta.duration;
    const share = Math.round((MAX_FRAMES * d) / total);
    const n = Math.max(minEach, Math.min(share, Math.floor(d / 1.0)));
    return Array.from({ length: Math.max(1, n) }, (_, j) => Math.round(((j + 0.5) * d * 10) / n) / 10);
  });
}

function renderOptions(opts) {
  return {
    reframe: ['auto', 'fill', 'fit'].includes(opts.reframe) ? opts.reframe : 'auto',
    audio: opts.audio === 'mute' ? 'mute' : 'original',
    onScreenText: opts.onScreenText !== false,
    speechSubtitles: Boolean(opts.speechSubtitles),
  };
}

async function renderAll(projectId, videos, plan, indexes, ropts, transcripts, ctx, base = 0.55) {
  const outDir = path.join(projectDir(projectId), 'output');
  const span = 1 - base;
  for (const [n, idx] of indexes.entries()) {
    const clip = plan.clips[idx];
    ctx.stage(`Rendering clip ${n + 1} of ${indexes.length}: "${clip.title}"`, base + (span * n) / indexes.length);
    const result = await renderClip(clip, videos, {
      outDir,
      baseName: `clip-${idx + 1}-${Date.now().toString(36)}`,
      ...ropts,
      transcripts: ropts.speechSubtitles ? transcripts : null,
      onProgress: (p) => ctx.progress(base + (span * (n + p)) / indexes.length),
    });
    await updateProject(projectId, (p) => {
      p.clips[idx] = { ...result, renderedAt: new Date().toISOString(), options: ropts };
    });
    // Remove earlier renders of this clip, including half-written files left
    // behind if the server was stopped mid-render.
    const keep = path.parse(result.file).name;
    for (const f of await fs.readdir(outDir)) {
      if (f.startsWith(`clip-${idx + 1}-`) && path.parse(f).name !== keep) await fs.rm(path.join(outDir, f), { force: true });
    }
  }
}

export async function generate(projectId, opts, ctx) {
  const project = await loadProject(projectId);
  if (!project) throw new Error('Project not found');
  if (!project.videos.length) throw new Error('Upload at least one video first.');

  const business = getBusiness(opts.business, opts.businessCustom);
  const platform = getPlatform(opts.platform);
  const clipCount = Math.max(1, Math.min(4, Number(opts.clipCount) || 2));
  const targetSeconds = Math.max(8, Math.min(platform.maxSeconds, Number(opts.targetSeconds) || 30));
  const ropts = renderOptions(opts);
  const mode = opts.mode === 'auto' ? 'auto' : 'ai';

  if (mode === 'ai' && !aiConfigured()) {
    throw new SetupError('AI editing needs a Claude API key. Add ANTHROPIC_API_KEY to .env and restart, or switch to Auto-edit (no AI).');
  }

  const videos = videoCtx(project);
  for (const v of videos) await fs.mkdir(v.work, { recursive: true });

  // 1. Measure the footage.
  for (const [i, v] of videos.entries()) {
    ctx.stage(`Analysing footage: motion, cuts and audio (${i + 1}/${videos.length})`, 0.02 + (0.18 * i) / videos.length);
    v.signals = await ensureSignals(v);
  }

  // 2. Optional speech transcription.
  const transcripts = {};
  if (ropts.speechSubtitles || mode === 'ai') {
    if (transcriptionConfigured()) {
      for (const [i, v] of videos.entries()) {
        if (!v.meta.hasAudio) continue;
        ctx.stage(`Transcribing speech (${i + 1}/${videos.length})`, 0.2 + (0.08 * i) / videos.length);
        try {
          const t = await ensureTranscript(v);
          if (t) {
            transcripts[i] = t;
            v.transcript = t;
          }
        } catch (err) {
          if (ropts.speechSubtitles) throw err;
        }
      }
    } else if (ropts.speechSubtitles) {
      throw new SetupError('Spoken subtitles need OPENAI_API_KEY (Whisper transcription) in .env. Turn the option off or add the key.');
    }
  }

  // 3. Plan the edit.
  let plan;
  if (mode === 'ai') {
    const times = frameTimes(videos);
    const totalFrames = times.flat().length;
    ctx.stage(`Sampling ${totalFrames} frames for Claude to review`, 0.28);
    await pool(videos.flatMap((v, vi) => times[vi].map((t) => ({ v, t }))), 4, async ({ v, t }) => {
      const out = path.join(v.work, `frame-${t.toFixed(1)}.jpg`);
      await fs.access(out).catch(() => frameAt(v.path, t, out, 512, v.meta));
    });
    videos.forEach((v, vi) => {
      v.frames = times[vi].map((t) => ({ t, path: path.join(v.work, `frame-${t.toFixed(1)}.jpg`) }));
    });

    ctx.stage(`Claude is reviewing ${totalFrames} frames and planning ${clipCount} clip${clipCount > 1 ? 's' : ''}…`, 0.32);
    // The API call gives no progress, so creep the bar while we wait.
    let p = 0.32;
    const ticker = setInterval(() => ctx.progress((p = Math.min(0.52, p + 0.004))), 1000);
    let res;
    try {
      res = await planEdit({ videos, business, platform, instructions: (opts.instructions || '').slice(0, 2000), clipCount, targetSeconds });
    } finally {
      clearInterval(ticker);
    }
    plan = normalizeAiPlan(res.data, videos, platform);
    plan.model = res.model;
  } else {
    ctx.stage('Choosing the best moments from motion and audio levels', 0.4);
    plan = autoPlan({ videos, business, platform, clipCount, targetSeconds });
  }

  plan.createdAt = new Date().toISOString();
  plan.business = business.id;
  plan.businessLabel = business.label;
  plan.platform = platform.id;
  plan.targetSeconds = targetSeconds;

  // Old renders no longer match the new plan.
  await fs.rm(path.join(projectDir(projectId), 'output'), { recursive: true, force: true });
  await updateProject(projectId, (p) => {
    Object.assign(p, {
      plan,
      clips: [],
      business: business.id,
      businessCustom: opts.businessCustom || '',
      platform: platform.id,
      instructions: opts.instructions || '',
      settings: { ...ropts, clipCount, targetSeconds, mode },
    });
  });

  // 4. Render.
  if (opts.render !== false) {
    await renderAll(projectId, videos, plan, plan.clips.map((_, i) => i), ropts, transcripts, ctx);
  }
  return { projectId };
}

/** Re-render a single clip after the user edited its text or segments. */
export async function rerender(projectId, clipIndex, editedClip, opts, ctx) {
  const project = await loadProject(projectId);
  if (!project?.plan) throw new Error('Generate a plan first.');
  const idx = Number(clipIndex);
  if (!project.plan.clips[idx]) throw new Error('Clip not found');

  const videos = videoCtx(project);
  const platform = getPlatform(project.plan.platform);
  const merged = { ...project.plan.clips[idx], ...editedClip };
  const clip = sanitizeClip(merged, videos, platform.maxSeconds);
  if (!clip.segments.length) throw new Error('This clip has no segments left to render.');
  const ropts = renderOptions({ ...project.settings, ...opts });
  const transcripts = {};
  if (ropts.speechSubtitles) {
    for (const [i, v] of videos.entries()) {
      const t = await readJson(path.join(v.work, 'transcript.json'));
      if (t) transcripts[i] = t;
    }
  }
  const saved = await updateProject(projectId, (p) => {
    if (!p.plan?.clips[idx]) throw new Error('Clip not found');
    p.plan.clips[idx] = clip;
  });
  await renderAll(projectId, videos, saved.plan, [idx], ropts, transcripts, ctx, 0.05);
  return { projectId };
}
