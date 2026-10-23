import { EFFECTS, STYLE_IDS, TRANSITIONS, getStyle, weightedPick } from './styles.js';
import { cleanOnScreenText } from './subtitles.js';
import { clipDuration, computeTimeline } from './timeline.js';

export { clipDuration };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round2 = (v) => Math.round(v * 100) / 100;
// Rounding must never push a shot past the real end of its video.
const floor3 = (v) => Math.floor(v * 1000) / 1000;
function clampToFootage(segs, videos) {
  return segs.map((s) => {
    const out = { ...s, start: Math.max(0, s.start), end: Math.min(s.end, floor3(videos[s.video].meta.duration)) };
    if (out.layout === 'split') {
      const len = out.end - out.start;
      out.compare_start = Math.max(0, Math.min(out.compare_start, floor3(videos[out.compare_video].meta.duration - len)));
    }
    return out;
  });
}

const ROLES = ['hook', 'setup', 'process', 'reveal', 'payoff', 'cta'];
const QUALITIES = ['strong', 'usable', 'weak'];
// Claude is asked for these labels but they aren't schema-enforced, so map
// anything unexpected onto the closest known value instead of failing.
const oneOf = (value, allowed, fallback) => {
  const v = String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return allowed.find((a) => v === a) || allowed.find((a) => v.includes(a)) || fallback;
};

/** Small seeded random generator so each generation varies but can be reproduced. */
export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Validate and repair a clip so it can always be rendered: clamp timestamps
 * to the real video durations, drop impossible segments and enforce the
 * platform's maximum length. Video indexes are 0-based internally.
 */
export function sanitizeClip(clip, videos, maxSeconds) {
  const segments = [];
  for (const raw of clip.segments || []) {
    const vi = Math.round(num(raw.video, -1));
    const v = videos[vi];
    if (!v) continue;
    const dur = v.meta.duration;
    const start = clamp(num(raw.start, 0), 0, Math.max(0, dur - 0.4));
    const end = clamp(num(raw.end, start + 2), start + 0.4, dur);
    if (end - start < 0.4) continue;
    const seg = {
      video: vi,
      start: round2(start),
      end: round2(end),
      role: oneOf(raw.role, ROLES, 'process'),
      caption: cleanOnScreenText(raw.caption).slice(0, 60),
      speed: round2(clamp(num(raw.speed, 1), 0.5, 2)),
      focus_x: round2(clamp(num(raw.focus_x, 0.5), 0, 1)),
      transition: oneOf(raw.transition, Object.keys(TRANSITIONS), 'cut'),
      effect: oneOf(raw.effect, EFFECTS, 'none'),
      layout: 'full',
      why: raw.why || '',
    };
    // Split screen needs a second ("before") source that is long enough.
    const cv = Math.round(num(raw.compare_video, -1));
    if (String(raw.layout || '').toLowerCase().includes('split') && videos[cv]) {
      const len = end - start;
      seg.layout = 'split';
      seg.compare_video = cv;
      seg.compare_start = round2(clamp(num(raw.compare_start, 0), 0, Math.max(0, videos[cv].meta.duration - len)));
      seg.compare_focus_x = round2(clamp(num(raw.compare_focus_x, seg.focus_x), 0, 1));
    }
    segments.push(seg);
  }

  const out = {
    ...clip,
    style: oneOf(clip.style, STYLE_IDS, 'montage'),
    hook_text: cleanOnScreenText(clip.hook_text).slice(0, 80),
    cta_text: cleanOnScreenText(clip.cta_text).slice(0, 60),
    segments: clampToFootage(segments, videos),
  };
  enforceMax(out, maxSeconds);
  return out;
}

function enforceMax(clip, maxSeconds) {
  // Drop middle segments, keep the hook and the ending.
  while (clip.segments.length > 2 && clipDuration(clip) > maxSeconds) {
    clip.segments.splice(clip.segments.length - 2, 1);
  }
  if (clipDuration(clip) > maxSeconds) {
    const last = clip.segments.at(-1);
    const over = clipDuration(clip) - maxSeconds;
    last.end = round2(Math.max(last.start + 0.5, last.end - over * last.speed));
  }
}

/**
 * Snap every cut onto the music's beat grid. Each shot's visible length
 * (between transition midpoints) becomes a whole number of beats, so cuts,
 * flashes and zooms land on the beat when the music starts on a beat.
 */
export function syncToBeats(clip, track, videos, maxSeconds) {
  if (!track?.bpm) return clip;
  const beat = 60 / track.bpm;
  const style = getStyle(clip.style);
  const segs = clip.segments.map((s) => ({ ...s }));

  for (let pass = 0; pass < 3; pass++) {
    const { items } = computeTimeline(segs);
    const d = items.map((it) => (it.trans ? it.trans[1] : 0));
    segs.forEach((s, k) => {
      const halves = (k ? d[k - 1] / 2 : 0) + d[k] / 2;
      const visible = (s.end - s.start) / s.speed - halves;
      let n = Math.max(style.beats[0], Math.round(visible / beat));
      const limit = Math.min(
        videos[s.video].meta.duration,
        s.layout === 'split' ? videos[s.compare_video].meta.duration : Infinity,
      );
      let len = (n * beat + halves) * s.speed;
      while (len > limit && n > 1) {
        n--;
        len = (n * beat + halves) * s.speed;
      }
      len = Math.min(len, limit);
      if (s.start + len > videos[s.video].meta.duration) s.start = Math.max(0, videos[s.video].meta.duration - len);
      s.end = s.start + len;
      if (s.layout === 'split' && s.compare_start + len > videos[s.compare_video].meta.duration) {
        s.compare_start = Math.max(0, videos[s.compare_video].meta.duration - len);
      }
    });
  }
  const out = { ...clip, segments: segs.map((s) => ({ ...s, start: round2(s.start), end: Math.round(s.end * 1000) / 1000 })) };
  if (clipDuration(out) > maxSeconds && out.segments.length > 2) {
    out.segments.splice(out.segments.length - 2, 1);
    return syncToBeats(out, track, videos, maxSeconds);
  }
  return out;
}

/** Free source footage after (dir=1) or before (dir=-1) a shot, up to `want` seconds. */
function room(segs, i, videos, dir, want) {
  const s = segs[i];
  let limit = dir > 0 ? videos[s.video].meta.duration - s.end : s.start;
  for (const [j, o] of segs.entries()) {
    if (j === i || o.video !== s.video || o.layout === 'split') continue;
    if (dir > 0 && o.start >= s.end - 0.01) limit = Math.min(limit, o.start - s.end);
    if (dir < 0 && o.end <= s.start + 0.01) limit = Math.min(limit, s.start - o.end);
  }
  return Math.max(0, Math.min(want, limit));
}

/** Lengthen the shortest shot that has free footage next to it (up to `step` seconds of playback). */
function growOnce(segs, videos, step, blocked) {
  const order = segs.map((s, i) => i).filter((i) => segs[i].layout !== 'split' && !blocked.has(i))
    .sort((a, b) => (segs[a].end - segs[a].start) / segs[a].speed - (segs[b].end - segs[b].start) / segs[b].speed);
  for (const i of order) {
    const want = step * segs[i].speed;
    const after = room(segs, i, videos, 1, want);
    if (after >= 0.1) {
      segs[i] = { ...segs[i], end: round2(segs[i].end + after) };
      return i;
    }
    const before = room(segs, i, videos, -1, want);
    if (before >= 0.1) {
      segs[i] = { ...segs[i], start: round2(segs[i].start - before) };
      return i;
    }
  }
  return -1;
}

/**
 * Make a clip match the length the user picked (within the platform limit).
 * Order of preference: use more of each shot → slow shots down a little →
 * replay moments (each at most once more). Overshoot is trimmed off so the
 * result lands within about a beat of the target. Cuts stay on the beat.
 */
export function fitLength(clip, target, videos, track, maxSeconds) {
  const goal = Math.min(target, maxSeconds);
  const sync = (c) => (track ? syncToBeats(c, track, videos, maxSeconds) : c);
  const step = track ? 60 / track.bpm : 0.5;
  const tolerance = Math.max(0.75, step);
  const dur = (c) => clipDuration(c);
  let c = sync({ ...clip, segments: clip.segments.map((s) => ({ ...s })) });

  // Too long: drop middle shots, keeping the hook and the ending.
  while (dur(c) > goal + tolerance && c.segments.length > 2) {
    const segs = [...c.segments];
    segs.splice(segs.length - 2, 1);
    c = sync({ ...c, segments: segs });
  }

  // Short: use more of each shot. A shot whose extra footage gets rounded
  // away by the beat grid is skipped from then on.
  const blocked = new Set();
  for (let guard = 0; guard < 800 && dur(c) < goal - tolerance / 2; guard++) {
    const segs = c.segments.map((s) => ({ ...s }));
    const i = growOnce(segs, videos, step, blocked);
    if (i < 0) break;
    const before = dur(c);
    const next = sync({ ...c, segments: segs });
    if (dur(next) > before + 0.01) c = next;
    else blocked.add(i);
  }

  // Still short: slow shots down a little (no slower than 0.7x).
  let stretched = '';
  for (let guard = 0; guard < 12 && dur(c) < goal - tolerance / 2; guard++) {
    const segs = c.segments.map((s) => (s.layout === 'split' ? s : { ...s, speed: round2(Math.max(0.7, s.speed * 0.92)) }));
    if (segs.every((s, i) => s.speed === c.segments[i].speed)) break;
    c = sync({ ...c, segments: segs });
    stretched = 'slowed';
  }

  // Still short: replay moments, best first, each at most once more.
  const rank = { reveal: 0, payoff: 1, hook: 2 };
  const originals = c.segments.filter((s) => s.layout !== 'split')
    .sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3) || (b.end - b.start) - (a.end - a.start));
  for (const [n, src] of originals.entries()) {
    if (dur(c) >= goal - tolerance / 2) break;
    const replay = { ...src, caption: '', role: src.role === 'hook' ? 'process' : src.role, effect: n % 2 ? 'punch' : 'zoom_in', transition: n % 2 ? 'cut' : 'fade' };
    c = sync({ ...c, segments: [...c.segments.slice(0, -1), replay, c.segments.at(-1)] });
    stretched = 'replayed';
  }

  // Overshoot: trim the longest shots back towards the target.
  for (let guard = 0; guard < 40 && (dur(c) > goal + tolerance / 2 || dur(c) > maxSeconds); guard++) {
    const segs = c.segments.map((s) => ({ ...s }));
    const i = segs.reduce((bi, s, j) => (s.layout !== 'split' && (s.end - s.start) / s.speed > (segs[bi].end - segs[bi].start) / segs[bi].speed ? j : bi), 0);
    const cut = Math.min((dur(c) - goal) * segs[i].speed, (segs[i].end - segs[i].start) - 0.6);
    if (cut <= 0.05) break;
    segs[i].end = round2(segs[i].end - Math.max(cut, step * segs[i].speed * 0.6));
    const before = dur(c);
    c = sync({ ...c, segments: segs });
    if (dur(c) >= before) break;
  }

  // Never exceed the platform limit: shave the very end (the last cut is the end of the clip).
  if (dur(c) > maxSeconds) {
    const segs = c.segments.map((s) => ({ ...s }));
    const last = segs.at(-1);
    last.end = Math.round((last.end - (dur(c) - maxSeconds) * last.speed - 0.005) * 1000) / 1000;
    c = { ...c, segments: segs };
  }

  c = { ...c, segments: clampToFootage(c.segments, videos) };
  const total = dur(c);
  let lengthNote = null;
  if (total < goal - tolerance) {
    lengthNote = `This clip is ${Math.round(total)}s, not ${goal}s: there isn't enough usable footage (shots are only repeated once). Upload more clips to reach the full length.`;
  } else if (stretched) {
    lengthNote = `To reach ${goal}s some shots were slowed down${stretched === 'replayed' ? ' and some moments are shown twice' : ''}. Upload more footage for a tighter edit.`;
  }
  return { ...c, lengthNote };
}

/** Convert Claude's 1-based plan into the internal 0-based, validated form. */
export function normalizeAiPlan(raw, videos, platform, styles) {
  const toZero = (x) => ({
    ...x,
    video: Math.round(num(x.video, 0)) - 1,
    ...(x.compare_video !== undefined ? { compare_video: Math.round(num(x.compare_video, 0)) - 1 } : {}),
  });
  const clips = (raw.clips || [])
    .map((c, i) => sanitizeClip({ ...c, style: c.style || styles[i], segments: (c.segments || []).map(toZero) }, videos, platform.maxSeconds))
    .filter((c) => c.segments.length > 0);
  if (!clips.length) throw new Error('The AI plan did not contain any usable segments. Try again or add instructions.');
  return {
    source: 'ai',
    summary: raw.summary || '',
    footage_review: (raw.footage_review || []).map(toZero).filter((r) => videos[r.video])
      .map((r) => ({ ...r, quality: oneOf(r.quality, QUALITIES, 'usable') })),
    cut_sections: (raw.cut_sections || []).map(toZero).filter((r) => videos[r.video]),
    reshoot_tips: raw.reshoot_tips || [],
    clips,
  };
}

// ---------------------------------------------------------------------------
// Heuristic auto-edit (works without any API key)
// ---------------------------------------------------------------------------

function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function secondScores(videos) {
  // motion = average frame-to-frame pixel change (0–255); relative to the
  // busiest footage uploaded, so it adapts to each shoot.
  const allMotion = videos.flatMap((v) => v.signals.motion);
  const motionRef = Math.max(1, percentile(allMotion, 0.9));
  return videos.map((v) => {
    const { motion, loudness, brightness } = v.signals;
    const hasAudio = loudness.some((x) => x !== null);
    return motion.map((m, i) => {
      // Square root so moderately busy footage isn't drowned out by the single
      // busiest clip; extreme values are usually camera shake, so they're capped.
      let s = Math.min(1.2, Math.sqrt(m / motionRef));
      if (m < motionRef * 0.08) s -= 0.4; // nothing is happening
      if (hasAudio && loudness[i] !== null) {
        s += 0.35 * clamp((loudness[i] + 60) / 50, 0, 1);
        if (loudness[i] < -50) s -= 0.15; // dead air
      }
      if (brightness[i] !== null && brightness[i] < 35) s -= 0.8;
      else if (brightness[i] !== null && brightness[i] < 55) s -= 0.25;
      if (i === 0 || i >= motion.length - 1) s -= 0.35; // start/stop recording wobble
      return s;
    });
  });
}

function windowScore(scores, start, len) {
  const vals = [];
  for (let t = Math.floor(start); t < Math.ceil(start + len); t++) {
    if (scores[t] !== undefined) vals.push(scores[t]);
  }
  if (!vals.length) return -1;
  // Blend mean and worst second so a window can't hide a dead patch.
  const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
  return 0.5 * mean + 0.5 * Math.min(...vals);
}

const overlaps = (a, b, pad = 0.3) => a.video === b.video && a.start < b.end + pad && b.start < a.end + pad;
const pickFrom = (list, rng) => list[Math.floor(rng() * list.length)];

const STYLE_HOOKS = {
  listicle: (b) => ['3 reasons locals choose us', '3 things we never skip', '3 details that make the difference', `3 signs of a great ${b.short.toLowerCase()} job`],
  promo: (b) => ['Book this week, thank us later', `Need a ${b.short.toLowerCase()} pro you can trust?`, 'Spots are filling fast', b.promo[0]],
  satisfying: (b) => ['Turn the sound on', 'Oddly satisfying', 'Watch till the end', b.hooks[0]],
  story: (b) => [`A day in the life at our ${b.short.toLowerCase()} business`, 'Come to work with us', 'Behind the scenes', b.hooks[1]],
};

/** Arrange picked windows into a clip with the structure of the given style. */
function buildStyledClip(styleId, picked, ctx) {
  const { business, videos, rng, k } = ctx;
  const style = getStyle(styleId);
  const chrono = [...picked].sort((a, b) => a.video - b.video || a.start - b.start);
  const seg = (c, extra = {}) => ({ video: c.video, start: c.start, end: c.end, role: 'process', speed: 1, focus_x: 0.5, caption: '', ...extra });
  let segments = chrono.map((c) => seg(c));
  const bestOf = (list) => list.reduce((a, b) => (b.score > a.score ? b : a));
  const late = picked.filter((c) => c.start >= videos[c.video].meta.duration * 0.5);

  if (styleId === 'transformation' && segments.length >= 2) {
    // before … work … slow-mo reveal … split-screen comparison
    segments[0].role = 'hook';
    const after = bestOf(late.length ? late : picked);
    const revealLen = Math.min(after.end - after.start, 2.4);
    segments.push(seg(after, { role: 'reveal', speed: 0.75, end: round2(after.start + revealLen * 0.75) }));
    const before = chrono[0];
    const splitLen = Math.min(2.8, videos[after.video].meta.duration - after.start, videos[before.video].meta.duration - before.start);
    if (splitLen > 1.2) {
      segments.push(seg(after, { role: 'payoff', end: round2(after.start + splitLen), layout: 'split', compare_video: before.video, compare_start: before.start }));
    }
    const caps = business.captions;
    segments[1].caption = caps[1];
    if (segments.length > 3) segments[Math.floor(segments.length / 2)].caption = caps[2];
    segments.at(-2).caption = caps[3];
  } else if (styleId === 'listicle' && segments.length >= 3) {
    // Three numbered sections.
    const reasons = [...business.reasons].sort(() => rng() - 0.5);
    const per = Math.ceil(segments.length / 3);
    segments.forEach((s, i) => {
      const group = Math.min(2, Math.floor(i / per));
      if (i % per === 0) s.caption = `${group + 1}. ${reasons[group]}`;
      s.transition = (i + 1) % per === 0 ? weightedPick({ wipe: 1, slide: 1 }, rng) : 'cut';
    });
    segments[0].role = 'hook';
  } else if (styleId === 'story') {
    const lines = business.story;
    segments.forEach((s, i) => {
      const idx = i === segments.length - 1 ? lines.length - 1 : Math.min(lines.length - 2, Math.round((i * (lines.length - 2)) / Math.max(1, segments.length - 2)));
      s.caption = lines[idx];
    });
    segments[0].role = 'hook';
  } else {
    // montage / promo / satisfying: open on the strongest shot.
    const bestIdx = chrono.reduce((bi, c, i) => (c.score > chrono[bi].score ? i : bi), 0);
    const [best] = segments.splice(bestIdx, 1);
    segments.unshift({ ...best, role: 'hook' });
    const lines = styleId === 'promo' ? business.promo : business.captions;
    let li = 0;
    segments.forEach((s, i) => {
      if (i > 0 && i % style.captionEvery === 0 && li < lines.length) s.caption = lines[li++];
    });
  }
  if (segments.length > 1) segments.at(-1).role = segments.at(-1).role === 'process' ? 'payoff' : segments.at(-1).role;

  // Transitions and camera moves from the style's palette (varied per run).
  segments.forEach((s, i) => {
    s.transition = s.transition || weightedPick(style.transitions, rng);
    if (!s.effect) s.effect = s.layout === 'split' ? 'none' : weightedPick(style.effects, rng);
    if (i === 0 && (styleId === 'montage' || styleId === 'promo')) s.transition = pickFrom(['flash', 'zoom'], rng);
  });

  const hook = pickFrom(STYLE_HOOKS[styleId]?.(business) || business.hooks, rng);
  // Don't repeat the hook as a caption.
  segments.forEach((s) => {
    if (s.caption && s.caption.toLowerCase() === hook.toLowerCase()) s.caption = '';
  });
  return {
    title: `${style.label} ${k + 1}`,
    style: styleId,
    concept: style.blurb,
    hook_text: hook,
    hook_reason: 'Template hook for this industry and style. Edit it to match your footage.',
    segments,
    cta_text: business.cta,
    pacing_notes: style.brief.split('. ')[0] + '.',
    music_suggestion: `${style.mood} track`,
    post_caption: `${hook} 👀\n\n${business.cta}. Link in bio.`,
    hashtags: business.hashtagSeeds.map((h) => `#${h}`),
  };
}

export function autoPlan({ videos, business, platform, clipCount, targetSeconds, styles, rng = Math.random }) {
  const scores = secondScores(videos);
  const totalFootage = videos.reduce((s, v) => s + v.meta.duration, 0);
  const target = Math.min(targetSeconds, platform.maxSeconds);
  // Pick a little more footage than the target: transitions overlap shots.
  const want = target * 1.15 + 1;

  // Candidate windows of a given length every 0.5s across all videos.
  const candidatesFor = (len) => {
    const list = [];
    videos.forEach((v, vi) => {
      const dur = v.meta.duration;
      const l = Math.min(len, dur);
      for (let s = 0; s + l <= dur + 0.01; s += 0.5) {
        list.push({ video: vi, start: round2(s), end: round2(Math.min(dur, s + l)), score: windowScore(scores[vi], s, l) });
      }
    });
    return list.sort((a, b) => b.score - a.score);
  };

  const pick = (candidates, segLen, bar, used) => {
    const picked = [];
    let total = 0;
    // Best footage first: spread out and unused by earlier clips, then
    // neighbouring moments, then moments another clip also uses.
    for (const pass of [0, 1, 2]) {
      for (const c of candidates) {
        if (total >= want || c.score < bar) break;
        if (picked.some((p) => overlaps(p, c, 0.05))) continue;
        if (pass < 2 && used.some((u) => overlaps(u, c, 0))) continue;
        if (pass === 0 && picked.some((p) => p.video === c.video && Math.abs(p.start - c.start) < segLen * 2.5)) continue;
        picked.push(c);
        total += c.end - c.start;
      }
      if (total >= want) break;
    }
    return { picked, total };
  };

  const used = [];
  const clips = [];
  for (let k = 0; k < clipCount; k++) {
    const styleId = styles[k] || styles[0];
    const style = getStyle(styleId);
    // Shot length: the style's range, nudged by the industry's natural pace.
    const segLen = round2(clamp((style.segLen[0] + style.segLen[1]) / 2 * (0.85 + rng() * 0.3), 0.8, 5));
    const candidates = candidatesFor(segLen);
    // Skip only genuinely bad footage (dark, frozen, dead air); fitLength()
    // later stretches the clip if usable footage runs out.
    const best = candidates[0]?.score ?? 0;
    let { picked } = pick(candidates, segLen, Math.min(0.15, best * 0.3), used);
    if (!picked.length) ({ picked } = pick(candidates, segLen, -Infinity, used));
    if (!picked.length) break;
    used.push(...picked);
    clips.push(sanitizeClip(buildStyledClip(styleId, picked, { business, videos, rng, k }), videos, platform.maxSeconds));
  }

  if (!clips.length) throw new Error('The footage is too short to build a clip from.');


  return {
    source: 'auto',
    summary: `Auto-edit (no AI) chose the most active moments from ${Math.round(totalFootage)}s of footage using measured motion, audio and brightness, then cut each clip in a different style. Hook and caption text come from templates for this industry. Edit them below and re-render, or connect Claude for footage-aware editing.`,
    footage_review: [],
    cut_sections: [],
    reshoot_tips: [
      'Film in portrait (9:16) when you can, so nothing gets cropped.',
      'Hold each shot steady for 3–5 seconds; short, steady clips edit far better than one long take.',
      'Capture a clear "before" and "after" from the same angle.',
      'Get close: detail shots of hands, tools and textures stop the scroll.',
    ],
    clips,
  };
}
