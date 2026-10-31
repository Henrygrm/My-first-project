// Final render of a motion-engine composition: frames are drawn in parallel
// worker threads (one range each, so the server stays responsive and
// multi-core Macs render several times faster), joined, then mixed with
// music, sound effects and voiceover into one MP4.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { FFMPEG, h264Args, run, thumbnail } from '../ffmpeg.js';
import { musicGain } from '../render.js';
import { sfxFile } from './sfx.js';

const WORKER = new URL('./worker.js', import.meta.url);

/** CSS-style grade ("contrast(1.1) saturate(0.9) brightness(0.97)") + grain → FFmpeg filters. */
export function gradeFilter(grade = {}) {
  const f = String(grade.filter || '');
  const num = (name, d) => {
    const m = f.match(new RegExp(`${name}\\(([\\d.]+)\\)`));
    return m ? Number(m[1]) : d;
  };
  const c = num('contrast', 1), s = num('saturate', 1), b = num('brightness', 1);
  const parts = ['format=yuv420p'];
  if (c !== 1 || s !== 1 || b !== 1) parts.unshift(`eq=contrast=${c.toFixed(3)}:saturation=${s.toFixed(3)}:brightness=${((b - 1) * 0.6).toFixed(3)}`);
  if (grade.grain > 0) parts.push(`noise=alls=${Math.round(grade.grain * 110)}:allf=t`);
  return parts.join(',');
}

function runWorker(data, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: data });
    w.on('message', (m) => {
      if (m.type === 'progress') onProgress?.(m.done);
      else if (m.type === 'done') resolve();
      else if (m.type === 'error') reject(new Error(m.message));
    });
    w.on('error', reject);
    w.on('exit', (code) => code !== 0 && reject(new Error(`Render worker stopped (code ${code})`)));
  });
}

/**
 * Mix the soundtrack: music (looped, level-matched, ducked under any
 * voiceover), sound-effect cues, voiceover; loudness-normalised to -14 LUFS.
 */
export async function buildAudio({ duration, music, musicLevel = 'normal', sfx = [], family = 'punchy', voice = null, out }) {
  const inputs = ['-f', 'lavfi', '-t', duration.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'];
  const filters = [];
  const mixLabels = ['[0:a]'];
  let idx = 1;
  let musicLabel = null;
  if (music) {
    inputs.push('-stream_loop', '-1', '-ss', (music.startAt || 0).toFixed(3), '-i', music.path);
    const level = { soft: 0.55, normal: 0.85, loud: 1.25 }[musicLevel] ?? 0.85;
    filters.push(`[${idx}:a]atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${(level * musicGain(music)).toFixed(3)},afade=t=in:d=0.05,afade=t=out:st=${Math.max(0, duration - 1).toFixed(3)}:d=1[mus]`);
    musicLabel = '[mus]';
    idx++;
  }
  if (voice) {
    inputs.push('-i', voice.path);
    const ms = Math.round((voice.start || 0) * 1000);
    filters.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms},volume=${(voice.gain || 1).toFixed(2)},asplit=2[vo1][vo2]`);
    idx++;
    if (musicLabel) {
      // Duck the music under the voice so every word is clear.
      filters.push(`${musicLabel}[vo2]sidechaincompress=threshold=0.04:ratio=6:attack=15:release=350[mduck]`);
      musicLabel = '[mduck]';
    } else filters.push('[vo2]anullsink');
    mixLabels.push('[vo1]');
  }
  if (musicLabel) mixLabels.push(musicLabel);
  let n = 0;
  for (const cue of sfx) {
    if (cue.t >= duration - 0.05) continue;
    const s = await sfxFile(cue.kind, family);
    if (!s) continue;
    inputs.push('-i', s.file);
    const ms = Math.round(cue.t * 1000);
    // Effects sit under the music: present, never louder than the ad itself.
    const db = s.level - (music ? 9 : 4) - (voice ? 4 : 0);
    filters.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms},volume=${db}dB[sx${n}]`);
    mixLabels.push(`[sx${n}]`);
    idx++;
    n++;
  }
  filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:duration=first,alimiter=limit=0.95[mixed]`);
  // Normalise to social-media loudness when there is a real bed (music or voice).
  filters.push(music || voice ? '[mixed]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]' : '[mixed]aresample=48000[aout]');
  await run(FFMPEG, ['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[aout]', '-t', duration.toFixed(3), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out]);
  return out;
}

/**
 * @param {object} p
 *   comp, assetSpec { id: { path, cutPath, focus } }, videoSpec { id: { path, w, h, hdr } }
 *   outDir, baseName, music { path, startAt, loudness, bpm } | null, musicLevel,
 *   sfx: boolean, family, voice { path, start } | null, onProgress(p 0..1), workers
 */
export async function renderComposition(p) {
  const { comp, assetSpec, videoSpec = {}, outDir, baseName, onProgress } = p;
  await fs.mkdir(outDir, { recursive: true });
  const t0 = Date.now();
  const frames = Math.round(comp.duration * comp.fps);
  const cores = Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 1);
  const k = Math.max(1, Math.min(p.workers || Math.min(cores, 6), Math.ceil(frames / 45)));
  const encoder = [...(await h264Args()), '-pix_fmt', 'yuv420p', '-r', String(comp.fps), '-g', String(comp.fps * 2), '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  const vf = gradeFilter(comp.grade);
  const tmp = path.join(outDir, `.${baseName}`);
  await fs.mkdir(tmp, { recursive: true });
  const done = new Array(k).fill(0);
  const report = () => onProgress?.(Math.min(0.97, (done.reduce((s, x) => s + x, 0) / frames) * 0.92));
  try {
    const segs = [];
    for (let i = 0; i < k; i++) {
      const start = Math.floor((frames * i) / k), end = Math.floor((frames * (i + 1)) / k);
      segs.push({ start, end, out: path.join(tmp, `seg${i}.mp4`) });
    }
    await Promise.all(segs.map((s, i) => runWorker({ comp, assetSpec, videoSpec, start: s.start, end: s.end, out: s.out, vf, encoder }, (n) => {
      done[i] = n;
      report();
    })));
    const list = path.join(tmp, 'list.txt');
    await fs.writeFile(list, segs.map((s) => `file '${s.out.replace(/'/g, "'\\''")}'`).join('\n'));
    const video = path.join(tmp, 'video.mp4');
    await run(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video]);
    onProgress?.(0.94);
    const audio = path.join(tmp, 'audio.m4a');
    await buildAudio({ duration: comp.duration, music: p.music, musicLevel: p.musicLevel, sfx: p.sfx === false ? [] : comp.sfx || [], family: p.family, voice: p.voice, out: audio });
    const mp4Name = `${baseName}.mp4`;
    await run(FFMPEG, ['-y', '-v', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-t', comp.duration.toFixed(3), '-movflags', '+faststart', path.join(outDir, mp4Name)]);
    const thumbName = `${baseName}.jpg`;
    await thumbnail(path.join(outDir, mp4Name), path.join(outDir, thumbName), Math.min(1.6, comp.duration / 3));
    onProgress?.(1);
    return { file: mp4Name, thumb: thumbName, duration: Math.round(comp.duration * 100) / 100, renderMs: Date.now() - t0, workers: k };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
