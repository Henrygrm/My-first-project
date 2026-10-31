// Ads: media (photos, logo, cut-outs, footage), creative direction (Claude or
// free mode), the motion engine, rendering, versions and change requests.
// Ads live in the same project as the clips.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { buildPalette, isChromatic } from '../../public/engine/brand.js';
import { compose, FORMATS } from '../../public/engine/compose.js';
import { renderFrame } from '../../public/engine/compositor.js';
import { RECIPES } from '../../public/engine/recipes.js';
import { DIRECTIONS, getDirection } from '../../public/engine/styles.js';
import { aiConfigured, planAdBoards, reviewAdFrames, reviseAdBoards, SetupError } from './ai.js';
import { analyzeImage, logoNeedsPlate } from './analyze.js';
import { getBusiness } from './businesses.js';
import { cutout, cutoutsAvailable } from './cutout.js';
import { adDefaults, mediaSummary, normalizeBoard, OBJECTIVES, planFree } from './director.js';
import { loadAssets, makeEnv, registerFonts } from './engine/node.js';
import { renderComposition } from './engine/render.js';
import { FFMPEG, frameAt, run } from './ffmpeg.js';
import { log } from './log.js';
import { findTrack, getTrack, listTracks, MUSIC_DIR, pickTrack } from './music.js';
import { cleanProfile } from './pipeline.js';
import { checkRender } from './qa.js';
import { loadProject, newId, projectDir, updateProject } from './store.js';
import { speak, voiceConfigured } from '../providers/tts.js';

export const AD_LENGTHS = [10, 15, 20, 30];
const MAX_VERSIONS = 6;
const assetDir = (projectId) => path.join(projectDir(projectId), 'ad-assets');
const outDir = (projectId) => path.join(projectDir(projectId), 'ad-output');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------------------
// Media: photos and logo
// ---------------------------------------------------------------------------

/** Convert an uploaded image (JPG, PNG, WebP, HEIC…) to a web-friendly file plus a thumbnail, and analyse it. */
export async function addAsset(projectId, tmpPath, originalName, kind) {
  return convertImage(assetDir(projectId), tmpPath, originalName, kind);
}

/** The same conversion into any folder (client media libraries use it too). */
export async function convertImage(dir, tmpPath, originalName, kind) {
  await fs.mkdir(dir, { recursive: true });
  const id = newId('i');
  const isLogo = kind === 'logo';
  const file = `${id}.${isLogo ? 'png' : 'jpg'}`;
  const thumb = `${id}-t.${isLogo ? 'png' : 'jpg'}`;
  const big = isLogo ? "scale='min(1200,iw)':-2" : "scale='if(gt(iw,ih),min(2400,iw),-2)':'if(gt(iw,ih),-2,min(2400,ih))'";
  const small = "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'";
  try {
    await run(FFMPEG, ['-y', '-v', 'error', '-i', tmpPath, '-frames:v', '1', '-vf', big, ...(isLogo ? [] : ['-q:v', '3']), path.join(dir, file)]);
    await run(FFMPEG, ['-y', '-v', 'error', '-i', path.join(dir, file), '-frames:v', '1', '-vf', small, ...(isLogo ? [] : ['-q:v', '5']), path.join(dir, thumb)]);
  } catch {
    await fs.rm(path.join(dir, file), { force: true });
    throw new Error("Couldn't read this image. Save it as a JPG or PNG and try again.");
  }
  let analysis = null;
  try {
    analysis = await analyzeImage(path.join(dir, file), { kind: isLogo ? 'logo' : 'photo' });
  } catch (err) {
    log('warn', `analysis failed for ${file}:`, err.message);
  }
  return { id, file, thumb, name: String(originalName || 'image').slice(0, 120), kind: isLogo ? 'logo' : 'photo', analysis, addedAt: new Date().toISOString() };
}

/** Rotate a photo 90° clockwise (phone photos that come in sideways). Its cut-out is redone. */
export async function rotateAsset(projectId, assetId) {
  const project = await loadProject(projectId);
  const a = project?.adAssets?.find((x) => x.id === assetId);
  if (!a) throw Object.assign(new Error('Image not found'), { status: 404 });
  const dir = assetDir(projectId);
  for (const f of [a.file, a.thumb]) {
    const tmp = path.join(dir, `rot-${f}`);
    await run(FFMPEG, ['-y', '-v', 'error', '-i', path.join(dir, f), '-frames:v', '1', '-vf', 'transpose=1', ...(f.endsWith('.jpg') ? ['-q:v', '3'] : []), tmp]);
    await fs.rename(tmp, path.join(dir, f));
  }
  if (a.cut?.file) await fs.rm(path.join(dir, a.cut.file), { force: true });
  const analysis = await analyzeImage(path.join(dir, a.file), { kind: a.kind }).catch(() => a.analysis);
  return updateProject(projectId, (p) => {
    const x = p.adAssets.find((y) => y.id === assetId);
    if (x) Object.assign(x, { rev: (x.rev || 0) + 1, cut: null, analysis });
  });
}

export async function deleteAsset(projectId, assetId) {
  let removed;
  const project = await updateProject(projectId, (p) => {
    const i = (p.adAssets || []).findIndex((x) => x.id === assetId);
    if (i < 0) throw Object.assign(new Error('Image not found'), { status: 404 });
    [removed] = p.adAssets.splice(i, 1);
  });
  for (const f of [removed.file, removed.thumb, removed.cut?.file].filter(Boolean)) await fs.rm(path.join(assetDir(projectId), f), { force: true });
  return project;
}

/** Take sharp, bright stills from the project's videos to use as ad photos. */
export async function stillsFromFootage(projectId, want = 6) {
  const project = await loadProject(projectId);
  if (!project?.videos?.length) throw Object.assign(new Error('Add videos on the Home page first.'), { status: 400 });
  const dir = assetDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const total = project.videos.reduce((s, v) => s + v.meta.duration, 0);
  const picks = [];
  for (const v of project.videos) {
    const n = Math.max(1, Math.round((want * v.meta.duration) / total));
    const signals = await readSignals(projectId, v);
    for (let k = 0; k < n; k++) {
      const d = v.meta.duration;
      let t = d * (0.1 + (0.8 * (k + 0.5)) / n);
      if (signals) {
        const lo = Math.floor(d * (0.1 + (0.8 * k) / n));
        const hi = Math.max(lo + 1, Math.floor(d * (0.1 + (0.8 * (k + 1)) / n)));
        let best = -Infinity;
        for (let s = lo; s < hi && s < signals.motion.length; s++) {
          const b = signals.brightness[s] ?? 100;
          const score = (b > 50 ? 1 : 0) - Math.abs((signals.motion[s] || 0) - 4) / 10;
          if (score > best) {
            best = score;
            t = s + 0.5;
          }
        }
      }
      picks.push({ v, t: Math.min(d - 0.1, t) });
    }
  }
  const added = [];
  for (const { v, t } of picks.slice(0, want + 2)) {
    const tmp = path.join(dir, `still-${newId()}.jpg`);
    try {
      await frameAt(path.join(projectDir(projectId), 'videos', v.file), t, tmp, 1920, v.meta);
      added.push(await addAsset(projectId, tmp, `${v.name} @ ${t.toFixed(1)}s`, 'photo'));
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  return updateProject(projectId, (p) => {
    p.adAssets = [...(p.adAssets || []), ...added];
  });
}

async function readSignals(projectId, v) {
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir(projectId), 'work', v.id, 'signals.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Cut out every photo that hasn't been cut yet (cached per photo). */
async function prepareMedia(projectId, ctx) {
  const project = await loadProject(projectId);
  const photos = (project.adAssets || []).filter((a) => a.kind === 'photo');
  const todo = photos.filter((a) => !a.cut || a.cut.rev !== (a.rev || 0));
  if (todo.length && cutoutsAvailable()) {
    for (const [i, a] of todo.entries()) {
      ctx.stage(`Cutting out photo ${i + 1} of ${todo.length}`, 0.02 + (0.12 * i) / todo.length);
      try {
        const res = await cutout(path.join(assetDir(projectId), a.file), path.join(assetDir(projectId), `${a.id}-cut.png`), { onStage: (m) => ctx.stage(m, 0.02) });
        await updateProject(projectId, (p) => {
          const x = p.adAssets.find((y) => y.id === a.id);
          if (x) x.cut = res ? { ...res, rev: a.rev || 0 } : null;
        });
      } catch (err) {
        ctx.log?.(`Cut-out skipped for ${a.name}: ${err.message}`);
        log('warn', `cutout failed for ${a.file}:`, err.message);
      }
    }
  }
  // Footage: a frame + best moment per video for the director.
  const footage = [];
  for (const v of project.videos || []) {
    const signals = await readSignals(projectId, v);
    let bestFrom = Math.min(1, v.meta.duration / 4);
    if (signals?.motion?.length) {
      let best = -1;
      for (let s = 0; s < signals.motion.length - 3; s++) {
        const score = signals.motion.slice(s, s + 3).reduce((x, y) => x + y, 0) + ((signals.brightness[s] ?? 100) > 50 ? 5 : -20);
        if (score > best) {
          best = score;
          bestFrom = s;
        }
      }
    }
    footage.push({ id: v.id, duration: v.meta.duration, bestFrom, thumbFile: path.join(projectDir(projectId), 'videos', v.thumb), meta: v.meta, file: path.join(projectDir(projectId), 'videos', v.file) });
  }
  return { project: await loadProject(projectId), footage };
}

// ---------------------------------------------------------------------------
// Board → composition
// ---------------------------------------------------------------------------

const industryOf = (business) => (business.id === 'cafe' || /caf|coffee/i.test(business.label) ? 'cafe' : business.id);

/** Brand colours, best first: brand kit → AI-read logo colours → logo pixels → photo colours. */
function brandColors(project, board) {
  const kit = (project.brand?.colors || []).filter(Boolean);
  if (kit.length) return kit;
  if (board.brandColors?.length) return board.brandColors;
  const logo = (project.adAssets || []).find((a) => a.kind === 'logo');
  const fromLogo = (logo?.analysis?.colors || []).filter(isChromatic);
  if (fromLogo.length) return fromLogo;
  const fromPhotos = (project.adAssets || []).filter((a) => a.kind === 'photo').flatMap((a) => (a.analysis?.colors || []).slice(0, 2)).filter(isChromatic);
  return fromPhotos.slice(0, 3);
}

/** Everything the engine needs for a board: palette, asset info, render specs. */
export function kitFor(project, board, business) {
  const dir = assetDir(project.id);
  const photos = (project.adAssets || []).filter((a) => a.kind === 'photo');
  const logo = (project.adAssets || []).find((a) => a.kind === 'logo');
  const direction = getDirection(board.direction);
  const palette = buildPalette({ brandColors: brandColors(project, board), industry: industryOf(business), tone: board.tone || direction.tone, seed: board.seed || 1, direction: board.direction });
  if (board.accent && /^#[0-9a-f]{6}$/i.test(board.accent)) Object.assign(palette, { accent: board.accent });
  const info = {};
  const assetSpec = {};
  const urls = {};
  for (const a of photos) {
    const usable = a.cut?.usable && a.cut.file;
    const an = a.analysis || {};
    const focus = a.cut?.box && an.w ? { x: clamp((a.cut.box.x + a.cut.box.w / 2) / an.w, 0, 1), y: clamp((a.cut.box.y + a.cut.box.h * 0.45) / an.h, 0, 1) } : { x: 0.5, y: 0.5 };
    info[a.id] = { cut: Boolean(usable), w: an.w, h: an.h };
    assetSpec[a.id] = { path: path.join(dir, a.file), cutPath: usable ? path.join(dir, a.cut.file) : null, focus };
    urls[a.id] = { src: `/media/${project.id}/ad-assets/${a.file}?v=${a.rev || 0}`, cut: usable ? `/media/${project.id}/ad-assets/${a.cut.file}?v=${a.rev || 0}` : null, focus };
  }
  if (logo) {
    info.logo = { cut: false, w: logo.analysis?.w, h: logo.analysis?.h };
    assetSpec.logo = { path: path.join(dir, logo.file) };
    urls.logo = { src: `/media/${project.id}/ad-assets/${logo.file}?v=${logo.rev || 0}` };
  }
  const videoSpec = {};
  for (const v of project.videos || []) videoSpec[v.id] = { path: path.join(projectDir(project.id), 'videos', v.file), w: v.meta.width, h: v.meta.height, hdr: v.meta.hdr, rotation: 0 };
  return { palette, info, assetSpec, urls, videoSpec, logo: logo ? 'logo' : null, logoNeedsPlate: logo ? logoNeedsPlate(logo.analysis, palette.bg) : false, industry: industryOf(business) };
}

export function compFor(project, board, business, format) {
  const kit = kitFor(project, board, business);
  const comp = compose({
    direction: board.direction, format, palette: kit.palette, seed: board.seed || 1, logo: kit.logo, logoNeedsPlate: kit.logoNeedsPlate,
    music: board.music?.bpm ? { bpm: board.music.bpm } : null, scenes: board.scenes,
  }, kit.info, kit.industry);
  return { comp, kit };
}

// ---------------------------------------------------------------------------
// Pre-flight review: Claude looks at a still per scene and fixes weak ones
// ---------------------------------------------------------------------------

async function previewFrames(comp, kit, dir) {
  registerFonts();
  const assets = await loadAssets(kit.assetSpec);
  const env = makeEnv(assets, () => null, { externalGrade: false });
  const W = Math.round(comp.width / 2), H = Math.round(comp.height / 2);
  const big = createCanvas(comp.width, comp.height);
  const small = createCanvas(W, H);
  await fs.mkdir(dir, { recursive: true });
  const out = [];
  for (const [i, s] of comp.scenes.entries()) {
    renderFrame(big.getContext('2d'), comp, s.start + s.duration * 0.8, env);
    small.getContext('2d').drawImage(big, 0, 0, W, H);
    const file = path.join(dir, `scene-${i + 1}.jpg`);
    await fs.writeFile(file, await small.encode('jpeg', 82));
    out.push({ scene: i + 1, path: file });
  }
  return out;
}

async function aiReview({ project, board, business, profile, format, photos }) {
  const { comp, kit } = compFor(project, board, business, format);
  const dir = path.join(outDir(project.id), `.review-${newId()}`);
  try {
    const frames = await previewFrames(comp, kit, dir);
    const res = await reviewAdFrames({ business, profile, board, frames, photos });
    const known = new Set(photos.map((p) => p.id));
    const fixes = [];
    const scenes = board.scenes.map((s, i) => {
      const r = res.data.scenes.find((x) => Math.round(x.scene) === i + 1);
      if (!r || r.ok) return s;
      const next = { ...s };
      if (r.fix_headline) next.headline = r.fix_headline.slice(0, 90);
      if (r.fix_recipe && RECIPES[r.fix_recipe] && r.fix_recipe !== 'cta' && i < board.scenes.length - 1) next.recipe = r.fix_recipe;
      if (r.fix_asset && known.has(r.fix_asset)) next.main = r.fix_asset;
      if (JSON.stringify(next) !== JSON.stringify(s)) fixes.push(`Scene ${i + 1}: ${r.problem}`);
      return next;
    });
    return { board: { ...board, scenes }, review: { verdict: res.data.verdict, summary: res.data.summary, fixes } };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function addAdChat(p, who, text, error = false) {
  p.adChat = [...(p.adChat || []), { who, text, at: new Date().toISOString(), ...(error ? { error: true } : {}) }].slice(-60);
}

function chooseTrack(board, musicChoice, tracks, used, seedFn) {
  if (musicChoice === 'none') return Promise.resolve(null);
  if (musicChoice && musicChoice !== 'auto') return getTrack(musicChoice);
  const named = board.musicTrack && board.musicTrack !== 'auto' ? findTrack(tracks, board.musicTrack) : null;
  return named ? Promise.resolve(named) : pickTrack(board.musicMood || 'energetic', used, seedFn);
}

/** Render one board (with voiceover and QA) and record it as a new version. */
async function renderBoard(projectId, idx, ctx, base, span) {
  const project = await loadProject(projectId);
  const plan = project.adPlan;
  const board = plan.ads[idx];
  const business = getBusiness(plan.business, project.businessCustom);
  const { comp, kit } = compFor(project, board, business, plan.format);
  const settings = project.adSettings || {};
  const track = board.music?.id ? await getTrack(board.music.id) : null;
  const baseName = `ad-${idx + 1}-${Date.now().toString(36)}`;
  let voice = null;
  const notes = [];
  if (settings.voiceover && board.voiceover) {
    if (!voiceConfigured()) notes.push('Voiceover skipped: add an OpenAI key in Settings.');
    else {
      ctx.stage(`Recording the voiceover for ad ${idx + 1}`, base);
      const vpath = path.join(outDir(projectId), `${baseName}-voice.mp3`);
      await fs.mkdir(outDir(projectId), { recursive: true });
      await speak(board.voiceover, vpath, { voice: settings.voice || 'coral', style: getDirection(board.direction).voiceStyle });
      voice = { path: vpath, start: 0.35 };
    }
  }
  ctx.stage(`Animating ad ${idx + 1}: "${board.title}"`, base);
  const result = await renderComposition({
    comp, assetSpec: kit.assetSpec, videoSpec: kit.videoSpec, outDir: outDir(projectId), baseName,
    music: track ? { path: path.join(MUSIC_DIR, track.file), startAt: track.startAt, loudness: track.loudness, bpm: track.bpm } : null,
    musicLevel: settings.musicLevel, family: getDirection(board.direction).sound, voice,
    onProgress: (p) => ctx.progress(base + span * 0.9 * p),
  });
  ctx.stage(`Checking ad ${idx + 1}`, base + span * 0.92);
  const qa = await checkRender({ file: path.join(outDir(projectId), result.file), comp, voice, kit, project, board }).catch((err) => ({ passed: false, score: 0, checks: [{ id: 'qa', level: 'warn', text: `Quality check could not run: ${err.message}` }] }));
  if (notes.length) qa.checks.push(...notes.map((text) => ({ id: 'voice', level: 'warn', text })));
  const version = { ...result, qa, board: JSON.parse(JSON.stringify(board)), createdAt: new Date().toISOString(), voice: voice ? path.basename(voice.path) : null };
  let drop = [];
  await updateProject(projectId, (p) => {
    p.adRenders = p.adRenders || [];
    p.adVersions = p.adVersions || [];
    const list = [version, ...(p.adVersions[idx] || [])];
    drop = list.slice(MAX_VERSIONS);
    p.adVersions[idx] = list.slice(0, MAX_VERSIONS);
    p.adRenders[idx] = version;
  });
  for (const v of drop) for (const f of [v.file, v.thumb, v.voice].filter(Boolean)) await fs.rm(path.join(outDir(projectId), f), { force: true });
  return version;
}

async function renderAll(projectId, indexes, ctx, base = 0.4) {
  const span = (1 - base) / indexes.length;
  for (const [n, idx] of indexes.entries()) await renderBoard(projectId, idx, ctx, base + span * n, span);
}

/** Plan and render a batch of ads. */
export async function generateAds(projectId, opts, ctx) {
  let project = await loadProject(projectId);
  if (!project) throw new Error('Project not found');
  const business = getBusiness(opts.business, opts.businessCustom);
  const profile = cleanProfile(opts.profile);
  const count = clamp(Math.round(Number(opts.count) || 2), 1, 3);
  const seconds = AD_LENGTHS.includes(Number(opts.seconds)) ? Number(opts.seconds) : 15;
  const format = FORMATS[opts.format] ? opts.format : '9:16';
  let direction = DIRECTIONS[opts.direction] ? opts.direction : 'auto';
  // A client's saved creative direction applies when "auto" is chosen.
  if (direction === 'auto' && DIRECTIONS[project.brand?.direction]) direction = project.brand.direction;
  const objective = OBJECTIVES[opts.objective] ? opts.objective : 'auto';
  const musicChoice = opts.music || 'auto';
  const mode = opts.mode === 'auto' ? 'auto' : 'ai';
  const tracks = await listTracks();
  if (!profile.name && !profile.services) throw new Error('Fill in the business name and what they sell first (Business details).');
  if (mode === 'ai' && !aiConfigured()) throw new SetupError('The AI needs a Claude API key. Add it on the Settings page, or switch the engine to Free auto-edit there.');

  const prepared = await prepareMedia(projectId, ctx);
  project = prepared.project;
  const photos = (project.adAssets || []).filter((a) => a.kind === 'photo');
  const logo = (project.adAssets || []).find((a) => a.kind === 'logo');
  const media = mediaSummary(photos);
  const d = adDefaults(business, profile);
  const seed = Math.floor(Math.random() * 1e6);

  let plan;
  if (mode === 'ai') {
    ctx.stage(`The AI is directing ${count} ad${count > 1 ? 's' : ''} for ${profile.name || business.label}…`, 0.16);
    let p = 0.16;
    const ticker = setInterval(() => ctx.progress((p = Math.min(0.3, p + 0.004))), 1000);
    let res;
    try {
      res = await planAdBoards({
        business, profile, count, seconds, format: FORMATS[format].label, direction, objective,
        instructions: String(opts.instructions || '').slice(0, 2000),
        photos: media.map((m) => ({ id: m.id, cut: m.cut, thumb: path.join(assetDir(projectId), photos.find((x) => x.id === m.id).thumb), note: '' })),
        logo: logo ? { thumb: path.join(assetDir(projectId), logo.thumb) } : null,
        footage: prepared.footage.map((f) => ({ id: f.id, duration: f.duration, bestFrom: f.bestFrom, thumb: f.thumbFile })),
        tracks: musicChoice === 'auto' ? tracks : [], voiceover: Boolean(opts.voiceover),
      });
    } finally {
      clearInterval(ticker);
    }
    const ads = (res.data.ads || []).slice(0, count).map((raw, i) => ({
      ...normalizeBoard(raw, { assetIds: photos.map((a) => a.id), videoIds: prepared.footage.map((f) => f.id), seconds, defaults: { direction: direction === 'auto' ? 'commercial' : direction, ...d } }),
      ...(direction !== 'auto' ? { direction } : {}),
      ...(project.brand?.tone && project.brand.tone !== 'auto' ? { tone: project.brand.tone } : {}),
      seed: seed + i * 7919,
    }));
    if (!ads.length) throw new Error('The AI did not return any ads. Try again.');
    // Remember what each photo shows (used later by change requests).
    const notes = Object.fromEntries((res.data.photo_notes || []).map((n) => [n.asset, `${n.description} (${n.best_use})`]));
    await updateProject(projectId, (q) => {
      for (const a of q.adAssets || []) if (notes[a.id]) a.notes = notes[a.id].slice(0, 200);
    });
    plan = { source: 'ai', model: res.model, strategy: res.data.strategy || '', ads };
  } else {
    ctx.stage('Planning ads from your business details and photos', 0.2);
    plan = {
      source: 'auto', strategy: '',
      ads: planFree({ business, profile, media, videos: prepared.footage, count, seconds, direction, objective, seed }),
    };
  }

  // Music per ad (different songs when possible), beat grid for the engine.
  const used = [];
  for (const b of plan.ads) {
    const track = await chooseTrack(b, musicChoice, tracks, used);
    if (track) used.push(track.id);
    b.music = track ? { id: track.id, name: track.name, bpm: track.bpm } : null;
  }

  // Optional pre-flight review (approved: Claude looks at a still per scene).
  if (mode === 'ai' && opts.review !== false) {
    for (const [i, b] of plan.ads.entries()) {
      ctx.stage(`The AI is reviewing ad ${i + 1} before rendering`, 0.32 + (0.06 * i) / plan.ads.length);
      try {
        const out = await aiReview({ project, board: b, business, profile, format, photos: media });
        plan.ads[i] = { ...out.board, review: out.review };
      } catch (err) {
        ctx.log?.(`Review skipped: ${err.message}`);
      }
    }
  }
  if (musicChoice !== 'none' && !tracks.length) plan.musicNote = 'No music: your music library is empty. Add songs on the Music page, then make the ads again.';
  Object.assign(plan, { format, seconds, business: business.id, createdAt: new Date().toISOString() });

  await updateProject(projectId, (q) => {
    // Keep old renders as files of earlier versions; start a fresh set.
    q.adPlan = plan;
    q.adRenders = [];
    q.adVersions = [];
    q.profile = profile;
    q.adSettings = { count, seconds, format, direction, objective, music: musicChoice, musicLevel: opts.musicLevel || 'normal', mode, voiceover: Boolean(opts.voiceover), voice: opts.voice || 'coral', review: opts.review !== false };
    addAdChat(q, 'cutline', plan.source === 'ai'
      ? `Made ${plan.ads.length} ad${plan.ads.length > 1 ? 's' : ''}. ${plan.strategy}`.trim()
      : `Made ${plan.ads.length} ad${plan.ads.length > 1 ? 's' : ''} in free mode (no AI).`);
  });
  await fs.rm(outDir(projectId), { recursive: true, force: true });
  await renderAll(projectId, plan.ads.map((_, i) => i), ctx, 0.4);
  return { projectId };
}

/** Save an edited board from the studio and re-render that ad. */
export async function saveBoard(projectId, index, edited, ctx) {
  const project = await loadProject(projectId);
  const idx = Number(index);
  const old = project?.adPlan?.ads?.[idx];
  if (!old) throw new Error('Ad not found');
  const business = getBusiness(project.adPlan.business, project.businessCustom);
  const profile = cleanProfile(project.profile);
  const photos = (project.adAssets || []).filter((a) => a.kind === 'photo').map((a) => a.id);
  const seconds = clamp(Math.round(Number(edited.seconds) || old.seconds || project.adPlan.seconds), 6, 60);
  const board = normalizeBoard({
    ...boardToRaw(old), ...boardToRaw(edited),
  }, { assetIds: photos, videoIds: (project.videos || []).map((v) => v.id), seconds, defaults: { direction: old.direction, ...adDefaults(business, profile) } });
  // The studio sets scene lengths by hand: keep them rather than re-fitting.
  if (edited.scenes && edited.keepDurations !== false) board.scenes = board.scenes.map((s, i) => ({ ...s, duration: clamp(Number(edited.scenes[i]?.duration) || s.duration, 1.2, 8) }));
  const tracks = await listTracks();
  let music = old.music;
  if (edited.music === 'none') music = null;
  else if (edited.music && edited.music !== old.music?.id) {
    const t = tracks.find((x) => x.id === edited.music);
    if (t) music = { id: t.id, name: t.name, bpm: t.bpm };
  }
  const next = { ...board, seed: Number.isInteger(edited.seed) ? edited.seed : old.seed, music, accent: edited.accent ?? old.accent, tone: edited.tone ?? old.tone, review: old.review };
  await updateProject(projectId, (p) => {
    p.adPlan.ads[idx] = next;
  });
  await renderAll(projectId, [idx], ctx, 0.05);
  return { projectId };
}

/** Board fields in the director's raw shape (for re-normalising). */
function boardToRaw(b) {
  if (!b) return {};
  const out = {};
  for (const k of ['title', 'angle', 'objective', 'direction', 'voiceover', 'hashtags']) if (b[k] !== undefined) out[k] = b[k];
  if (b.why !== undefined) out.why_it_works = b.why;
  if (b.brandColors) out.brand_colors = b.brandColors;
  if (b.musicMood) out.music_mood = b.musicMood;
  if (b.postCaption !== undefined) out.post_caption = b.postCaption;
  if (b.voiceover !== undefined) out.voiceover_script = b.voiceover;
  if (b.scenes) out.scenes = b.scenes.map((s) => ({ ...s, main_asset: s.main, other_assets: s.alt, video_from: s.from, text_animation: s.textAnim }));
  return out;
}

/** Restore an earlier version of an ad. */
export async function restoreVersion(projectId, index, versionFile) {
  return updateProject(projectId, (p) => {
    const list = p.adVersions?.[index] || [];
    const v = list.find((x) => x.file === versionFile);
    if (!v) throw Object.assign(new Error('Version not found'), { status: 404 });
    p.adPlan.ads[index] = JSON.parse(JSON.stringify(v.board));
    p.adRenders[index] = v;
  });
}

/** Regenerate one scene: a fresh take with the AI, or a new layout/recipe in free mode. */
export async function regenerateScene(projectId, { adIndex, sceneIndex, request, mode }, ctx) {
  const project = await loadProject(projectId);
  const board = project?.adPlan?.ads?.[adIndex];
  if (!board?.scenes?.[sceneIndex]) throw new Error('Scene not found');
  if (aiConfigured() && mode !== 'auto') {
    return reviseAdsJob(projectId, { request: request || 'Make a stronger, more eye-catching version of this scene. Keep its purpose; try a different composition or photo.', adIndex, sceneIndex, mode }, ctx);
  }
  const s = board.scenes[sceneIndex];
  const photos = (project.adAssets || []).filter((a) => a.kind === 'photo').map((a) => a.id);
  const alternatives = { product_hero: ['photo_full', 'product_hero'], photo_full: ['product_hero', 'gallery'], gallery: ['photo_full', 'process'], kinetic: ['photo_full', 'kinetic'], features: ['features'], process: ['gallery'], offer: ['offer'], review: ['review'], cta: ['cta'] };
  const options = alternatives[s.recipe] || [s.recipe];
  const recipe = options[Math.floor(Math.random() * options.length)];
  const main = photos.length > 1 && recipe !== 'cta' ? photos[(photos.indexOf(s.main) + 1) % photos.length] : s.main;
  const scene = { ...s, recipe, main, seed: Math.floor(Math.random() * 1e6), layout: undefined, entrance: undefined, textAnim: undefined, camera: undefined };
  await updateProject(projectId, (p) => {
    p.adPlan.ads[adIndex].scenes[sceneIndex] = scene;
    addAdChat(p, 'cutline', `Made a new take of scene ${sceneIndex + 1} in ad ${adIndex + 1}.`);
  });
  await renderAll(projectId, [adIndex], ctx, 0.05);
  return { projectId };
}

/** Rule-based ad changes for free mode. */
function parseAdRequest(text, plan, tracks) {
  const t = ` ${text.toLowerCase()} `;
  const did = [];
  const patch = {};
  let idx = [...t.matchAll(/\bads?\s*(?:#|number\s*)?(\d)\b/g)].map((m) => Number(m[1]) - 1).filter((i) => plan.ads[i]);
  const secs = t.match(/\b(10|15|20|30)\s*(?:s|sec|secs|seconds?)\b/);
  if (secs) {
    patch.seconds = Number(secs[1]);
    did.push(`set the length to ${secs[1]} seconds`);
  }
  for (const id of Object.keys(DIRECTIONS)) {
    const label = DIRECTIONS[id].label.toLowerCase();
    if (new RegExp(`\\b(${id}|${label})\\b`).test(t)) {
      patch.direction = id;
      did.push(`switched to the ${DIRECTIONS[id].label} direction`);
    }
  }
  if (/\b(light|bright|white) (background|look|version)\b/.test(t)) {
    patch.tone = 'light';
    did.push('switched to a light background');
  } else if (/\b(dark|black|moody) (background|look|version)\b/.test(t)) {
    patch.tone = 'dark';
    did.push('switched to a dark background');
  }
  const col = text.match(/#([0-9a-f]{6})\b/i);
  if (col) {
    patch.accent = `#${col[1].toLowerCase()}`;
    did.push(`set the accent colour to ${patch.accent}`);
  }
  const q = (k) => text.match(new RegExp(`${k}\\s*(?:to|:|=)\\s*["“']?(.+?)["”']?\\s*$`, 'i'))?.[1];
  const hook = q('(?:hook|headline|opening)');
  if (hook) {
    patch.hook = hook;
    did.push(`changed the opening to "${hook}"`);
  }
  const cta = q('(?:cta|call to action|ending)');
  if (cta) {
    patch.cta = cta;
    did.push(`changed the ending to "${cta}"`);
  }
  if (/\b(no|remove|without)\s+(the\s+)?(music|song)\b/.test(t)) {
    patch.music = 'none';
    did.push('removed the music');
  } else {
    const named = tracks.find((tr) => t.includes(tr.name.toLowerCase()));
    if (named) {
      patch.music = named.id;
      did.push(`switched the music to "${named.name}"`);
    } else if (/\b(different|another|new|change( the)?)\s+(song|track|music)\b/.test(t) && tracks.length) {
      patch.music = 'next';
      did.push('changed the song');
    }
  }
  if (/\b(redo|regenerate|new version|try again|start over|shuffle)\b/.test(t)) {
    patch.reseed = true;
    did.push('made a fresh take');
  }
  if (!idx.length) idx = plan.ads.map((_, i) => i);
  return {
    understood: did.length > 0, idx, patch,
    reply: did.length
      ? `Done: ${did.join(', ')}.`
      : `I couldn't work out that change without the AI. Without a Claude key I understand: "make it 20 seconds", "make it luxury" (or ${Object.keys(DIRECTIONS).join(', ')}), "light background", "colour #ff3366", "hook: Your text", "cta: Your text", "no music", "different song", "redo ad 2". You can also edit any scene by hand. Add a Claude key in Settings to ask for anything.`,
  };
}

/** "Ask for changes" on the Ads page (optionally about one ad or one scene). */
export async function reviseAdsJob(projectId, { request, adIndex, sceneIndex, mode }, ctx) {
  const project = await loadProject(projectId);
  if (!project?.adPlan) throw new Error('Make ads first, then ask for changes.');
  const text = String(request || '').trim().slice(0, 1000);
  const focus = Number.isInteger(adIndex) && project.adPlan.ads[adIndex] ? adIndex : null;
  const sceneFocus = focus !== null && Number.isInteger(sceneIndex) && project.adPlan.ads[focus].scenes[sceneIndex] ? sceneIndex : null;
  await updateProject(projectId, (p) => addAdChat(p, 'you', `${focus !== null ? `Ad ${focus + 1}${sceneFocus !== null ? `, scene ${sceneFocus + 1}` : ''}: ` : ''}${text}`));

  const plan = project.adPlan;
  const business = getBusiness(plan.business, project.businessCustom);
  const profile = cleanProfile(project.profile);
  const tracks = await listTracks();
  const photos = (project.adAssets || []).filter((a) => a.kind === 'photo');
  const logo = (project.adAssets || []).find((a) => a.kind === 'logo');
  const newAds = plan.ads.map((a) => ({ ...a }));
  const changed = [];
  let reply;

  if (aiConfigured() && mode !== 'auto') {
    ctx.stage('The AI is working on your changes…', 0.05);
    let p = 0.05;
    const ticker = setInterval(() => ctx.progress((p = Math.min(0.35, p + 0.005))), 1000);
    let res;
    try {
      res = await reviseAdBoards({
        business, profile, boards: plan.ads, request: text, adNumber: focus !== null ? focus + 1 : null, sceneNumber: sceneFocus !== null ? sceneFocus + 1 : null,
        format: FORMATS[plan.format]?.label || plan.format, tracks,
        photos: mediaSummary(photos).map((m) => ({ id: m.id, cut: m.cut, thumb: path.join(assetDir(projectId), photos.find((x) => x.id === m.id).thumb), note: photos.find((x) => x.id === m.id).notes || '' })),
        logo: logo ? { thumb: path.join(assetDir(projectId), logo.thumb) } : null,
        footage: (project.videos || []).map((v) => ({ id: v.id, duration: v.meta.duration, bestFrom: 0, thumb: path.join(projectDir(projectId), 'videos', v.thumb) })),
      });
    } catch (err) {
      await updateProject(projectId, (q) => addAdChat(q, 'cutline', `That didn't work: ${err.message}`, true));
      throw err;
    } finally {
      clearInterval(ticker);
    }
    reply = res.data.reply;
    const d = adDefaults(business, profile);
    for (const item of res.data.ads || []) {
      const i = Math.round(Number(item.ad_number)) - 1;
      if (!newAds[i] || (focus !== null && i !== focus)) continue;
      const old = newAds[i];
      const next = normalizeBoard(item, { assetIds: photos.map((a) => a.id), videoIds: (project.videos || []).map((v) => v.id), seconds: old.seconds || plan.seconds, defaults: { direction: old.direction, ...d } });
      const differs = JSON.stringify(next.scenes.map((s) => [s.recipe, s.headline, s.subline, s.items, s.main])) !== JSON.stringify(old.scenes.map((s) => [s.recipe, s.headline, s.subline, s.items, s.main])) || next.direction !== old.direction || (item.music_track && item.music_track !== 'keep' && item.music_track !== old.music?.name);
      if (!item.changed && !differs) continue;
      let music = old.music;
      if (item.music_track === 'none') music = null;
      else if (item.music_track && !['keep', 'auto'].includes(item.music_track)) {
        const tr = findTrack(tracks, item.music_track);
        if (tr) music = { id: tr.id, name: tr.name, bpm: tr.bpm };
      }
      newAds[i] = { ...next, seed: old.seed, music, accent: old.accent, tone: old.tone };
      changed.push(i);
    }
    log('info', `[ads revise] "${text}" → changed ads: ${changed.map((i) => i + 1).join(', ') || 'none'}`);
    if (!changed.length) reply += ' (No ad was actually changed. Try saying exactly what to change, e.g. "ad 1: open on the coffee photo and use the luxury direction".)';
  } else {
    const cmd = parseAdRequest(text, plan, tracks);
    reply = cmd.reply;
    if (cmd.understood) {
      const p = cmd.patch;
      for (const i of focus !== null ? [focus] : cmd.idx) {
        const ad = { ...newAds[i], scenes: newAds[i].scenes.map((s) => ({ ...s })) };
        if (p.direction) ad.direction = p.direction;
        if (p.tone) ad.tone = p.tone;
        if (p.accent) ad.accent = p.accent;
        if (p.hook) ad.scenes[0].headline = p.hook.slice(0, 90);
        if (p.cta) ad.scenes[ad.scenes.length - 1].headline = p.cta.slice(0, 90);
        if (p.reseed) {
          ad.seed = Math.floor(Math.random() * 1e6);
          ad.scenes = ad.scenes.map((s) => ({ ...s, seed: undefined, layout: undefined }));
        }
        if (p.seconds) {
          const { fitDurations } = await import('./director.js');
          ad.scenes = fitDurations(ad.scenes, p.seconds);
          ad.seconds = p.seconds;
        }
        if (p.music === 'none') ad.music = null;
        else if (p.music === 'next') {
          const at = tracks.findIndex((t) => t.id === ad.music?.id);
          const t = tracks[(at + 1) % tracks.length];
          ad.music = { id: t.id, name: t.name, bpm: t.bpm };
        } else if (p.music) {
          const t = tracks.find((x) => x.id === p.music);
          ad.music = { id: t.id, name: t.name, bpm: t.bpm };
        }
        newAds[i] = ad;
        changed.push(i);
      }
    }
  }

  await updateProject(projectId, (q) => {
    for (const i of changed) q.adPlan.ads[i] = newAds[i];
    addAdChat(q, 'cutline', reply || 'Nothing needed changing.');
  });
  if (changed.length) await renderAll(projectId, changed, ctx, 0.4);
  return { projectId, changed, reply };
}

/** What the browser needs to compose and preview an ad live. */
export async function previewKit(projectId, index) {
  const project = await loadProject(projectId);
  const board = project?.adPlan?.ads?.[index];
  if (!board) throw Object.assign(new Error('Ad not found'), { status: 404 });
  const business = getBusiness(project.adPlan.business, project.businessCustom);
  const kit = kitFor(project, board, business);
  const videos = Object.fromEntries((project.videos || []).map((v) => [v.id, { src: `/media/${projectId}/videos/${v.file}`, w: v.meta.width, h: v.meta.height }]));
  return { board, format: project.adPlan.format, palette: kit.palette, brandColors: brandColors(project, board), info: kit.info, urls: kit.urls, videos, logo: kit.logo, logoNeedsPlate: kit.logoNeedsPlate, industry: kit.industry, music: board.music };
}
