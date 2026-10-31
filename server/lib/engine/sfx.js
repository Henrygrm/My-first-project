// Sound effects, synthesised with FFmpeg (no samples, so no licensing
// questions): whooshes and swooshes for transitions, impacts and pops for
// reveals, shimmers for shine, risers into big moments. Each sound family
// (from the creative direction) tunes them differently. Files are generated
// once into data/sfx and reused.
import fs from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG, run } from '../ffmpeg.js';
import { DATA_DIR } from '../store.js';

const SFX_DIR = path.join(DATA_DIR, 'sfx');
export const SFX_KINDS = ['whoosh', 'swoosh', 'soft', 'impact', 'pop', 'click', 'shimmer', 'riser'];

// Per family: pitch multiplier, brightness (high-pass Hz), level (dB) and length scale.
const FAMILIES = {
  cinematic: { pitch: 0.8, hp: 300, level: -1, len: 1.2 },
  soft: { pitch: 1.0, hp: 600, level: -7, len: 1.0 },
  tech: { pitch: 1.4, hp: 900, level: -3, len: 0.8 },
  punchy: { pitch: 1.0, hp: 400, level: -2, len: 0.85 },
  playful: { pitch: 1.5, hp: 700, level: -4, len: 0.9 },
};

/** lavfi source + filter for one sound. Returns [inputArgs, filter, duration]. */
function recipe(kind, f) {
  const p = f.pitch;
  const L = f.len;
  const env = (attack, total) => `volume='if(lt(t,${attack}),t/${attack},max(0,1-(t-${attack})/${(total - attack).toFixed(3)}))^2':eval=frame`;
  switch (kind) {
    case 'whoosh': {
      const d = (0.55 * L).toFixed(3);
      return [['-f', 'lavfi', '-t', d, '-i', 'anoisesrc=color=pink:sample_rate=48000:amplitude=0.9'], `highpass=f=${f.hp},lowpass=f=${Math.round(5200 * p)},${env((0.32 * L).toFixed(3), +d)},apulsator=hz=2.2:amount=0.35,volume=2.6`, +d];
    }
    case 'swoosh': {
      const d = (0.32 * L).toFixed(3);
      return [['-f', 'lavfi', '-t', d, '-i', 'anoisesrc=color=white:sample_rate=48000:amplitude=0.7'], `highpass=f=${Math.round(f.hp * 2.5)},lowpass=f=${Math.round(9000 * p)},${env((0.18 * L).toFixed(3), +d)},volume=1.3`, +d];
    }
    case 'soft': {
      const d = (0.45 * L).toFixed(3);
      return [['-f', 'lavfi', '-t', d, '-i', 'anoisesrc=color=brown:sample_rate=48000:amplitude=0.8'], `highpass=f=150,lowpass=f=${Math.round(2200 * p)},${env((0.25 * L).toFixed(3), +d)},volume=1.6`, +d];
    }
    case 'impact': {
      const d = (0.9 * L).toFixed(3);
      const base = Math.round(42 * p);
      return [['-f', 'lavfi', '-t', d, '-i', `aevalsrc='0.9*sin(2*PI*(${base}+${Math.round(70 * p)}*exp(-t*14))*t)*exp(-t*${(5 / L).toFixed(2)})+0.35*(random(0)*2-1)*exp(-t*40)':s=48000`], `lowpass=f=${Math.round(3000 * p)},volume=1.2`, +d];
    }
    case 'pop': {
      const d = 0.16;
      return [['-f', 'lavfi', '-t', String(d), '-i', `aevalsrc='0.8*sin(2*PI*(${Math.round(320 * p)}+${Math.round(700 * p)}*exp(-t*35))*t)*exp(-t*28)':s=48000`], 'volume=1.0', d];
    }
    case 'click': {
      const d = 0.06;
      return [['-f', 'lavfi', '-t', String(d), '-i', `aevalsrc='0.7*sin(2*PI*${Math.round(1800 * p)}*t)*exp(-t*90)+0.3*(random(0)*2-1)*exp(-t*160)':s=48000`], 'highpass=f=500', d];
    }
    case 'shimmer': {
      const d = (1.1 * L).toFixed(3);
      const a = Math.round(2600 * p), b = Math.round(3900 * p), c = Math.round(5200 * p);
      return [['-f', 'lavfi', '-t', d, '-i', `aevalsrc='(0.3*sin(2*PI*${a}*t)+0.22*sin(2*PI*${b}*t)+0.15*sin(2*PI*${c}*t))*(0.55+0.45*sin(2*PI*13*t))*min(1,t*20)*exp(-t*${(3 / L).toFixed(2)})':s=48000`], 'aecho=0.6:0.5:60|110:0.3|0.2,volume=3.2', +d];
    }
    case 'riser': {
      const d = (1.2 * L).toFixed(3);
      return [['-f', 'lavfi', '-t', d, '-i', `aevalsrc='(0.35*sin(2*PI*(${Math.round(180 * p)}*t+${Math.round(400 * p)}*t*t))+0.25*(random(0)*2-1))*pow(t/${d},2)':s=48000`], `highpass=f=${f.hp},lowpass=f=${Math.round(7000 * p)},volume=1.2`, +d];
    }
    default:
      return null;
  }
}

/** Path to a sound effect wav, generating it the first time. */
export async function sfxFile(kind, family = 'punchy') {
  const f = FAMILIES[family] || FAMILIES.punchy;
  const fam = FAMILIES[family] ? family : 'punchy';
  const file = path.join(SFX_DIR, `${fam}-${kind}.wav`);
  try {
    await fs.access(file);
    return { file, level: f.level };
  } catch {}
  const r = recipe(kind, f);
  if (!r) return null;
  await fs.mkdir(SFX_DIR, { recursive: true });
  const [input, filter] = r;
  const tmp = `${file}.${process.pid}.tmp.wav`;
  await run(FFMPEG, ['-y', '-v', 'error', ...input, '-af', `${filter},aformat=sample_fmts=s16:channel_layouts=stereo`, '-ar', '48000', tmp]);
  await fs.rename(tmp, file);
  return { file, level: f.level };
}
