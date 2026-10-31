// Automatic quality control for rendered ads. Every check inspects the real
// output (the MP4's streams, decoded frames and measured audio), not just
// the plan. Problems come back with a plain-English fix.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { paletteIssues } from '../../public/engine/brand.js';
import { textBoxes } from '../../public/engine/compositor.js';
import { FFMPEG, FFPROBE, run } from './ffmpeg.js';
import { registerFonts } from './engine/node.js';

const SAFE = {
  // Fractions of the frame covered by app buttons and captions on each platform family.
  vertical: { top: 0.1, bottom: 0.17, left: 0.04, right: 0.04 },
  feed: { top: 0.04, bottom: 0.04, left: 0.04, right: 0.04 },
};

async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(stdout);
}

async function audioStats(file) {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']).catch((e) => ({ stderr: String(e.message) }));
  const lufs = Number(stderr.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const peak = Number(stderr.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]);
  return { lufs, peak };
}

async function detect(file, filter, re) {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vf', filter, '-an', '-f', 'null', '-']).catch((e) => ({ stderr: String(e.message) }));
  return [...stderr.matchAll(re)].map((m) => m.slice(1).map(Number));
}

async function frameAtTime(file, t, out) {
  await run(FFMPEG, ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-q:v', '3', out]);
  return loadImage(out);
}

/** Contrast between the lightest and darkest parts of a region (text vs what's behind it). */
function regionContrast(img, box, W, H) {
  const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
  const w = Math.max(1, Math.min(W - x, Math.ceil(box.w))), h = Math.max(1, Math.min(H - y, Math.ceil(box.h)));
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.drawImage(img, x, y, w, h, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const lum = [];
  const step = Math.max(1, Math.floor((w * h) / 6000));
  for (let i = 0; i < w * h; i += step) {
    const r = px[i * 4] / 255, gg = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
    const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    lum.push(0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b));
  }
  lum.sort((a, b) => a - b);
  const lo = lum[Math.floor(lum.length * 0.05)], hi = lum[Math.floor(lum.length * 0.95)];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * @returns {{ passed, score, checks: [{ id, level: 'ok'|'info'|'warn'|'error', text, fix? }] }}
 */
export async function checkRender({ file, comp, voice, kit, project, board }) {
  const checks = [];
  const add = (id, level, text, fix) => checks.push({ id, level, text, ...(fix ? { fix } : {}) });
  const W = comp.width, H = comp.height;

  // --- technical --------------------------------------------------------------
  const info = await probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(info.format.duration);
  if (!v) add('video', 'error', 'The file has no video stream.', 'Render again.');
  else {
    if (v.width !== W || v.height !== H) add('resolution', 'error', `Resolution is ${v.width}×${v.height}, expected ${W}×${H}.`, 'Render again.');
    else add('resolution', 'ok', `${W}×${H} (${comp.format})`);
    const [n, d] = String(v.r_frame_rate).split('/').map(Number);
    if (Math.abs(n / (d || 1) - comp.fps) > 0.01) add('fps', 'error', `Frame rate ${(n / d).toFixed(2)} fps, expected ${comp.fps}.`);
    else add('fps', 'ok', `${comp.fps} fps`);
    if (v.codec_name !== 'h264' || v.pix_fmt !== 'yuv420p') add('codec', 'warn', `Video is ${v.codec_name}/${v.pix_fmt}; platforms prefer H.264 yuv420p.`);
    else add('codec', 'ok', 'H.264, yuv420p');
  }
  if (!a) add('audio', 'error', 'No audio track (some apps reject silent files).', 'Render again.');
  else add('audio', 'ok', `AAC ${Math.round(Number(a.sample_rate) / 1000)} kHz`);
  if (Math.abs(dur - comp.duration) > 0.15) add('duration', 'warn', `Length is ${dur.toFixed(2)}s, planned ${comp.duration.toFixed(2)}s.`);
  else add('duration', 'ok', `${dur.toFixed(1)}s`);
  const sizeMb = Number(info.format.size) / 1e6;
  if (sizeMb > 80) add('size', 'warn', `File is large (${sizeMb.toFixed(0)} MB).`);

  // --- picture ------------------------------------------------------------------
  const black = await detect(file, 'blackdetect=d=0.3:pix_th=0.06', /black_start:([\d.]+) black_end:([\d.]+)/g);
  const longBlack = black.filter(([s, e]) => e - s > 0.3 && !(s < 0.05 && e < 0.5));
  if (longBlack.length) add('black', 'warn', `Black screen at ${longBlack.map(([s]) => `${s.toFixed(1)}s`).join(', ')}.`, 'Check that scene has a photo or background.');
  else add('black', 'ok', 'No black gaps');
  const frozen = await detect(file, 'freezedetect=n=0.002:d=2.5', /freeze_start: ([\d.]+)[\s\S]*?freeze_end: ([\d.]+)/g);
  if (frozen.length) add('frozen', 'warn', `Nothing moves for ${frozen.map(([s, e]) => `${(e - s).toFixed(1)}s at ${s.toFixed(1)}s`).join(', ')}.`, 'Add a camera move or shorten that scene.');
  else add('frozen', 'ok', 'Motion throughout');

  // --- audio --------------------------------------------------------------------
  const { lufs, peak } = await audioStats(file);
  const hasBed = Boolean(board.music || voice);
  if (hasBed) {
    if (!Number.isFinite(lufs)) add('loudness', 'warn', 'Could not measure loudness.');
    else if (Math.abs(lufs + 14) > 2) add('loudness', 'warn', `Loudness ${lufs.toFixed(1)} LUFS (target -14).`, 'Render again; if it repeats, change the music volume setting.');
    else add('loudness', 'ok', `${lufs.toFixed(1)} LUFS`);
    if (Number.isFinite(peak) && peak > -0.5) add('peak', 'warn', `Audio peaks at ${peak.toFixed(1)} dBFS (may clip on phones).`);
  } else {
    add('loudness', 'info', 'No music or voice: only sound effects.', 'Add songs on the Music page for a stronger ad.');
  }
  if (voice) {
    const vi = await probe(voice.path).catch(() => null);
    const vd = Number(vi?.format?.duration);
    if (vd && vd + (voice.start || 0) > comp.duration - 0.2) add('voice', 'warn', `Voiceover (${vd.toFixed(1)}s) is longer than the ad and gets cut off.`, 'Shorten the script or make the ad longer.');
    else if (vd) add('voice', 'ok', `Voiceover ${vd.toFixed(1)}s fits`);
  }

  // --- text: safe zones and real contrast -------------------------------------------
  registerFonts();
  const measure = createCanvas(10, 10).getContext('2d');
  const safe = H / W > 1.5 ? SAFE.vertical : SAFE.feed;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-qa-'));
  let lowContrast = [], unsafe = [];
  try {
    for (const [i, s] of comp.scenes.entries()) {
      const t = s.start + s.duration * 0.8;
      const boxes = textBoxes(comp, t, measure);
      if (!boxes.length) continue;
      const img = await frameAtTime(file, t, path.join(tmp, `f${i}.jpg`));
      for (const b of boxes) {
        if (b.y < H * safe.top || b.y + b.h > H * (1 - safe.bottom) || b.x < W * safe.left || b.x + b.w > W * (1 - safe.right)) unsafe.push(`scene ${i + 1} ("${String(b.text).replace(/\*/g, '').slice(0, 30)}")`);
        const cr = regionContrast(img, { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }, W, H);
        if (cr < 2.6) lowContrast.push(`scene ${i + 1} ("${String(b.text).replace(/\*/g, '').slice(0, 30)}", ${cr.toFixed(1)}:1)`);
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  unsafe = [...new Set(unsafe)];
  lowContrast = [...new Set(lowContrast)];
  if (unsafe.length) add('safezone', 'warn', `Text may sit under app buttons in ${unsafe.join(', ')}.`, 'Shorten that text or use a different layout for the scene.');
  else add('safezone', 'ok', 'All text inside the platform safe zone');
  if (lowContrast.length) add('contrast', 'warn', `Text may be hard to read in ${lowContrast.join(', ')}.`, 'Use a darker photo, a different look, or the light/dark background switch.');
  else add('contrast', 'ok', 'Text readable against its background');

  // --- photos -------------------------------------------------------------------
  const photos = Object.fromEntries((project.adAssets || []).filter((x) => x.kind === 'photo').map((x) => [x.id, x]));
  const soft = new Set();
  for (const s of board.scenes) {
    const p = photos[s.main];
    if (!p?.analysis) continue;
    const full = ['photo_full', 'kinetic', 'footage'].includes(s.recipe);
    const need = full ? Math.max(W, H) : Math.max(W, H) * 0.45;
    if (Math.max(p.analysis.w, p.analysis.h) < need / 1.8) soft.add(p.name);
    if (p.analysis.sharpness < 60) soft.add(p.name);
  }
  if (soft.size) add('photos', 'warn', `Low-resolution or blurry photo(s): ${[...soft].join(', ')}.`, 'Use a larger, sharper photo (at least 1500 px on the long side).');
  else if (Object.keys(photos).length) add('photos', 'ok', 'Photos are sharp enough for their size on screen');

  // --- editing: pacing and variety ------------------------------------------------
  const scenes = comp.scenes;
  const repeats = scenes.filter((s, i) => i && s.recipe === scenes[i - 1].recipe && s.recipe !== 'cta').length;
  if (repeats) add('variety', 'warn', `${repeats} pair(s) of neighbouring scenes use the same design.`, 'Regenerate one of them or change its scene type.');
  const used = board.scenes.map((s) => s.main).filter(Boolean);
  const top = Math.max(0, ...Object.values(used.reduce((m, id) => ({ ...m, [id]: (m[id] || 0) + 1 }), {})));
  if (used.length >= 4 && top / scenes.length > 0.6) add('variety', 'info', 'One photo appears in most scenes.', 'Add more photos for more variety.');
  if (!repeats) add('pacing', 'ok', `${scenes.length} scenes, ${scenes.map((s) => s.duration.toFixed(1)).join(' / ')}s`);
  if (scenes[0] && scenes[0].duration > 3.6) add('hook', 'warn', `The opening scene lasts ${scenes[0].duration.toFixed(1)}s; hooks work best under 3s.`, 'Shorten scene 1.');
  const tooShort = scenes.filter((s) => s.duration < 1.2);
  if (tooShort.length) add('pacing', 'warn', `${tooShort.length} scene(s) are too quick to read.`);

  // --- branding -------------------------------------------------------------------
  const hasLogo = (project.adAssets || []).some((x) => x.kind === 'logo');
  if (hasLogo) add('logo', 'ok', 'Logo included');
  else add('logo', 'info', 'No logo uploaded.', 'Add the business logo for brand recognition.');
  const pi = paletteIssues(comp.palette);
  if (pi.length) add('colours', 'warn', pi.join('; '));
  else add('colours', 'ok', 'Brand colours have good contrast');

  const errors = checks.filter((c) => c.level === 'error').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  return { passed: errors === 0, score: Math.max(0, 100 - errors * 25 - warns * 7), errors, warnings: warns, checks, checkedAt: new Date().toISOString() };
}
