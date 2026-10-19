// Builds the on-screen text for a rendered clip as an ASS subtitle file
// (burned in by FFmpeg/libass) plus a plain SRT for uploading as captions.
//
// Layout is designed for 1080x1920 with platform UI safe zones in mind:
// the top ~12% and bottom ~25% are covered by app chrome on TikTok/Reels.

const W = 1080;
const H = 1920;

// libass cannot render colour emoji and would draw empty boxes instead.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

export function cleanOnScreenText(text) {
  return String(text || '')
    .replace(EMOJI, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function assEscape(text) {
  return cleanOnScreenText(text).replace(/\\/g, '\\\\').replace(/[{}]/g, '');
}

function assTime(t) {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}

function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

/**
 * Map transcript words from source time into output time, following the
 * clip's segment list (each with source start/end, speed, output offset).
 */
export function mapTranscript(words, timeline) {
  const out = [];
  for (const seg of timeline) {
    for (const w of words) {
      if (w.video !== seg.video) continue;
      const mid = (w.start + w.end) / 2;
      if (mid < seg.start || mid >= seg.end) continue;
      out.push({
        text: w.text,
        start: seg.outStart + (Math.max(w.start, seg.start) - seg.start) / seg.speed,
        end: seg.outStart + (Math.min(w.end, seg.end) - seg.start) / seg.speed,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Group words into short 2–4 word chunks, the style that reads well on mobile. */
export function chunkWords(words, maxWords = 4, maxGap = 0.6) {
  const chunks = [];
  let cur = null;
  for (const w of words) {
    if (cur && (cur.words.length >= maxWords || w.start - cur.end > maxGap || /[.!?]$/.test(cur.words.at(-1)))) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: w.start, end: w.end, words: [] };
    cur.words.push(w.text.trim());
    cur.end = w.end;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => ({ start: c.start, end: Math.max(c.end, c.start + 0.3), text: c.words.join(' ') }));
}

/**
 * @param {object} clip      { hook_text, cta_text }
 * @param {Array}  timeline  segments with outStart/outEnd/caption
 * @param {number} duration  total output duration
 * @param {object} opts      { onScreenText, speech: [{start,end,text}] }
 */
export function buildSubtitles(clip, timeline, duration, opts = {}) {
  const events = []; // { start, end, style, text, fx }
  const srt = [];
  const onScreen = opts.onScreenText !== false;

  const hookEnd = Math.min(duration, Math.max(2.2, Math.min(3.2, timeline[0]?.outEnd ?? 2.5)));
  const ctaStart = Math.max(hookEnd, duration - 2.6);

  if (onScreen && clip.hook_text) {
    events.push({ start: 0, end: hookEnd, style: 'Hook', text: clip.hook_text, fx: '{\\fscx85\\fscy85\\t(0,140,\\fscx100\\fscy100)\\fad(0,120)}' });
  }

  if (onScreen) {
    for (const seg of timeline) {
      if (!seg.caption) continue;
      const start = Math.max(seg.outStart, hookEnd);
      const end = Math.min(seg.outEnd, ctaStart);
      if (end - start < 0.6) continue;
      events.push({ start, end, style: 'Caption', text: seg.caption, fx: '{\\fad(90,90)}' });
    }
  }

  if (onScreen && clip.cta_text && duration - ctaStart > 0.8) {
    events.push({ start: ctaStart, end: duration, style: 'CTA', text: clip.cta_text, fx: '{\\fscx85\\fscy85\\t(0,160,\\fscx100\\fscy100)\\fad(120,0)}' });
  }

  for (const s of opts.speech || []) {
    if (s.end <= s.start) continue;
    events.push({ start: s.start, end: s.end, style: 'Speech', text: s.text, fx: '' });
  }

  // SRT: everything readable, in time order (useful as platform captions).
  for (const e of [...events].sort((a, b) => a.start - b.start)) {
    const text = cleanOnScreenText(e.text);
    if (text) srt.push({ start: e.start, end: e.end, text });
  }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Inter ExtraBold,82,&H00101010,&H00101010,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,22,0,8,110,110,330,1
Style: Caption,Inter ExtraBold,66,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,5,2,8,120,120,360,1
Style: CTA,Inter ExtraBold,78,&H00101010,&H00101010,&H003DB0FF,&H003DB0FF,0,0,0,0,100,100,0,0,3,24,0,5,120,120,0,1
Style: Speech,Inter ExtraBold,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,0,0,0,0,100,100,0,0,1,5,2,2,120,120,560,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = events
    .filter((e) => assEscape(e.text))
    .map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.fx}${assEscape(e.text)}`);

  const srtText = srt
    .map((e, i) => `${i + 1}\n${srtTime(e.start)} --> ${srtTime(e.end)}\n${e.text}\n`)
    .join('\n');

  return { ass: header + lines.join('\n') + '\n', srt: srtText, hasEvents: lines.length > 0 };
}
