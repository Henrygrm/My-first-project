import { cleanOnScreenText } from './subtitles.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round2 = (v) => Math.round(v * 100) / 100;

const ROLES = ['hook', 'setup', 'process', 'reveal', 'payoff', 'cta'];
const QUALITIES = ['strong', 'usable', 'weak'];
// Claude is asked for these labels but they aren't schema-enforced, so map
// anything unexpected onto the closest known value instead of failing.
const oneOf = (value, allowed, fallback) => {
  const v = String(value || '').toLowerCase().trim();
  return allowed.find((a) => v === a) || allowed.find((a) => v.includes(a)) || fallback;
};

export function clipDuration(clip) {
  return clip.segments.reduce((s, seg) => s + (seg.end - seg.start) / (seg.speed || 1), 0);
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
    segments.push({
      video: vi,
      start: round2(start),
      end: round2(end),
      role: oneOf(raw.role, ROLES, 'process'),
      caption: cleanOnScreenText(raw.caption).slice(0, 60),
      speed: round2(clamp(num(raw.speed, 1), 0.5, 2)),
      focus_x: round2(clamp(num(raw.focus_x, 0.5), 0, 1)),
      why: raw.why || '',
    });
  }

  const out = {
    ...clip,
    hook_text: cleanOnScreenText(clip.hook_text).slice(0, 80),
    cta_text: cleanOnScreenText(clip.cta_text).slice(0, 60),
    segments,
  };

  // Enforce the platform maximum: drop middle segments, keep hook and ending.
  while (out.segments.length > 2 && clipDuration(out) > maxSeconds) {
    out.segments.splice(out.segments.length - 2, 1);
  }
  if (clipDuration(out) > maxSeconds) {
    const last = out.segments.at(-1);
    const over = clipDuration(out) - maxSeconds;
    last.end = round2(Math.max(last.start + 0.5, last.end - over * last.speed));
  }
  return out;
}

/** Convert Claude's 1-based plan into the internal 0-based, validated form. */
export function normalizeAiPlan(raw, videos, platform) {
  const toZero = (x) => ({ ...x, video: Math.round(num(x.video, 0)) - 1 });
  const clips = (raw.clips || [])
    .map((c) => sanitizeClip({ ...c, segments: (c.segments || []).map(toZero) }, videos, platform.maxSeconds))
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

export function autoPlan({ videos, business, platform, clipCount, targetSeconds }) {
  const scores = secondScores(videos);
  const segLen = round2((business.segment.min + business.segment.max) / 2);
  const totalFootage = videos.reduce((s, v) => s + v.meta.duration, 0);
  const target = Math.min(targetSeconds, platform.maxSeconds, Math.max(4, totalFootage * 0.8));

  // Candidate windows every 0.5s across all videos.
  const candidates = [];
  videos.forEach((v, vi) => {
    const dur = v.meta.duration;
    const len = Math.min(segLen, dur);
    for (let s = 0; s + len <= dur + 0.01; s += 0.5) {
      candidates.push({ video: vi, start: round2(s), end: round2(Math.min(dur, s + len)), score: windowScore(scores[vi], s, len) });
    }
  });
  candidates.sort((a, b) => b.score - a.score);

  // Only use footage that is reasonably good. A tight 15s clip beats a 30s
  // clip padded with dead time, so clips may come out shorter than the target.
  const best = candidates[0]?.score ?? 0;
  const minLen = Math.min(target, 6);

  const pick = (bar, used) => {
    const picked = [];
    let total = 0;
    // Prefer windows not used by earlier clips; then allow reuse of good ones.
    for (const pass of [0, 1]) {
      for (const c of candidates) {
        if (total >= target || c.score < bar) break;
        if (picked.some((p) => overlaps(p, c))) continue;
        if (pass === 0 && used.some((u) => overlaps(u, c, 0))) continue;
        // Spread picks out: avoid stacking many windows next to each other.
        if (pass === 0 && picked.some((p) => p.video === c.video && Math.abs(p.start - c.start) < segLen * 2.5)) continue;
        picked.push(c);
        total += c.end - c.start;
      }
      if (total >= target) break;
    }
    return { picked, total };
  };

  const used = [];
  const clips = [];
  for (let k = 0; k < clipCount; k++) {
    let { picked, total } = pick(Math.max(0.25, best * 0.42), used);
    if (total < minLen) ({ picked, total } = pick(best * 0.2, used)); // footage is weak overall
    if (!picked.length) break;
    used.push(...picked);

    // Chronological order tells the before → after story.
    const chrono = [...picked].sort((a, b) => a.video - b.video || a.start - b.start);
    let segments = chrono.map((c) => ({ video: c.video, start: c.start, end: c.end, role: 'process', speed: 1, focus_x: 0.5, caption: '' }));

    if (business.hookFirstFrom === 'end' && segments.length > 2) {
      // Flash-forward: tease the best late shot (the finished result) up front.
      const late = picked.filter((c) => c.start >= videos[c.video].meta.duration * 0.55);
      const best = (late.length ? late : picked).reduce((a, b) => (b.score > a.score ? b : a));
      const teaseLen = Math.min(1.6, best.end - best.start);
      const teaseStart = round2(Math.max(best.start, best.end - teaseLen));
      segments.unshift({ video: best.video, start: teaseStart, end: round2(teaseStart + teaseLen), role: 'hook', speed: 1, focus_x: 0.5, caption: '' });
      segments.at(-1).role = 'payoff';
    } else if (business.hookFirstFrom === 'best' && segments.length > 1) {
      const bestIdx = chrono.reduce((bi, c, i) => (c.score > chrono[bi].score ? i : bi), 0);
      const [best] = segments.splice(bestIdx, 1);
      segments.unshift({ ...best, role: 'hook' });
      segments.at(-1).role = 'payoff';
    } else {
      segments[0].role = 'hook';
      if (segments.length > 1) segments.at(-1).role = 'payoff';
    }

    // Spread the industry caption templates across the clip.
    const caps = business.captions;
    const body = segments.length - 1;
    if (body > 0) {
      caps.forEach((cap, ci) => {
        const idx = 1 + Math.min(body - 1, Math.round((ci * (body - 1)) / Math.max(1, caps.length - 1)));
        if (!segments[idx].caption) segments[idx].caption = cap;
      });
    }

    const hook = business.hooks[k % business.hooks.length];
    clips.push(sanitizeClip({
      title: `Auto edit ${k + 1}`,
      concept: 'Most active moments in chronological order, chosen from motion and audio levels.',
      hook_text: hook,
      hook_reason: 'Template hook for this industry — edit it to match your footage.',
      segments,
      cta_text: business.cta,
      pacing_notes: business.pacing,
      music_suggestion: 'Add a trending sound in the app; the clip keeps the original audio underneath.',
      post_caption: `${hook} 👀\n\n${business.cta} — link in bio.`,
      hashtags: business.hashtagSeeds.map((h) => `#${h}`),
    }, videos, platform.maxSeconds));
  }

  if (!clips.length) throw new Error('The footage is too short to build a clip from.');

  const shortest = Math.min(...clips.map(clipDuration));
  const shortNote = shortest < target * 0.8
    ? ` Clips are shorter than the ${target}s target because there wasn't enough strong footage; static, dark and silent parts were left out rather than used as filler.`
    : '';

  return {
    source: 'auto',
    summary: `Auto-edit (no AI) chose the most active moments from ${Math.round(totalFootage)}s of footage using measured motion, audio and brightness, and cut them to ${business.label.toLowerCase()} pacing.${shortNote} Hook and caption text are industry templates. Edit them below and re-render, or connect Claude for footage-aware editing.`,
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
