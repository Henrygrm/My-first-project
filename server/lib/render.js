import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, h264Args, hasFilter, hasHwaccel, run, thumbnail, toneMap } from './ffmpeg.js';
import { GRADES, getStyle } from './styles.js';
import { buildSubtitles, chunkWords, mapTranscript } from './subtitles.js';
import { computeTimeline } from './timeline.js';

const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
const OUT_W = 1080;
const OUT_H = 1920;
const FPS = 30;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f3 = (v) => Number(v).toFixed(3);

/** Decide fill (crop) vs fit (blurred background) for a source. */
function frameMode(meta, reframe) {
  if (reframe === 'fill' || reframe === 'fit') return reframe;
  const aspect = meta.width / meta.height;
  return aspect <= 0.8 ? 'fill' : 'fit';
}

/** Common start of every shot: timing, speed, 30fps, downscale, HDR→SDR. */
function prep(input, speed, tm, w = OUT_W, h = OUT_H) {
  const sp = speed && speed !== 1 ? `,setpts=PTS/${f3(speed)}` : '';
  // Shrink 4K to roughly output size first so heavy filters run on fewer pixels.
  return `[${input}]setpts=PTS-STARTPTS${sp},fps=${FPS},scale=${w}:${h}:force_original_aspect_ratio=increase${tm ? ',' + tm : ''}`;
}

function cropTo(w, h, fx) {
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-${w})*${f3(clamp(fx ?? 0.5, 0, 1))}:(ih-${h})/2`;
}

/** Camera move applied to a finished 1080x1920 shot. */
function effectChain(effect, dur) {
  const frames = Math.max(1, Math.round(dur * FPS));
  const centre = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  switch (effect) {
    case 'punch':
      // Instant 12% punch-in: a classic beat-hit move.
      return `,scale=${Math.round(OUT_W * 1.12)}:${Math.round(OUT_H * 1.12)},crop=${OUT_W}:${OUT_H}`;
    case 'zoom_in':
      // Upscale first so the slow push-in is smooth rather than steppy.
      return `,scale=${OUT_W * 1.5}:${OUT_H * 1.5},zoompan=z='1+0.09*on/${frames}':${centre}:d=1:s=${OUT_W}x${OUT_H}:fps=${FPS}`;
    case 'zoom_out':
      return `,scale=${OUT_W * 1.5}:${OUT_H * 1.5},zoompan=z='1.09-0.09*on/${frames}':${centre}:d=1:s=${OUT_W}x${OUT_H}:fps=${FPS}`;
    default:
      return '';
  }
}

/** Make every shot exactly `dur` long with identical format, as xfade requires. */
const tail = (dur, out) => `,tpad=stop_mode=clone:stop_duration=1,trim=duration=${f3(dur)},setpts=PTS-STARTPTS,settb=AVTB,setsar=1,format=yuv420p[${out}]`;

function shotChain(inLabel, out, seg, meta, reframe, tm, dur) {
  const pre = prep(inLabel, seg.speed, tm);
  const fx = effectChain(seg.effect, dur);
  if (frameMode(meta, reframe) === 'fill') {
    return `${pre},${cropTo(OUT_W, OUT_H, seg.focus_x)}${fx}${tail(dur, out)}`;
  }
  // Fit the whole frame on a blurred, darkened copy (blur at quarter size for speed).
  return `${pre},split=2[${out}b][${out}f];` +
    `[${out}b]scale=${OUT_W / 4}:${OUT_H / 4}:force_original_aspect_ratio=increase,crop=${OUT_W / 4}:${OUT_H / 4},gblur=sigma=10,eq=brightness=-0.12:saturation=1.15,scale=${OUT_W}:${OUT_H}[${out}bg];` +
    `[${out}f]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[${out}fg];` +
    `[${out}bg][${out}fg]overlay=(W-w)/2:(H-h)/2${fx}${tail(dur, out)}`;
}

/** Before (top) / after (bottom) split screen. */
function splitChain(afterLabel, beforeLabel, out, seg, tmA, tmB, dur) {
  const half = OUT_H / 2;
  return `${prep(beforeLabel, seg.speed, tmB, OUT_W, half)},${cropTo(OUT_W, half, seg.compare_focus_x ?? seg.focus_x)},setsar=1[${out}top];` +
    `${prep(afterLabel, seg.speed, tmA, OUT_W, half)},${cropTo(OUT_W, half, seg.focus_x)},setsar=1[${out}bot];` +
    `[${out}top][${out}bot]vstack=inputs=2,drawbox=x=0:y=${half - 3}:w=${OUT_W}:h=6:color=white@0.9:t=fill${tail(dur, out)}`;
}

/** Loudness-match music to roughly -20 dB RMS so quiet and loud tracks sit the same. */
function musicGain(track) {
  return clamp(10 ** ((-20 - (track.loudness ?? -20)) / 20), 0.3, 3);
}

/**
 * Render one clip to MP4.
 * @param {object} clip    { style, hook_text, cta_text, grade?, segments[] }
 * @param {Array}  videos  project videos [{ path, meta }] indexed by segment.video
 * @param {object} opts    { outDir, baseName, reframe, audio, onScreenText, transcripts, music, onProgress }
 *                         music: { path, startAt, loudness } or null
 */
export async function renderClip(clip, videos, opts) {
  const { outDir, baseName, reframe = 'auto', audio = 'original', onScreenText = true, transcripts = null, music = null, musicLevel = 'normal', onProgress } = opts;
  await fs.mkdir(outDir, { recursive: true });
  const style = getStyle(clip.style);

  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
  const filters = [];
  let inputIdx = 0;
  const addInput = (...a) => {
    args.push(...a);
    return inputIdx++;
  };

  // Macs decode iPhone HEVC/4K far faster in hardware. If it fails for any
  // file, the render is retried in software below.
  // CUTLINE_HWACCEL=off disables it; any other value forces that decoder.
  const hwName = process.env.CUTLINE_HWACCEL || (process.platform === 'darwin' ? 'videotoolbox' : 'off');
  const hw = hwName !== 'off' && (await hasHwaccel(hwName)) ? ['-hwaccel', hwName] : [];

  const tl = computeTimeline(clip.segments);
  const toneMaps = await Promise.all(videos.map((v) => toneMap(v.meta)));

  // --- shots ---------------------------------------------------------------
  tl.items.forEach((seg, i) => {
    const v = videos[seg.video];
    const srcDur = seg.end - seg.start;
    const vIdx = addInput(...hw, '-ss', f3(seg.start), '-t', f3(srcDur + 0.2), '-i', v.path);

    const cmp = seg.layout === 'split' ? videos[seg.compare_video] : null;
    if (cmp) {
      const cStart = clamp(seg.compare_start ?? 0, 0, Math.max(0, cmp.meta.duration - srcDur));
      const cIdx = addInput(...hw, '-ss', f3(cStart), '-t', f3(srcDur + 0.2), '-i', cmp.path);
      filters.push(splitChain(`${vIdx}:v`, `${cIdx}:v`, `v${i}`, seg, toneMaps[seg.video], toneMaps[seg.compare_video], seg.dur));
    } else {
      filters.push(shotChain(`${vIdx}:v`, `v${i}`, seg, v.meta, reframe, toneMaps[seg.video], seg.dur));
    }

    const atempo = seg.speed && seg.speed !== 1 ? `,atempo=${f3(seg.speed)}` : '';
    if (audio === 'original' && v.meta.hasAudio) {
      // volume: the video's own level-matching gain (see audioGain in pipeline.js).
      filters.push(`[${vIdx}:a]asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${f3(v.audioGain ?? 1)}${atempo},apad,atrim=0:${f3(seg.dur)}[a${i}]`);
    } else {
      const sIdx = addInput('-f', 'lavfi', '-t', f3(seg.dur), '-i', 'anullsrc=r=44100:cl=stereo');
      filters.push(`[${sIdx}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
  });

  // --- transitions (xfade / acrossfade chains) -----------------------------
  let vCur = 'v0';
  let aCur = 'a0';
  tl.items.slice(0, -1).forEach((seg, k) => {
    const [xf, d] = seg.trans;
    filters.push(`[${vCur}][v${k + 1}]xfade=transition=${xf}:duration=${f3(d)}:offset=${f3(seg.offset)}[x${k}]`);
    filters.push(`[${aCur}][a${k + 1}]acrossfade=d=${f3(d)}:c1=tri:c2=tri[ax${k}]`);
    vCur = `x${k}`;
    aCur = `ax${k}`;
  });
  const total = tl.total;

  // --- colour grade --------------------------------------------------------
  const grade = GRADES[clip.grade] ?? GRADES[style.grade] ?? '';
  if (grade) {
    filters.push(`[${vCur}]${grade}[vg]`);
    vCur = 'vg';
  }

  // --- text ----------------------------------------------------------------
  const timeline = tl.items.map((s) => ({ ...s, outStart: s.play, outEnd: s.play + s.dur }));
  let speech = [];
  if (transcripts) {
    const words = [];
    for (const [videoIdx, t] of Object.entries(transcripts)) {
      for (const w of t.words || []) words.push({ ...w, video: Number(videoIdx) });
    }
    speech = chunkWords(mapTranscript(words, timeline));
  }
  const subs = buildSubtitles(clip, timeline, total, { onScreenText, speech });
  const srtName = `${baseName}.srt`;
  await fs.writeFile(path.join(outDir, srtName), subs.srt);

  const tempFiles = [];
  if (subs.hasEvents) {
    let drawText = null;
    try {
      ({ renderTextPng: drawText } = await import('./textOverlay.js'));
    } catch (err) {
      console.warn('Text drawing library unavailable, trying libass instead:', err.message);
    }
    if (drawText) {
      for (const [i, ev] of subs.events.entries()) {
        const png = await drawText(ev.text, ev.style, style.text, path.join(outDir, `${baseName}-text${i}.png`));
        if (!png) continue;
        tempFiles.push(png.file);
        const S = f3(ev.start);
        const E = f3(ev.end);
        const animated = ['Hook', 'Caption', 'CTA', 'TagTop', 'TagBottom'].includes(ev.style);
        if (animated) {
          // Looped image so it can fade; slides up into place as it appears.
          const tIdx = addInput('-loop', '1', '-framerate', String(FPS), '-t', f3(total), '-i', path.basename(png.file));
          const fin = ev.style === 'CTA' ? 0.25 : 0.18;
          const fout = Math.min(0.15, (ev.end - ev.start) / 4);
          const rise = ev.style === 'Hook' || ev.style === 'CTA' ? 60 : 24;
          filters.push(`[${tIdx}:v]format=rgba,fade=t=in:st=${S}:d=${f3(fin)}:alpha=1,fade=t=out:st=${f3(ev.end - fout)}:d=${f3(fout)}:alpha=1[t${i}]`);
          filters.push(`[${vCur}][t${i}]overlay=x=${png.x}:y=${png.y}+${rise}*max(0\\,1-(t-${S})/${f3(fin)}):enable=between(t\\,${S}\\,${E})[vt${i}]`);
        } else {
          const tIdx = addInput('-i', path.basename(png.file));
          filters.push(`[${vCur}][${tIdx}:v]overlay=${png.x}:${png.y}:enable=between(t\\,${S}\\,${E})[vt${i}]`);
        }
        vCur = `vt${i}`;
      }
    } else if (await hasFilter('subtitles')) {
      const assName = `${baseName}.ass`;
      await fs.writeFile(path.join(outDir, assName), subs.ass);
      tempFiles.push(path.join(outDir, assName));
      const fontsDir = path.relative(outDir, FONTS_DIR).split(path.sep).join('/') || '.';
      filters.push(`[${vCur}]subtitles=filename=${assName}:fontsdir=${fontsDir}[vass]`);
      vCur = 'vass';
    }
  }

  // --- music ---------------------------------------------------------------
  const fadeOut = Math.max(0, total - 0.35);
  if (music) {
    const mIdx = addInput('-stream_loop', '-1', '-ss', f3(music.startAt || 0), '-i', music.path);
    const mixO = audio === 'original' ? style.mix.original : 0;
    const level = { soft: 0.6, normal: 1, loud: 1.6 }[musicLevel] ?? 1;
    const mixM = style.mix.music * level * musicGain(music);
    filters.push(`[${mIdx}:a]atrim=0:${f3(total)},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${f3(mixM)},afade=t=out:st=${f3(Math.max(0, total - 1.2))}:d=1.2[mus]`);
    if (mixO >= 0.55) {
      // Original sound matters in this style (talking, sizzle): duck the music under it.
      filters.push(`[${aCur}]volume=${f3(mixO)},asplit=2[o1][o2]`);
      // Gentle ducking: the music dips a few dB under talking or sizzle but stays audible.
      filters.push('[mus][o2]sidechaincompress=threshold=0.1:ratio=2.5:attack=20:release=400[mduck]');
      filters.push('[o1][mduck]amix=inputs=2:normalize=0:duration=first[amix]');
    } else {
      filters.push(`[${aCur}]volume=${f3(mixO)}[ovol]`);
      filters.push('[ovol][mus]amix=inputs=2:normalize=0:duration=first[amix]');
    }
    filters.push('[amix]alimiter=limit=0.95[alim]');
    aCur = 'alim';
  }

  // Finish at social-media loudness (-14 LUFS, like TikTok/Instagram) so every
  // clip is as loud as the videos around it in the feed.
  filters.push(`[${aCur}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[aln]`);
  aCur = 'aln';
  filters.push(`[${vCur}]fade=t=out:st=${f3(fadeOut)}:d=0.35[vout]`);
  filters.push(`[${aCur}]afade=t=out:st=${f3(fadeOut)}:d=0.35[aout]`);

  const mp4Name = `${baseName}.mp4`;
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-t', f3(total),
    ...(await h264Args()),
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart',
    mp4Name,
  );

  const encode = (a) => run(FFMPEG, a, {
    cwd: outDir,
    onStdout: (chunk) => {
      const m = chunk.match(/out_time_(?:us|ms)=(\d+)/g);
      if (m && onProgress && total > 0) onProgress(clamp(Number(m.at(-1).split('=')[1]) / 1e6 / total, 0, 1));
    },
  });
  try {
    try {
      await encode(args);
    } catch (err) {
      if (!hw.length) throw err;
      console.warn('Hardware decoding failed, retrying in software:', err.message.split('\n')[0]);
      await encode(args.filter((a, i) => !(a === '-hwaccel' || args[i - 1] === '-hwaccel')));
    }
  } finally {
    await Promise.all(tempFiles.map((f) => fs.rm(f, { force: true })));
  }

  const thumbName = `${baseName}.jpg`;
  await thumbnail(path.join(outDir, mp4Name), path.join(outDir, thumbName), Math.min(0.8, total / 3));

  return {
    file: mp4Name,
    srt: srtName,
    thumb: thumbName,
    duration: Math.round(total * 10) / 10,
    timeline: tl.items.map(({ video, start, end, speed, play, dur, role, caption, transition, effect, layout }) => ({ video, start, end, speed, outStart: play, outEnd: play + dur, role, caption, transition, effect, layout })),
  };
}
