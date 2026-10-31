// Cutline motion engine: shared maths, colour and text helpers.
// Runs unchanged in Node (final renders, via @napi-rs/canvas) and in the
// browser (live preview), so nothing here may import Node or DOM modules.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const fract = (x) => x - Math.floor(x);

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

function cubicBezier(x1, y1, x2, y2) {
  // Newton-Raphson solve of x(t) = x, then y(t).
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (sx(t) - x) / d;
    }
    return sy(clamp(t, 0, 1));
  };
}

export const EASE = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  outCubic: (t) => 1 - (1 - t) ** 3,
  inCubic: (t) => t ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  outQuart: (t) => 1 - (1 - t) ** 4,
  inOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  outBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  outBackSoft: (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2,
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  // Designer curves (the "Material" / Apple-like feels).
  smooth: cubicBezier(0.4, 0, 0.2, 1),
  snappy: cubicBezier(0.2, 0.9, 0.1, 1),
  glide: cubicBezier(0.16, 1, 0.3, 1),
  luxe: cubicBezier(0.65, 0, 0.35, 1),
  anticipate: cubicBezier(0.36, -0.25, 0.3, 1.2),
};

/** Damped spring settling to 1 (stiffness and damping in friendly units). */
export function spring(t, { stiffness = 170, damping = 18 } = {}) {
  if (t <= 0) return 0;
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

export const ease = (name, t) => (EASE[name] || EASE.outCubic)(clamp(t, 0, 1));

// ---------------------------------------------------------------------------
// Keyframes: [[time, value, easeName?], ...] → value at time t.
// Values can be numbers or #rrggbb colours.
// ---------------------------------------------------------------------------

export function sampleTrack(track, t, fallback) {
  if (track === undefined || track === null) return fallback;
  if (!Array.isArray(track)) return track;
  if (!track.length) return fallback;
  if (t <= track[0][0]) return track[0][1];
  for (let i = 1; i < track.length; i++) {
    const [t1, v1, e] = track[i];
    if (t <= t1) {
      const [t0, v0] = track[i - 1];
      const k = ease(e || 'inOutCubic', (t - t0) / Math.max(1e-6, t1 - t0));
      return typeof v0 === 'string' ? mixColor(v0, v1, k) : lerp(v0, v1, k);
    }
  }
  return track[track.length - 1][1];
}

// ---------------------------------------------------------------------------
// Seeded randomness (deterministic: preview and final render match)
// ---------------------------------------------------------------------------

export function rng(seed = 1) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Smooth 1D value noise in [-1, 1]. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n) => {
    const s = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u);
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export function hexToRgb(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = ([r, g, b]) => `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;

export function rgba(hex, a = 1) {
  const c = hexToRgb(hex) || [255, 255, 255];
  return `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1)})`;
}

export function mixColor(a, b, t) {
  const x = hexToRgb(a) || [0, 0, 0];
  const y = hexToRgb(b) || [0, 0, 0];
  return rgbToHex([lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)]);
}

export function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

export const hsl = (h, s, l) => rgbToHex(hslToRgb([h, clamp(s, 0, 1), clamp(l, 0, 1)]));
export const toHsl = (hex) => rgbToHsl(hexToRgb(hex) || [0, 0, 0]);

/** WCAG relative luminance and contrast ratio. */
export function luminance(hex) {
  const c = (hexToRgb(hex) || [0, 0, 0]).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on `bg` (or `light`/`dark` overrides). */
export function readableOn(bg, light = '#ffffff', dark = '#111111') {
  return contrast(light, bg) >= contrast(dark, bg) ? light : dark;
}

/** Nudge `fg` lighter/darker until it reaches `min` contrast on `bg`. */
export function ensureContrast(fg, bg, min = 4.5) {
  if (contrast(fg, bg) >= min) return fg;
  const [h, s, l] = toHsl(fg);
  const lighter = luminance(bg) < 0.4;
  for (let k = 1; k <= 20; k++) {
    const c = hsl(h, s, clamp(lighter ? l + k * 0.04 : l - k * 0.04, 0, 1));
    if (contrast(c, bg) >= min) return c;
  }
  return readableOn(bg);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Font descriptor → canvas font string. font = { family, weight, style } */
export function fontString(font, px) {
  return `${font.style === 'italic' ? 'italic ' : ''}${font.weight || 700} ${Math.round(px)}px "${font.family}"`;
}

export function applyCase(text, mode) {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  return text;
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
export const cleanText = (t) => String(t || '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();

/**
 * Split "Fresh *flat whites* daily" into words with an emphasis flag.
 * Emphasis (between asterisks) is drawn in the accent treatment.
 */
export function parseWords(text) {
  const words = [];
  let em = false;
  for (const raw of cleanText(text).split(' ')) {
    let w = raw;
    const start = w.startsWith('*');
    if (start) w = w.slice(1);
    const end = w.endsWith('*');
    if (end) w = w.slice(0, -1);
    if (start) em = true;
    if (w) words.push({ text: w, em });
    if (end) em = false;
  }
  return words;
}

function measureWord(ctx, word, tracking, size) {
  return ctx.measureText(word).width + (tracking ? tracking * size * Math.max(0, word.length - 1) : 0);
}

/**
 * Lay out words into lines that fit maxW, shrinking the font until the text
 * fits in maxLines (and maxH if given). Returns positioned words.
 */
export function layoutText(ctx, { text, font, size, maxW, maxLines = 3, maxH = Infinity, caseMode, tracking = 0, lineHeight = 1.08, minSize = 12, align = 'center' }) {
  const words = parseWords(text).map((w) => ({ ...w, text: applyCase(w.text, caseMode) }));
  if (!words.length) return { lines: [], size, width: 0, height: 0, words: [] };
  let s = size;
  for (let guard = 0; guard < 40; guard++) {
    ctx.font = fontString(font, s);
    // Negative tracking tightens letters but must never swallow word gaps.
    const space = Math.max(ctx.measureText(' ').width + tracking * s, s * 0.26);
    const lines = [];
    let cur = [];
    let curW = 0;
    for (const w of words) {
      const ww = measureWord(ctx, w.text, tracking, s);
      const next = cur.length ? curW + space + ww : ww;
      if (cur.length && next > maxW) {
        lines.push({ words: cur, width: curW });
        cur = [{ ...w, w: ww }];
        curW = ww;
      } else {
        cur.push({ ...w, w: ww });
        curW = next;
      }
    }
    if (cur.length) lines.push({ words: cur, width: curW });
    const lh = s * lineHeight;
    const tooWide = lines.some((l) => l.width > maxW * 1.001);
    const tooTall = lines.length > maxLines || lines.length * lh > maxH;
    if ((!tooWide && !tooTall) || s <= minSize) {
      const out = [];
      let idx = 0;
      lines.forEach((line, li) => {
        let x = align === 'left' ? 0 : align === 'right' ? -line.width : -line.width / 2;
        for (const w of line.words) {
          out.push({ text: w.text, em: w.em, x, y: li * lh, w: w.w, line: li, index: idx++ });
          x += w.w + space;
        }
      });
      return { lines, size: s, width: Math.max(...lines.map((l) => l.width)), height: lines.length * lh, lineHeight: lh, words: out, space };
    }
    s = Math.max(minSize, s * 0.93);
  }
  return { lines: [], size: s, width: 0, height: 0, words: [] };
}

/** Draw one word honouring letter tracking. Baseline must be 'top'. */
export function drawWord(ctx, text, x, y, size, tracking = 0, stroke = false) {
  if (!tracking) {
    stroke ? ctx.strokeText(text, x, y) : ctx.fillText(text, x, y);
    return;
  }
  let cx = x;
  for (const ch of text) {
    stroke ? ctx.strokeText(ch, cx, y) : ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking * size;
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
