import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, h264Args, hasFilter, run, thumbnail, toneMap } from './ffmpeg.js';
import { renderTextPng } from './textOverlay.js';
import { buildSubtitles, chunkWords, mapTranscript } from './subtitles.js';

const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
const OUT_W = 1080;
const OUT_H = 1920;
const FPS = 30;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Decide fill (crop) vs fit (blurred background) for a source. */
function frameMode(meta, reframe) {
  if (reframe === 'fill' || reframe === 'fit') return reframe;
  const aspect = meta.width / meta.height;
  return aspect <= 0.8 ? 'fill' : 'fit';
}

function videoChain(inLabel, outLabel, seg, meta, reframe, tm) {
  const speed = seg.speed && seg.speed !== 1 ? `,setpts=PTS/${seg.speed.toFixed(3)}` : '';
  // Drop to 30fps and shrink 4K to roughly output size before anything heavy
  // (HDR tone mapping, blur), so big phone files render several times faster.
  const pre = `[${inLabel}]setpts=PTS-STARTPTS${speed},fps=${FPS},scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase${tm ? ',' + tm : ''}`;
  const mode = frameMode(meta, reframe);
  if (mode === 'fill') {
    // Crop to 9:16, positioned on the subject the AI identified (focus_x).
    const fx = clamp(seg.focus_x ?? 0.5, 0, 1).toFixed(3);
    return `${pre},scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H}:(iw-${OUT_W})*${fx}:(ih-${OUT_H})/2,setsar=1,format=yuv420p[${outLabel}]`;
  }
  // Fit the whole frame and fill the rest with a blurred, darkened copy.
  // The blur runs at quarter resolution to keep renders quick.
  return `${pre},split=2[${outLabel}bgsrc][${outLabel}fgsrc];` +
    `[${outLabel}bgsrc]scale=${OUT_W / 4}:${OUT_H / 4}:force_original_aspect_ratio=increase,crop=${OUT_W / 4}:${OUT_H / 4},gblur=sigma=10,eq=brightness=-0.12:saturation=1.15,scale=${OUT_W}:${OUT_H}[${outLabel}bg];` +
    `[${outLabel}fgsrc]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[${outLabel}fg];` +
    `[${outLabel}bg][${outLabel}fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[${outLabel}]`;
}

function atempoChain(speed) {
  // atempo accepts 0.5–2.0 per instance; our speeds are clamped to that range.
  return speed && speed !== 1 ? `,atempo=${speed.toFixed(3)}` : '';
}

/**
 * Render one clip to MP4.
 * @param {object} clip       normalized clip { title, hook_text, cta_text, segments[] }
 * @param {Array}  videos     project videos [{ path, meta }] indexed by segment.video
 * @param {object} opts       { outDir, baseName, reframe, audio, onScreenText, transcripts, onProgress }
 */
export async function renderClip(clip, videos, opts) {
  const { outDir, baseName, reframe = 'auto', audio = 'original', onScreenText = true, transcripts = null, onProgress } = opts;
  await fs.mkdir(outDir, { recursive: true });

  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  const filters = [];
  const timeline = [];
  let inputIdx = 0;
  let outT = 0;

  const toneMaps = await Promise.all(videos.map((v) => toneMap(v.meta)));

  clip.segments.forEach((seg, i) => {
    const v = videos[seg.video];
    const srcDur = seg.end - seg.start;
    const speed = seg.speed || 1;
    const outDur = srcDur / speed;

    args.push('-ss', seg.start.toFixed(3), '-t', srcDur.toFixed(3), '-i', v.path);
    const vIdx = inputIdx++;
    filters.push(videoChain(`${vIdx}:v`, `v${i}`, seg, v.meta, reframe, toneMaps[seg.video]));

    if (audio === 'original' && v.meta.hasAudio) {
      filters.push(`[${vIdx}:a]asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${atempoChain(speed)},apad,atrim=0:${outDur.toFixed(3)}[a${i}]`);
    } else {
      // Silent track so every clip has audio (platforms expect one, and you
      // can drop a trending sound on top inside the app).
      args.push('-f', 'lavfi', '-t', outDur.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo');
      filters.push(`[${inputIdx++}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }

    timeline.push({ ...seg, speed, outStart: outT, outEnd: outT + outDur });
    outT += outDur;
  });

  const total = outT;
  const n = clip.segments.length;
  const concatIn = clip.segments.map((_, i) => `[v${i}][a${i}]`).join('');
  filters.push(`${concatIn}concat=n=${n}:v=1:a=1[vc][ac]`);

  // Speech subtitles from the transcript, re-timed onto the edited timeline.
  let speech = [];
  if (transcripts) {
    const words = [];
    for (const [videoIdx, t] of Object.entries(transcripts)) {
      for (const w of t.words || []) words.push({ ...w, video: Number(videoIdx) });
    }
    speech = chunkWords(mapTranscript(words, timeline));
  }

  const subs = buildSubtitles(clip, timeline, total, { onScreenText, speech });
  const assName = `${baseName}.ass`;
  const srtName = `${baseName}.srt`;
  await fs.writeFile(path.join(outDir, assName), subs.ass);
  await fs.writeFile(path.join(outDir, srtName), subs.srt);

  const fadeOut = Math.max(0, total - 0.35).toFixed(3);
  // The ASS file is referenced relative to cwd (outDir) so no path escaping
  // is needed inside the filter graph, which matters on Windows.
  // Burn in the text. libass (`subtitles` filter) when this FFmpeg has it;
  // otherwise draw each line as a PNG and overlay it for its time range.
  const textMode = process.env.CUTLINE_TEXT_RENDERER || ((await hasFilter('subtitles')) ? 'ass' : 'png');
  const tempPngs = [];
  let videoOut = 'vc';
  if (subs.hasEvents && textMode === 'ass') {
    const fontsDir = path.relative(outDir, FONTS_DIR).split(path.sep).join('/') || '.';
    filters.push(`[vc]subtitles=filename=${assName}:fontsdir=${fontsDir}[vt]`);
    videoOut = 'vt';
  } else if (subs.hasEvents) {
    for (const [i, ev] of subs.events.entries()) {
      const png = await renderTextPng(ev.text, ev.style, path.join(outDir, `${baseName}-text${i}.png`));
      if (!png) continue;
      tempPngs.push(png.file);
      args.push('-i', path.basename(png.file));
      const enable = `between(t\\,${ev.start.toFixed(3)}\\,${ev.end.toFixed(3)})`;
      filters.push(`[${videoOut}][${inputIdx++}:v]overlay=${png.x}:${png.y}:enable=${enable}[vt${i}]`);
      videoOut = `vt${i}`;
    }
  }
  filters.push(`[${videoOut}]fade=t=out:st=${fadeOut}:d=0.35[vout]`);
  filters.push(`[ac]afade=t=out:st=${fadeOut}:d=0.35[aout]`);

  const mp4Name = `${baseName}.mp4`;
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...(await h264Args()),
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart',
    mp4Name,
  );

  await run(FFMPEG, args, {
    cwd: outDir,
    onStdout: (chunk) => {
      const m = chunk.match(/out_time_(?:us|ms)=(\d+)/g);
      if (m && onProgress && total > 0) {
        const us = Number(m.at(-1).split('=')[1]);
        onProgress(clamp(us / 1e6 / total, 0, 1));
      }
    },
  });

  await Promise.all(tempPngs.map((f) => fs.rm(f, { force: true })));

  const thumbName = `${baseName}.jpg`;
  await thumbnail(path.join(outDir, mp4Name), path.join(outDir, thumbName), Math.min(0.8, total / 3));

  return {
    file: mp4Name,
    srt: srtName,
    thumb: thumbName,
    duration: Math.round(total * 10) / 10,
    timeline: timeline.map(({ video, start, end, speed, outStart, outEnd, role, caption }) => ({ video, start, end, speed, outStart, outEnd, role, caption })),
  };
}
