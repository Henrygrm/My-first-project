import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/**
 * Run a binary and collect output. `onStdout` receives chunks as they arrive
 * (used for render progress). Rejects with the tail of stderr on failure.
 */
export function run(bin, args, { cwd, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      onStdout?.(s);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`${bin} was not found. Install FFmpeg and make sure it is on your PATH (or set FFMPEG_PATH / FFPROBE_PATH in .env).`));
      } else reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split('\n').slice(-6).join('\n');
        reject(new Error(`${path.basename(bin)} exited with code ${code}: ${tail}`));
      }
    });
  });
}

export async function checkFfmpeg() {
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-version']);
    const version = stdout.split('\n')[0].replace(/^ffmpeg version\s*/, '').split(' ')[0];
    const { stdout: filters } = await run(FFMPEG, ['-hide_banner', '-filters']);
    await run(FFPROBE, ['-version']);
    return {
      available: true,
      version,
      subtitles: /\bsubtitles\b/.test(filters),
      scdet: /\bscdet\b|\bselect\b/.test(filters),
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

export async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('No video stream found in this file.');

  // Phones store portrait video as landscape + a rotation flag. FFmpeg
  // auto-rotates on decode, so report the displayed dimensions.
  let rotation = 0;
  const sideRot = v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation;
  if (sideRot !== undefined) rotation = Number(sideRot);
  else if (v.tags?.rotate) rotation = Number(v.tags.rotate);
  const swap = Math.abs(rotation) % 180 === 90;
  const width = swap ? v.height : v.width;
  const height = swap ? v.width : v.height;

  const duration = Number(info.format.duration || v.duration || 0);
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  const fps = d ? n / d : n || 30;

  // iPhones (and many Androids) record HDR by default. Without tone mapping it
  // looks grey and washed out once converted to normal (SDR) video.
  const hdr = ['arib-std-b67', 'smpte2084'].includes(v.color_transfer);

  return {
    duration: Math.round(duration * 1000) / 1000,
    width,
    height,
    fps: Math.round(fps * 100) / 100,
    hasAudio: Boolean(a),
    codec: v.codec_name,
    orientation: width > height * 1.05 ? 'landscape' : height > width * 1.05 ? 'portrait' : 'square',
    hdr,
  };
}

let filterList = null;

/** Whether this FFmpeg build includes a filter (builds differ, e.g. Homebrew's has no libass). */
export async function hasFilter(name) {
  if (filterList === null) {
    try {
      filterList = (await run(FFMPEG, ['-hide_banner', '-filters'])).stdout;
    } catch {
      filterList = '';
    }
  }
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(filterList);
}

let hwaccelList = null;

/** Hardware video decoding available to this FFmpeg (e.g. videotoolbox on Macs). */
export async function hasHwaccel(name) {
  if (hwaccelList === null) {
    try {
      hwaccelList = (await run(FFMPEG, ['-hide_banner', '-hwaccels'])).stdout;
    } catch {
      hwaccelList = '';
    }
  }
  return new RegExp(`^\\s*${name}\\s*$`, 'm').test(hwaccelList);
}

let encoderList = null;

export async function hasEncoder(name) {
  if (encoderList === null) {
    try {
      encoderList = (await run(FFMPEG, ['-hide_banner', '-encoders'])).stdout;
    } catch {
      encoderList = '';
    }
  }
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(encoderList);
}

/** H.264 encoder args: libx264 when available, else the Mac's hardware encoder. */
export async function h264Args() {
  if (await hasEncoder('libx264')) {
    // CRF keeps quality consistent; the cap keeps files a sensible size for
    // uploading (TikTok/Reels re-encode anything above ~10–15 Mbps anyway).
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '10M', '-bufsize', '20M', '-profile:v', 'high'];
  }
  if (await hasEncoder('h264_videotoolbox')) {
    return ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-maxrate', '10M', '-profile:v', 'high'];
  }
  throw new Error('Your FFmpeg cannot encode H.264 video. Reinstall it with: brew reinstall ffmpeg');
}

/** Filter chain converting HDR to SDR, or '' when not needed or not supported. */
export async function toneMap(meta) {
  if (!meta?.hdr) return '';
  return (await hasFilter('zscale')) && (await hasFilter('tonemap'))
    ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'
    : '';
}

const withToneMap = (tm, rest) => (tm ? `${tm},${rest}` : rest);

export async function thumbnail(file, out, at = 0.5, meta = null) {
  const vf = withToneMap(await toneMap(meta), 'scale=360:-2');
  await run(FFMPEG, ['-y', '-v', 'error', '-ss', String(Math.max(0, at)), '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '4', out]);
  return out;
}

/** Extract a single small JPEG frame at time `t` for AI review. */
export async function frameAt(file, t, out, size = 512, meta = null) {
  const vf = withToneMap(await toneMap(meta), `scale='if(gt(iw,ih),${size},-2)':'if(gt(iw,ih),-2,${size})'`);
  await run(FFMPEG, ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '5', out]);
  return out;
}

/** Simple promise pool so we don't spawn 50 FFmpeg processes at once. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseMetadataFile(text, key) {
  // Lines look like: "frame:12   pts:12  pts_time:3.0" followed by "lavfi.x=0.12"
  const out = [];
  let t = null;
  for (const line of text.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) {
      t = Number(m[1]);
      continue;
    }
    if (t !== null && line.startsWith(key + '=')) {
      const raw = line.slice(key.length + 1).trim();
      // Digital silence is reported as "-inf" dB.
      const val = /^-inf/i.test(raw) ? -Infinity : Number(raw);
      if (Number.isFinite(val) || val === -Infinity) out.push([t, val]);
    }
  }
  return out;
}

function bucket(samples, duration, size = 1) {
  const n = Math.max(1, Math.ceil(duration / size));
  const sums = new Array(n).fill(0);
  const counts = new Array(n).fill(0);
  for (const [t, v] of samples) {
    const i = Math.min(n - 1, Math.floor(t / size));
    sums[i] += v;
    counts[i]++;
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] : null));
}

/**
 * Measure the footage so both the AI and the heuristic editor have real
 * signals to work with: per-second motion, hard cuts, brightness and loudness.
 */
export async function analyzeSignals(file, meta, workDir) {
  await fs.mkdir(workDir, { recursive: true });
  const sceneFile = path.join(workDir, 'scene.txt');
  const lumaFile = path.join(workDir, 'luma.txt');
  const diffFile = path.join(workDir, 'diff.txt');
  const rmsFile = path.join(workDir, 'rms.txt');

  // One decode pass at 4 samples/second on a tiny 8-bit copy:
  //  - scene score  → hard camera cuts
  //  - YAVG         → brightness (0–255, also for 10-bit HDR sources)
  //  - YAVG of the frame-to-frame difference → how much is actually moving
  // Filter args go straight to the process (no shell) and cwd is the work
  // dir, so the metadata file names need no escaping.
  await run(FFMPEG, [
    '-v', 'error', '-skip_frame', 'noref', '-i', file, '-an',
    '-vf', [
      'fps=4', 'scale=160:-2', 'format=yuv420p',
      `select='gte(scene\\,0)'`, 'metadata=print:key=lavfi.scene_score:file=scene.txt',
      'signalstats', 'metadata=print:key=lavfi.signalstats.YAVG:file=luma.txt',
      'tblend=all_mode=difference', 'signalstats', 'metadata=print:key=lavfi.signalstats.YAVG:file=diff.txt',
    ].join(','),
    '-f', 'null', '-',
  ], { cwd: workDir });

  let rms = [];
  if (meta.hasAudio) {
    try {
      await run(FFMPEG, [
        '-v', 'error', '-i', file, '-vn',
        '-af', 'aresample=16000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=rms.txt',
        '-f', 'null', '-',
      ], { cwd: workDir });
      rms = parseMetadataFile(await fs.readFile(rmsFile, 'utf8'), 'lavfi.astats.Overall.RMS_level')
        .map(([t, v]) => [t, Math.max(-90, v)]);
    } catch {
      rms = [];
    }
  }

  const scene = parseMetadataFile(await fs.readFile(sceneFile, 'utf8'), 'lavfi.scene_score');
  const luma = parseMetadataFile(await fs.readFile(lumaFile, 'utf8'), 'lavfi.signalstats.YAVG');
  // Ignore the diff spike at a hard cut; that's a cut, not movement.
  const cutTimes = new Set(scene.filter(([, v]) => v > 0.35).map(([t]) => t.toFixed(2)));
  const diff = parseMetadataFile(await fs.readFile(diffFile, 'utf8'), 'lavfi.signalstats.YAVG')
    .filter(([t]) => !cutTimes.has(t.toFixed(2)));

  const motion = bucket(diff, meta.duration).map((v) => (v === null ? 0 : Math.round(v * 100) / 100));
  const brightness = bucket(luma, meta.duration).map((v) => (v === null ? null : Math.round(v)));
  const loudness = bucket(rms, meta.duration).map((v) => (v === null ? null : Math.round(v)));
  const cuts = scene.filter(([t, v]) => v > 0.35 && t > 0.3).map(([t]) => Math.round(t * 10) / 10);

  await Promise.all([sceneFile, lumaFile, diffFile, rmsFile].map((f) => fs.rm(f, { force: true })));
  return { version: 2, motion, brightness, loudness, cuts };
}

/** Extract mono 16 kHz audio for speech transcription. */
export async function extractAudio(file, out) {
  await run(FFMPEG, ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out]);
  return out;
}
