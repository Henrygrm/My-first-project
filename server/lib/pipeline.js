import fs from 'node:fs/promises';
import path from 'node:path';
import { aiConfigured, planEdit, reviseEdit, SetupError } from './ai.js';
import { getBusiness, getPlatform } from './businesses.js';
import { parseRequest } from './commands.js';
import { analyzeSignals, frameAt, pool } from './ffmpeg.js';
import { autoPlan, clipDuration, fitLength, makeRng, normalizeAiPlan, sanitizeClip } from './planner.js';
import { MOODS, MUSIC_DIR, getTrack, listTracks, pickTrack } from './music.js';
import { STYLE_IDS, getStyle, stylesForClips } from './styles.js';
import { renderClip } from './render.js';
import { loadProject, projectDir, updateProject } from './store.js';
import { transcribe, transcriptionConfigured } from './transcribe.js';

// Claude accepts at most 100 images per request; stay well under it.
const MAX_FRAMES = Math.min(90, Number(process.env.AI_MAX_FRAMES || 40));
const PROFILE_FIELDS = ['name', 'services', 'location', 'offer', 'audience', 'notes'];

export function cleanProfile(p = {}) {
  return Object.fromEntries(PROFILE_FIELDS.map((k) => [k, String(p[k] || '').trim().slice(0, 300)]));
}

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

/**
 * Gain that brings a video's own sound to a consistent level (~-20 dB RMS
 * while something is audible), so loud phone audio doesn't drown the music
 * and quiet audio isn't lost.
 */
export function audioGain(signals) {
  const active = (signals?.loudness || []).filter((db) => db !== null && db > -55);
  if (!active.length) return 1;
  const mean = 20 * Math.log10(active.reduce((s, db) => s + 10 ** (db / 20), 0) / active.length);
  return Math.min(4, Math.max(0.25, 10 ** ((-20 - mean) / 20)));
}

/** Measure footage (cached) and optionally sample frames for Claude. */
async function prepareVideos(project, ctx, { frames = false, transcripts = false } = {}) {
  const videos = videoCtx(project);
  for (const [i, v] of videos.entries()) {
    await fs.mkdir(v.work, { recursive: true });
    ctx?.stage(`Analysing footage (${i + 1}/${videos.length})`, 0.02 + (0.16 * i) / videos.length);
    v.signals = await ensureSignals(v);
    v.audioGain = audioGain(v.signals);
  }
  const speech = {};
  if (transcripts && transcriptionConfigured()) {
    for (const [i, v] of videos.entries()) {
      if (!v.meta.hasAudio) continue;
      ctx?.stage(`Transcribing speech (${i + 1}/${videos.length})`, 0.2);
      try {
        const t = await ensureTranscript(v);
        if (t) {
          speech[i] = t;
          v.transcript = t;
        }
      } catch (err) {
        // Only fatal when spoken subtitles were asked for; otherwise it's extra context.
        if (transcripts === 'required') throw err;
      }
    }
  }
  if (frames) {
    const times = frameTimes(videos);
    ctx?.stage(`Picking ${times.flat().length} frames for the AI to look at`, 0.26);
    await pool(videos.flatMap((v, vi) => times[vi].map((t) => ({ v, t }))), 4, async ({ v, t }) => {
      const out = path.join(v.work, `frame-${t.toFixed(1)}.jpg`);
      await fs.access(out).catch(() => frameAt(v.path, t, out, 512, v.meta));
    });
    videos.forEach((v, vi) => {
      v.frames = times[vi].map((t) => ({ t, path: path.join(v.work, `frame-${t.toFixed(1)}.jpg`) }));
    });
  }
  return { videos, speech };
}

export function renderOptions(opts) {
  return {
    reframe: ['auto', 'fill', 'fit'].includes(opts.reframe) ? opts.reframe : 'auto',
    audio: opts.audio === 'mute' ? 'mute' : 'original',
    onScreenText: opts.onScreenText !== false,
    speechSubtitles: Boolean(opts.speechSubtitles),
    musicLevel: ['soft', 'normal', 'loud'].includes(opts.musicLevel) ? opts.musicLevel : 'normal',
  };
}

async function renderAll(projectId, videos, plan, indexes, ropts, transcripts, ctx, base = 0.55) {
  const outDir = path.join(projectDir(projectId), 'output');
  const span = 1 - base;
  for (const [n, idx] of indexes.entries()) {
    const clip = plan.clips[idx];
    ctx.stage(`Rendering clip ${n + 1} of ${indexes.length}: "${clip.title}"`, base + (span * n) / indexes.length);
    const track = clip.music?.id ? await getTrack(clip.music.id) : null;
    const music = track ? { path: path.join(MUSIC_DIR, track.file), startAt: track.startAt, loudness: track.loudness } : null;
    const result = await renderClip(clip, videos, {
      outDir,
      music,
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

/** Attach music (cuts on its beat) and fit the clip to its length. */
function withMusic(clip, track, videos, platform, target) {
  const fitted = fitLength(clip, target, videos, track, platform.maxSeconds);
  return {
    ...fitted,
    targetSeconds: target,
    music: track ? { id: track.id, name: track.name, bpm: track.bpm } : null,
    estDuration: Math.round(clipDuration(fitted) * 10) / 10,
  };
}

function addChat(p, who, text) {
  p.chat = [...(p.chat || []), { who, text, at: new Date().toISOString() }].slice(-60);
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

export async function generate(projectId, opts, ctx) {
  const project = await loadProject(projectId);
  if (!project) throw new Error('Project not found');
  if (!project.videos.length) throw new Error('Upload at least one video first.');

  const business = getBusiness(opts.business, opts.businessCustom);
  const profile = cleanProfile(opts.profile);
  const platform = getPlatform(opts.platform);
  const clipCount = Math.max(1, Math.min(4, Number(opts.clipCount) || 2));
  const targetSeconds = Math.max(8, Math.min(platform.maxSeconds, Number(opts.targetSeconds) || 30));
  const ropts = renderOptions(opts);
  const mode = opts.mode === 'auto' ? 'auto' : 'ai';
  const rng = makeRng();
  const styleChoice = STYLE_IDS.includes(opts.style) ? opts.style : 'mix';
  const suggested = stylesForClips(styleChoice === 'mix' ? null : styleChoice, clipCount, business.id, rng);
  const musicChoice = opts.music || 'auto';
  const tracks = await listTracks();
  const hasMusic = musicChoice !== 'none' && tracks.length > 0;

  if (mode === 'ai' && !aiConfigured()) {
    throw new SetupError('The AI needs a Claude API key. Add it on the Settings page, or switch the engine to Free auto-edit there.');
  }
  if (ropts.speechSubtitles && !transcriptionConfigured()) {
    throw new SetupError('Spoken subtitles need an OpenAI key. Add it on the Settings page or turn spoken subtitles off.');
  }

  const { videos, speech } = await prepareVideos(project, ctx, { frames: mode === 'ai', transcripts: ropts.speechSubtitles ? 'required' : mode === 'ai' });

  let plan;
  if (mode === 'ai') {
    ctx.stage(`The AI is planning ${clipCount} clip${clipCount > 1 ? 's' : ''} for ${profile.name || business.label}…`, 0.3);
    // The API call gives no progress, so creep the bar while we wait.
    let p = 0.3;
    const ticker = setInterval(() => ctx.progress((p = Math.min(0.52, p + 0.004))), 1000);
    let res;
    try {
      res = await planEdit({
        videos, business, profile, platform, clipCount, targetSeconds, hasMusic,
        instructions: (opts.instructions || '').slice(0, 2000),
        // "Mix": the AI picks the best style for each clip itself.
        styles: styleChoice === 'mix' ? null : suggested,
      });
    } finally {
      clearInterval(ticker);
    }
    plan = normalizeAiPlan(res.data, videos, platform, suggested);
    plan.model = res.model;
    if (styleChoice !== 'mix') plan.clips.forEach((c) => (c.style = styleChoice));
  } else {
    ctx.stage('Choosing the best moments from motion and sound', 0.4);
    plan = autoPlan({ videos, business, profile, platform, clipCount, targetSeconds, styles: suggested, rng });
  }

  // Music: a track per clip (varied, matched to the clip's mood) with every
  // cut on its beat, then fit each clip to the chosen length.
  const used = [];
  for (const [i, clip] of plan.clips.entries()) {
    let track = null;
    if (musicChoice === 'auto') track = await pickTrack(MOODS.includes(clip.music_mood) ? clip.music_mood : getStyle(clip.style).mood, used, rng);
    else if (musicChoice !== 'none') track = await getTrack(musicChoice);
    if (track) used.push(track.id);
    plan.clips[i] = withMusic(clip, track, videos, platform, targetSeconds);
  }
  if (musicChoice !== 'none' && !hasMusic) plan.musicNote = 'No music: your music library is empty. Add songs on the Music page, then generate again.';

  Object.assign(plan, { createdAt: new Date().toISOString(), business: business.id, businessLabel: business.label, platform: platform.id, targetSeconds });

  await fs.rm(path.join(projectDir(projectId), 'output'), { recursive: true, force: true });
  await updateProject(projectId, (p) => {
    Object.assign(p, {
      plan,
      clips: [],
      business: business.id,
      businessCustom: opts.businessCustom || '',
      profile,
      platform: platform.id,
      instructions: opts.instructions || '',
      settings: { ...ropts, clipCount, targetSeconds, mode, style: styleChoice, music: musicChoice },
    });
    addChat(p, 'cutline', mode === 'ai'
      ? `Made ${plan.clips.length} clip${plan.clips.length > 1 ? 's' : ''}. ${plan.strategy || ''}`.trim()
      : `Made ${plan.clips.length} clip${plan.clips.length > 1 ? 's' : ''} with free auto-edit (no AI).`);
  });

  if (opts.render !== false) {
    await renderAll(projectId, videos, plan, plan.clips.map((_, i) => i), ropts, speech, ctx);
  }
  return { projectId };
}

// ---------------------------------------------------------------------------
// Manual edits (Edit panel) → re-render one clip
// ---------------------------------------------------------------------------

export async function rerender(projectId, clipIndex, editedClip, opts, ctx) {
  const project = await loadProject(projectId);
  if (!project?.plan) throw new Error('Generate clips first.');
  const idx = Number(clipIndex);
  if (!project.plan.clips[idx]) throw new Error('Clip not found');

  const { videos, speech } = await prepareVideos(project, null, { transcripts: project.settings?.speechSubtitles ? 'required' : false });
  const platform = getPlatform(project.plan.platform);
  const { music: musicEdit, ...edits } = editedClip;
  const old = project.plan.clips[idx];
  let clip = sanitizeClip({ ...old, ...edits }, videos, platform.maxSeconds);
  if (!clip.segments.length) throw new Error('This clip has no shots left to render.');
  // Music can be changed per clip ('none' or a track id); cuts re-snap to its beat.
  const trackId = musicEdit === undefined ? clip.music?.id : musicEdit === 'none' ? null : musicEdit;
  clip = withMusic(clip, trackId ? await getTrack(trackId) : null, videos, platform, old.targetSeconds || project.plan.targetSeconds || 30);
  const ropts = renderOptions({ ...project.settings, ...opts });
  const saved = await updateProject(projectId, (p) => {
    if (!p.plan?.clips[idx]) throw new Error('Clip not found');
    p.plan.clips[idx] = clip;
    p.settings = { ...p.settings, musicLevel: ropts.musicLevel };
  });
  await renderAll(projectId, videos, saved.plan, [idx], ropts, speech, ctx, 0.05);
  return { projectId };
}

// ---------------------------------------------------------------------------
// "Ask for changes"
// ---------------------------------------------------------------------------

const toZero = (s) => ({
  ...s,
  video: Math.round(Number(s.video)) - 1,
  ...(s.compare_video ? { compare_video: Math.round(Number(s.compare_video)) - 1 } : {}),
});

function findTrack(tracks, name) {
  const n = String(name || '').toLowerCase().trim();
  return tracks.find((t) => t.name.toLowerCase() === n) || tracks.find((t) => n && (t.name.toLowerCase().includes(n) || n.includes(t.name.toLowerCase()))) || null;
}

export async function revise(projectId, { request, clipIndex }, ctx) {
  const project = await loadProject(projectId);
  if (!project?.plan) throw new Error('Generate clips first, then ask for changes.');
  const text = String(request || '').trim().slice(0, 1000);
  if (!text) throw new Error('Type what you want changed.');
  const focus = Number.isInteger(clipIndex) && project.plan.clips[clipIndex] ? clipIndex : null;

  await updateProject(projectId, (p) => addChat(p, 'you', focus !== null ? `Clip ${focus + 1}: ${text}` : text));

  const plan = project.plan;
  const platform = getPlatform(plan.platform);
  const business = getBusiness(plan.business, project.businessCustom);
  const profile = cleanProfile(project.profile);
  const tracks = await listTracks();
  const useAi = aiConfigured() && project.settings?.mode !== 'auto';
  const { videos, speech } = await prepareVideos(project, ctx, { frames: useAi, transcripts: project.settings?.speechSubtitles ? 'required' : useAi });
  let ropts = renderOptions(project.settings || {});
  const newClips = plan.clips.map((c) => ({ ...c }));
  const changed = [];
  let reply;

  if (useAi) {
    ctx.stage('The AI is working on your changes…', 0.3);
    let p = 0.3;
    const ticker = setInterval(() => ctx.progress((p = Math.min(0.5, p + 0.004))), 1000);
    let res;
    try {
      res = await reviseEdit({ videos, business, profile, platform, plan, request: text, clipNumber: focus !== null ? focus + 1 : null, tracks, hasMusic: tracks.length > 0 });
    } finally {
      clearInterval(ticker);
    }
    reply = res.data.reply;
    for (const item of res.data.clips || []) {
      const i = Math.round(Number(item.clip_number)) - 1;
      if (!item.changed || !newClips[i]) continue;
      const old = newClips[i];
      const { clip_number: _n, changed: _c, target_seconds: targetSecs, music_track: musicName, ...fields } = item;
      let clip = sanitizeClip({ ...old, ...fields, segments: (fields.segments || []).map(toZero) }, videos, platform.maxSeconds);
      if (!clip.segments.length) continue;
      const target = Math.max(8, Math.min(platform.maxSeconds, Number(targetSecs) || old.targetSeconds || plan.targetSeconds));
      let track = old.music?.id ? await getTrack(old.music.id) : null;
      if (musicName === 'none') track = null;
      else if (musicName && musicName !== 'keep') track = findTrack(tracks, musicName) || track;
      newClips[i] = withMusic(clip, track, videos, platform, target);
      changed.push(i);
    }
  } else {
    const cmd = parseRequest(text, plan, tracks);
    reply = cmd.reply;
    if (cmd.understood) {
      const p = cmd.patch;
      if (cmd.musicLevel) ropts = { ...ropts, musicLevel: cmd.musicLevel };
      if (cmd.audio) ropts = { ...ropts, audio: cmd.audio };
      const indexes = focus !== null && cmd.clipIndexes.length === plan.clips.length ? [focus] : cmd.clipIndexes;
      for (const i of indexes) {
        const old = newClips[i];
        let clip = { ...old, segments: old.segments.map((s) => ({ ...s })) };
        if (cmd.regenerate || p.style) {
          // Re-cut this clip from the footage in the requested (or same) style.
          const fresh = autoPlan({ videos, business, profile, platform, clipCount: 1, targetSeconds: old.targetSeconds || plan.targetSeconds, styles: [p.style || old.style], rng: makeRng() }).clips[0];
          clip = { ...fresh, title: old.title.replace(/^[^\d]*/, `${getStyle(fresh.style).label} `) };
        }
        if (p.hook_text !== undefined) clip.hook_text = p.hook_text;
        if (p.cta_text !== undefined) clip.cta_text = p.cta_text;
        if (p.noText) {
          clip.hook_text = '';
          clip.cta_text = '';
          clip.segments = clip.segments.map((s) => ({ ...s, caption: '' }));
        } else if (p.noCaptions) clip.segments = clip.segments.map((s) => ({ ...s, caption: '' }));
        let target = old.targetSeconds || plan.targetSeconds;
        if (p.targetSeconds) target = p.targetSeconds;
        if (p.targetDelta) target += p.targetDelta;
        target = Math.max(8, Math.min(platform.maxSeconds, target));
        let track = old.music?.id ? await getTrack(old.music.id) : null;
        if (cmd.musicTrack === null) track = null;
        else if (cmd.musicTrack === 'next' && tracks.length) {
          const at = tracks.findIndex((t) => t.id === old.music?.id);
          track = tracks[(at + 1) % tracks.length];
        } else if (cmd.musicTrack) track = await getTrack(cmd.musicTrack);
        clip = sanitizeClip(clip, videos, platform.maxSeconds);
        newClips[i] = withMusic(clip, track, videos, platform, target);
        changed.push(i);
      }
    }
  }

  const saved = await updateProject(projectId, (p) => {
    for (const i of changed) p.plan.clips[i] = newClips[i];
    p.settings = { ...p.settings, musicLevel: ropts.musicLevel, audio: ropts.audio };
    addChat(p, 'cutline', changed.length ? reply : reply || 'Nothing needed changing.');
  });
  if (changed.length) await renderAll(projectId, videos, saved.plan, changed, ropts, speech, ctx, 0.55);
  return { projectId, changed, reply };
}
