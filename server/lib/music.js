// Music library: tracks you add (MP3/M4A/WAV) are stored in data/music/,
// analysed once for tempo and beat positions, then used to time cuts to the
// beat and mixed under the clip's original sound.
import fs from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG, FFPROBE, run } from './ffmpeg.js';
import { DATA_DIR, newId } from './store.js';

export const MUSIC_DIR = path.join(DATA_DIR, 'music');
const INDEX = path.join(MUSIC_DIR, 'index.json');
export const MOODS = ['energetic', 'chill', 'build'];

async function readIndex() {
  try {
    return JSON.parse(await fs.readFile(INDEX, 'utf8'));
  } catch {
    return [];
  }
}

async function writeIndex(list) {
  await fs.mkdir(MUSIC_DIR, { recursive: true });
  const tmp = `${INDEX}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 2));
  await fs.rename(tmp, INDEX);
}

export async function listTracks() {
  return readIndex();
}

export async function getTrack(id) {
  return (await readIndex()).find((t) => t.id === id) || null;
}

function parseEnvelope(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('lavfi.astats.Overall.RMS_level=')) continue;
    const raw = line.split('=')[1].trim();
    const db = /^-inf/i.test(raw) ? -120 : Number(raw);
    out.push(Number.isFinite(db) ? db : -120);
  }
  return out;
}

function onsetStrength(db) {
  const lin = db.map((v) => 10 ** (v / 20));
  const on = lin.map((v, i) => (i ? Math.max(0, v - lin[i - 1]) : 0));
  const max = Math.max(...on) || 1;
  return on.map((v) => v / max);
}

/**
 * Estimate tempo and beat phase. Onsets (sudden rises in loudness) from the
 * low band (kick/bass) and full band (snare/hats) are smoothed, then every
 * tempo from 70–180 BPM is scored by how well its best-aligned beat grid lands
 * on those onsets.
 */
export function detectBeats(lowDb, fullDb, frameRate) {
  const lo = onsetStrength(lowDb);
  const hi = onsetStrength(fullDb);
  const raw = lo.map((v, i) => v + 0.6 * (hi[i] || 0));
  // Light smoothing so a hit that falls between two envelope frames still counts.
  const k = [0.25, 0.5, 1, 0.5, 0.25];
  const o = raw.map((_, i) => k.reduce((s, w, j) => s + w * (raw[i + j - 2] || 0), 0));

  const sample = (pos) => {
    const i = Math.floor(pos);
    const f = pos - i;
    return (o[i] || 0) * (1 - f) + (o[i + 1] || 0) * f;
  };
  const gridScore = (period) => {
    let best = { score: -1, offset: 0 };
    for (let off = 0; off < period; off += 0.5) {
      let s = 0;
      for (let t = off; t < o.length; t += period) s += sample(t);
      if (s > best.score) best = { score: s, offset: off };
    }
    return best;
  };

  let best = { bpm: 120, score: -1, offset: 0 };
  for (let bpm = 70; bpm <= 180; bpm += 0.25) {
    const period = (frameRate * 60) / bpm;
    const g = gridScore(period);
    // Mild preference for common tempos to settle half/double-time ties.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.8) ** 2);
    const score = g.score * (0.85 + 0.15 * prior);
    if (score > best.score) best = { bpm, score, offset: g.offset };
  }
  return { bpm: Math.round(best.bpm * 10) / 10, beatOffset: Math.round((best.offset / frameRate) * 1000) / 1000 };
}

export async function analyzeMusic(file, workDir) {
  await fs.mkdir(workDir, { recursive: true });
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration < 5) throw new Error('Music track is too short (needs at least 5 seconds).');

  // ~43 envelope values per second: low-passed for the beat, full-band for loudness.
  const rate = 11025;
  const block = 128;
  await run(FFMPEG, [
    '-v', 'error', '-t', '150', '-i', file, '-vn',
    '-filter_complex',
    `[0:a]aformat=channel_layouts=mono,aresample=${rate},asplit[a][b];` +
    `[a]lowpass=f=160,asetnsamples=n=${block}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=low.txt[ao];` +
    `[b]asetnsamples=n=${block}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=full.txt[bo]`,
    '-map', '[ao]', '-f', 'null', '-', '-map', '[bo]', '-f', 'null', '-',
  ], { cwd: workDir });
  const low = parseEnvelope(await fs.readFile(path.join(workDir, 'low.txt'), 'utf8'));
  const full = parseEnvelope(await fs.readFile(path.join(workDir, 'full.txt'), 'utf8'));
  await fs.rm(workDir, { recursive: true, force: true });

  const frameRate = rate / block;
  const { bpm, beatOffset } = detectBeats(low, full, frameRate);
  const beat = 60 / bpm;

  // Skip a quiet intro: start where the track first gets properly going,
  // snapped onto the beat grid.
  const perSec = [];
  for (let i = 0; i < full.length; i += Math.round(frameRate)) {
    const chunk = full.slice(i, i + Math.round(frameRate)).map((db) => 10 ** (db / 20));
    perSec.push(chunk.reduce((s, v) => s + v, 0) / (chunk.length || 1));
  }
  const sorted = [...perSec].sort((a, b) => a - b);
  const p75 = sorted[Math.floor(sorted.length * 0.75)] || 0;
  const firstLoud = Math.max(0, perSec.findIndex((v) => v >= p75 * 0.6));
  const startAt = Math.round((beatOffset + Math.ceil(Math.max(0, firstLoud - beatOffset) / beat) * beat) * 1000) / 1000;
  const loudness = 20 * Math.log10(Math.max(1e-6, perSec.reduce((s, v) => s + v, 0) / (perSec.length || 1)));

  return {
    duration: Math.round(duration * 10) / 10,
    bpm,
    beatOffset,
    startAt: startAt < duration - 10 ? startAt : beatOffset,
    mood: bpm >= 105 ? 'energetic' : 'chill',
    loudness: Math.round(loudness),
  };
}

export async function addTrack(tmpPath, originalName) {
  const id = newId('m');
  const ext = (path.extname(originalName) || '.mp3').toLowerCase();
  const file = `${id}${ext}`;
  await fs.mkdir(MUSIC_DIR, { recursive: true });
  const dest = path.join(MUSIC_DIR, file);
  await fs.rename(tmpPath, dest).catch(async () => {
    await fs.copyFile(tmpPath, dest);
    await fs.rm(tmpPath, { force: true });
  });
  try {
    const info = await analyzeMusic(dest, path.join(MUSIC_DIR, `.work-${id}`));
    const track = { id, file, name: path.basename(originalName, path.extname(originalName)).slice(0, 80), ...info, addedAt: new Date().toISOString() };
    await writeIndex([...(await readIndex()), track]);
    return track;
  } catch (err) {
    await fs.rm(dest, { force: true });
    throw err;
  }
}

export async function updateTrack(id, fields) {
  const list = await readIndex();
  const t = list.find((x) => x.id === id);
  if (!t) throw Object.assign(new Error('Track not found'), { status: 404 });
  if (typeof fields.name === 'string' && fields.name.trim()) t.name = fields.name.trim().slice(0, 80);
  if (MOODS.includes(fields.mood)) t.mood = fields.mood;
  await writeIndex(list);
  return t;
}

export async function deleteTrack(id) {
  const list = await readIndex();
  const t = list.find((x) => x.id === id);
  if (!t) throw Object.assign(new Error('Track not found'), { status: 404 });
  await fs.rm(path.join(MUSIC_DIR, t.file), { force: true });
  await writeIndex(list.filter((x) => x.id !== id));
}

/** Pick a track that suits the style's mood, varying the choice between clips. */
export async function pickTrack(mood, avoid = [], rng = Math.random) {
  const list = await readIndex();
  if (!list.length) return null;
  const want = mood === 'build' ? ['build', 'energetic'] : [mood];
  let pool = list.filter((t) => want.includes(t.mood) && !avoid.includes(t.id));
  if (!pool.length) pool = list.filter((t) => want.includes(t.mood));
  if (!pool.length) pool = list.filter((t) => !avoid.includes(t.id));
  if (!pool.length) pool = list;
  return pool[Math.floor(rng() * pool.length)];
}
