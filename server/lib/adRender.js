// Renders animated (motion-graphics) ads: every frame is drawn with canvas
// (animated text, photos with slow camera moves, badges, lists, a call to
// action) and piped into FFmpeg as raw video, then mixed with music.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { FFMPEG, h264Args, thumbnail } from './ffmpeg.js';
import { musicGain } from './render.js';
import { cleanOnScreenText } from './subtitles.js';
import { BOLD, HEAVY, loadFonts } from './textOverlay.js';

export const FPS = 30;
const TRANSITION = 0.4;

export const FORMATS = {
  '9:16': { label: '9:16 (TikTok, Reels, Stories)', w: 1080, h: 1920 },
  '1:1': { label: '1:1 (feed post)', w: 1080, h: 1080 },
  '4:5': { label: '4:5 (Facebook/Instagram feed ad)', w: 1080, h: 1350 },
};

export const AD_THEMES = {
  bold: { label: 'Bold', brief: 'dark background, orange accent, big uppercase text, punchy slides', bg: ['#0d0d10', '#221d26'], text: '#ffffff', sub: '#d9d4cc', accent: '#ffb03d', font: HEAVY, upper: true, transition: 'slide', radius: 10, mood: 'energetic' },
  clean: { label: 'Clean', brief: 'light warm background, blue accent, calm and trustworthy, soft wipes', bg: ['#f7f5f0', '#e9e4da'], text: '#141414', sub: '#4a4640', accent: '#2f6bff', font: HEAVY, upper: false, transition: 'wipe', radius: 18, mood: 'chill' },
  luxury: { label: 'Luxury', brief: 'black and gold, spaced capitals, slow elegant fades', bg: ['#0a0a0a', '#18140e'], text: '#f4efe6', sub: '#bfb39c', accent: '#c9a45c', font: BOLD, upper: true, tracking: 0.14, transition: 'fade', radius: 2, mood: 'chill' },
  playful: { label: 'Playful', brief: 'bright pink-to-orange gradient, rounded shapes, bouncy pops', bg: ['#ff5f8f', '#ffa53d'], text: '#ffffff', sub: '#fff3e6', accent: '#2b1d5c', font: HEAVY, upper: false, transition: 'zoom', radius: 30, mood: 'energetic' },
  neon: { label: 'Neon', brief: 'night-blue background, glowing cyan, flashes; suits gyms, barbers, nightlife', bg: ['#06071a', '#151b40'], text: '#ffffff', sub: '#aab4ff', accent: '#2ef2ff', glow: true, font: HEAVY, upper: true, transition: 'flash', radius: 12, mood: 'energetic' },
  fresh: { label: 'Fresh', brief: 'cream and green, friendly and natural; suits food, cafes, health', bg: ['#f4f0e2', '#e2ead6'], text: '#1d2b1a', sub: '#4b5a45', accent: '#3d8b4f', font: HEAVY, upper: false, transition: 'slide', radius: 22, mood: 'build' },
};

export const SCENE_TYPES = ['hook', 'photo', 'features', 'offer', 'stat', 'review', 'cta'];
export const ANIMATIONS = ['pop', 'slide', 'words', 'typewriter', 'zoom'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = (x) => 1 - (1 - clamp(x, 0, 1)) ** 3;
const easeInOut = (x) => {
  const t = clamp(x, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
const easeBack = (x) => {
  const t = clamp(x, 0, 1);
  const c1 = 1.70158;
  return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

function hexRgb(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const rgba = (hex, a) => {
  const c = hexRgb(hex) || [255, 255, 255];
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
};

/** Theme with the brand colour (if any) as the accent, and readable text on it. */
export function resolveTheme(id, accent) {
  const base = AD_THEMES[id] || AD_THEMES.bold;
  const t = { ...base };
  if (hexRgb(accent)) t.accent = `#${hexRgb(accent).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  t.onAccent = luminance(hexRgb(t.accent)) > 0.6 ? '#121212' : '#ffffff';
  t.dark = luminance(hexRgb(t.bg[0])) < 0.5;
  return t;
}

function fontStr(theme, size, weightFont) {
  return `${Math.round(size)}px "${weightFont || theme.font}"`;
}

const display = (theme, text) => {
  const s = cleanOnScreenText(text);
  return theme.upper ? s.toUpperCase() : s;
};

/** Word-wrap `text` to `maxW`, shrinking the font until it fits in `maxLines`. */
function fit(ctx, text, theme, size, maxW, maxLines, minSize = 28, font) {
  let s = size;
  for (;;) {
    ctx.font = fontStr(theme, s, font);
    const lines = wrap(ctx, text, maxW, theme, s);
    if ((lines.length <= maxLines && lines.every((l) => measure(ctx, l, theme, s) <= maxW)) || s <= minSize) return { lines: lines.slice(0, maxLines + 1), size: s };
    s = Math.max(minSize, Math.floor(s * 0.92));
  }
}

/** Height of `text` once wrapped, without drawing it. */
function textHeight(ctx, env, text, size, maxW, maxLines, font, lineGap = 1.12) {
  const t = display(env.theme, text);
  if (!t) return 0;
  const f = fit(ctx, t, env.theme, size, maxW, maxLines, Math.round(size * 0.45), font);
  return f.lines.length * f.size * lineGap;
}

function measure(ctx, text, theme, size) {
  return ctx.measureText(text).width + (theme.tracking ? theme.tracking * size * Math.max(0, text.length - 1) : 0);
}

function wrap(ctx, text, maxW, theme, size) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(ctx, next, theme, size) > maxW) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function drawTracked(ctx, text, x, y, theme, size, align) {
  if (!theme.tracking) {
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    return;
  }
  const w = measure(ctx, text, theme, size);
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.textAlign = 'left';
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + theme.tracking * size;
  }
}

/**
 * Draw wrapped text with an entrance animation.
 * p = time since the text started appearing (seconds).
 */
function animText(ctx, env, { text, x, y, size, maxW, maxLines = 3, color, anim = 'slide', p, align = 'center', font, lineGap = 1.12, glow }) {
  const { theme } = env;
  const t = display(theme, text);
  if (!t) return { height: 0, lines: [] };
  const fitted = fit(ctx, t, theme, size, maxW, maxLines, Math.round(size * 0.45), font);
  const lh = fitted.size * lineGap;
  ctx.font = fontStr(theme, fitted.size, font);
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  if (glow) {
    ctx.shadowColor = theme.accent;
    ctx.shadowBlur = fitted.size * 0.35;
  } else if (env.onPhoto) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = fitted.size * 0.18;
    ctx.shadowOffsetY = fitted.size * 0.04;
  }
  const total = fitted.lines.length;
  let wordIndex = 0;
  fitted.lines.forEach((line, li) => {
    const ly = y + li * lh;
    if (anim === 'words') {
      const words = line.split(' ');
      const widths = words.map((w) => measure(ctx, w, theme, fitted.size));
      const space = ctx.measureText(' ').width + (theme.tracking ? theme.tracking * fitted.size : 0);
      const lw = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
      let wx = align === 'center' ? x - lw / 2 : align === 'right' ? x - lw : x;
      words.forEach((w, wi) => {
        const local = (p - wordIndex++ * 0.09) / 0.3;
        if (local > 0) {
          const k = easeBack(local);
          ctx.save();
          ctx.globalAlpha *= clamp(local * 2, 0, 1);
          ctx.translate(wx + widths[wi] / 2, ly + fitted.size / 2);
          ctx.scale(k, k);
          drawTracked(ctx, w, -widths[wi] / 2, -fitted.size / 2, theme, fitted.size, 'left');
          ctx.restore();
        }
        wx += widths[wi] + space;
      });
      return;
    }
    if (anim === 'typewriter') {
      const before = fitted.lines.slice(0, li).join(' ').length;
      const shown = Math.floor(p * 28) - before;
      if (shown <= 0) return;
      const part = line.slice(0, shown);
      const full = measure(ctx, line, theme, fitted.size);
      const lx = align === 'center' ? x - full / 2 : align === 'right' ? x - full : x;
      drawTracked(ctx, part, lx, ly, theme, fitted.size, 'left');
      return;
    }
    const local = (p - li * 0.08) / 0.45;
    if (local <= 0) return;
    ctx.save();
    ctx.globalAlpha *= clamp(local * 1.6, 0, 1);
    if (anim === 'pop') {
      const k = 0.6 + 0.4 * easeBack(local);
      ctx.translate(x, ly + fitted.size / 2);
      ctx.scale(k, k);
      drawTracked(ctx, line, 0, -fitted.size / 2, theme, fitted.size, align);
    } else if (anim === 'zoom') {
      const k = 1 + 0.35 * (1 - easeOut(local));
      ctx.translate(x, ly + fitted.size / 2);
      ctx.scale(k, k);
      drawTracked(ctx, line, 0, -fitted.size / 2, theme, fitted.size, align);
    } else {
      drawTracked(ctx, line, x, ly + (1 - easeOut(local)) * fitted.size * 0.8, theme, fitted.size, align);
    }
    ctx.restore();
  });
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  return { height: total * lh, size: fitted.size, lines: fitted.lines };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Backgrounds
// ---------------------------------------------------------------------------

function drawCover(ctx, img, W, H, zoom, panX, panY) {
  const s = Math.max(W / img.width, H / img.height) * zoom;
  const w = img.width * s;
  const h = img.height * s;
  ctx.drawImage(img, (W - w) / 2 + panX * (w - W) / 2, (H - h) / 2 + panY * (h - H) / 2, w, h);
}

function drawBackground(ctx, env, scene, lt, idx) {
  const { W, H, theme } = env;
  const img = scene.photo >= 0 ? env.images[scene.photo] : null;
  if (img) {
    // Slow push-in with a gentle drift (direction varies per scene).
    const prog = lt / Math.max(1, scene.duration);
    const dir = idx % 2 ? -1 : 1;
    drawCover(ctx, img, W, H, 1.06 + 0.1 * prog, dir * (0.5 - prog) * 0.6, 0);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0.35)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.15)');
    g.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const a = env.gt * 0.15;
  const g = ctx.createLinearGradient(W / 2 - Math.cos(a) * W, H / 2 - Math.sin(a) * H * 0.5, W / 2 + Math.cos(a) * W, H / 2 + Math.sin(a) * H * 0.5);
  g.addColorStop(0, theme.bg[0]);
  g.addColorStop(1, theme.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Soft drifting accent shapes.
  const m = Math.min(W, H);
  for (let k = 0; k < 2; k++) {
    const cx = W * (k ? 0.85 : 0.12) + Math.sin(env.gt * 0.5 + k * 2) * m * 0.05;
    const cy = H * (k ? 0.18 : 0.86) + Math.cos(env.gt * 0.4 + k) * m * 0.05;
    const r = m * (k ? 0.42 : 0.5);
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, rgba(theme.accent, theme.dark ? 0.22 : 0.16));
    rg.addColorStop(1, rgba(theme.accent, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

function textColors(env, scene) {
  const onPhoto = scene.photo >= 0 && env.images[scene.photo];
  return onPhoto ? { main: '#ffffff', sub: 'rgba(255,255,255,0.88)', onPhoto: true } : { main: env.theme.text, sub: env.theme.sub, onPhoto: false };
}

function logoSize(env, big) {
  const { W, H, logo } = env;
  const m = Math.min(W, H);
  const h = big ? m * 0.2 : m * 0.075;
  const w = Math.min((logo.width / logo.height) * h, W * (big ? 0.6 : 0.3));
  return { w, h: (w / logo.width) * logo.height };
}

function drawLogo(ctx, env, big, p, y) {
  if (!env.logo) return;
  const { w, h } = logoSize(env, big);
  ctx.save();
  ctx.globalAlpha *= big ? clamp(p / 0.4, 0, 1) : 0.95;
  if (big) ctx.drawImage(env.logo, (env.W - w) / 2, y, w, h);
  else ctx.drawImage(env.logo, env.W * 0.06, env.safeTop * 0.55 - h / 2, w, h);
  ctx.restore();
}

function drawScene(ctx, env, scene, lt, idx) {
  const { W, H, theme } = env;
  drawBackground(ctx, env, scene, lt, idx);
  const c = textColors(env, scene);
  env.onPhoto = c.onPhoto;
  const m = Math.min(W, H);
  const maxW = W * 0.84;
  const cx = W / 2;
  const top = env.safeTop;
  const bottom = env.safeBottom;
  const mid = (top + bottom) / 2;
  const pulse = env.pulse;
  const anim = scene.animation;
  const big = m * (env.square ? 0.11 : 0.105);
  const glow = theme.glow && !c.onPhoto;
  if (scene.type !== 'cta') drawLogo(ctx, env, false, lt);

  switch (scene.type) {
    case 'hook': {
      const head = animText(ctx, env, { text: scene.headline, x: cx, y: mid - big * 1.4, size: big * 1.1, maxW, maxLines: 4, color: c.main, anim, p: lt, glow });
      const barY = mid - big * 1.4 + head.height + m * 0.03;
      const bw = W * 0.28 * easeOut((lt - 0.3) / 0.5);
      ctx.fillStyle = theme.accent;
      roundRect(ctx, cx - bw / 2, barY, bw, m * 0.012, m * 0.006);
      ctx.fill();
      animText(ctx, env, { text: scene.subline, x: cx, y: barY + m * 0.04, size: big * 0.45, maxW, maxLines: 3, color: c.sub, anim: 'slide', p: lt - 0.5, font: BOLD });
      break;
    }
    case 'photo': {
      // Headline in an accent box low in the frame, subline under it.
      const size = big * 0.75;
      ctx.font = fontStr(theme, size);
      const t = display(theme, scene.headline);
      if (t) {
        const fitted = fit(ctx, t, theme, size, maxW - m * 0.08, 3, Math.round(size * 0.5));
        const lh = fitted.size * 1.12;
        const boxH = fitted.lines.length * lh + m * 0.05;
        const boxW = Math.min(maxW, Math.max(...fitted.lines.map((l) => { ctx.font = fontStr(theme, fitted.size); return measure(ctx, l, theme, fitted.size); })) + m * 0.08);
        const y = bottom - boxH - m * 0.12;
        const k = easeOut(lt / 0.45);
        ctx.save();
        ctx.globalAlpha *= k;
        ctx.fillStyle = theme.accent;
        roundRect(ctx, cx - boxW / 2, y + (1 - k) * m * 0.06, boxW * (0.85 + 0.15 * k), boxH, theme.radius);
        ctx.fill();
        ctx.restore();
        animText(ctx, env, { text: scene.headline, x: cx, y: y + m * 0.025 + (1 - k) * m * 0.06, size: fitted.size, maxW: maxW - m * 0.08, maxLines: 3, color: theme.onAccent, anim: anim === 'typewriter' ? 'typewriter' : 'slide', p: lt - 0.1 });
        animText(ctx, env, { text: scene.subline, x: cx, y: y + boxH + m * 0.03, size: big * 0.4, maxW, maxLines: 2, color: c.sub, anim: 'slide', p: lt - 0.45, font: BOLD });
      }
      break;
    }
    case 'features': {
      const head = animText(ctx, env, { text: scene.headline, x: cx, y: top + m * 0.02, size: big * 0.8, maxW, maxLines: 3, color: c.main, anim, p: lt, glow });
      const items = scene.items.slice(0, 4);
      const rowH = Math.min(m * 0.17, (bottom - top - head.height - m * 0.1) / Math.max(1, items.length));
      let y = top + head.height + m * 0.08;
      items.forEach((item, i) => {
        const local = (lt - 0.45 - i * 0.4) / 0.4;
        if (local <= 0) {
          y += rowH;
          return;
        }
        const k = easeOut(local);
        const r = m * 0.04;
        const x0 = W * 0.1 - (1 - k) * W * 0.15;
        ctx.save();
        ctx.globalAlpha = clamp(local * 1.5, 0, 1);
        ctx.fillStyle = theme.accent;
        ctx.beginPath();
        ctx.arc(x0 + r, y + r, r * easeBack(local), 0, Math.PI * 2);
        ctx.fill();
        // Tick mark
        ctx.strokeStyle = theme.onAccent;
        ctx.lineWidth = r * 0.28;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x0 + r * 0.55, y + r * 1.02);
        ctx.lineTo(x0 + r * 0.9, y + r * 1.35);
        ctx.lineTo(x0 + r * 1.5, y + r * 0.68);
        ctx.stroke();
        ctx.restore();
        animText(ctx, env, { text: item, x: x0 + r * 2.7, y: y + r - big * 0.3, size: big * 0.58, maxW: W * 0.8 - r * 2.7, maxLines: 2, color: c.main, anim: 'slide', p: local * 0.45, align: 'left' });
        y += rowH;
      });
      break;
    }
    case 'offer': {
      const R = m * 0.31 * (1 + 0.035 * pulse);
      const k = easeBack(lt / 0.5);
      const cy = mid - m * 0.05;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(k, k);
      ctx.rotate(env.gt * 0.25);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = m * 0.008;
      ctx.setLineDash([m * 0.03, m * 0.025]);
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.rotate(-env.gt * 0.25);
      ctx.fillStyle = theme.accent;
      if (theme.glow) {
        ctx.shadowColor = theme.accent;
        ctx.shadowBlur = m * 0.06;
      }
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha *= clamp(lt / 0.35, 0, 1);
      animText(ctx, env, { text: scene.headline, x: cx, y: cy - R * 0.5, size: big * 0.95, maxW: R * 1.55, maxLines: 3, color: theme.onAccent, anim: 'pop', p: lt - 0.2 });
      ctx.restore();
      animText(ctx, env, { text: scene.subline, x: cx, y: cy + R * 1.25, size: big * 0.45, maxW, maxLines: 2, color: c.sub, anim: 'slide', p: lt - 0.6, font: BOLD });
      break;
    }
    case 'stat': {
      // Count up any number in the headline ("500+ cars detailed").
      const m2 = scene.headline.match(/(\d[\d,]*)/);
      let text = scene.headline;
      if (m2) {
        const target = Number(m2[1].replace(/,/g, ''));
        const n = Math.round(target * easeOut(lt / 1.2));
        text = scene.headline.replace(m2[1], n.toLocaleString('en-US'));
      }
      // Lay out with the final number so the block doesn't jump as it counts.
      const hH = textHeight(ctx, env, scene.headline, big * 1.4, maxW, 3);
      const sH = textHeight(ctx, env, scene.subline, big * 0.5, maxW, 3, BOLD);
      const y0 = mid - (hH + sH + m * 0.04) / 2;
      animText(ctx, env, { text, x: cx, y: y0, size: big * 1.4, maxW, maxLines: 3, color: theme.dark || c.onPhoto ? c.main : theme.accent, anim: 'zoom', p: lt, glow });
      animText(ctx, env, { text: scene.subline, x: cx, y: y0 + hH + m * 0.04, size: big * 0.5, maxW, maxLines: 3, color: c.sub, anim: 'slide', p: lt - 0.5, font: BOLD });
      break;
    }
    case 'review': {
      const s = m * 0.05;
      const quote = `"${cleanOnScreenText(scene.headline).replace(/^"|"$/g, '')}"`;
      const qH = textHeight(ctx, env, quote, big * 0.62, maxW, 6, BOLD);
      const y0 = mid - (s * 2 + m * 0.06 + qH + m * 0.1) / 2;
      for (let i = 0; i < 5; i++) {
        const k = easeBack((lt - i * 0.1) / 0.3);
        if (k <= 0) continue;
        drawStar(ctx, cx + (i - 2) * s * 2.4, y0 + s, s * k, theme.accent);
      }
      animText(ctx, env, { text: quote, x: cx, y: y0 + s * 2 + m * 0.06, size: big * 0.62, maxW, maxLines: 6, color: c.main, anim: anim === 'typewriter' ? 'typewriter' : 'slide', p: lt - 0.4, font: BOLD });
      animText(ctx, env, { text: scene.subline ? `- ${scene.subline}` : '', x: cx, y: y0 + s * 2 + m * 0.1 + qH, size: big * 0.42, maxW, maxLines: 1, color: c.sub, anim: 'slide', p: lt - 1, font: BOLD });
      break;
    }
    case 'cta':
    default: {
      const logoH = env.logo ? logoSize(env, true).h + m * 0.06 : 0;
      const btn = scene.items[0] || 'Book now';
      const size = big * 0.55;
      const bh = size * 2.1;
      const hH = textHeight(ctx, env, scene.headline, big, maxW, 3);
      const sH = textHeight(ctx, env, scene.subline, big * 0.42, maxW, 2, BOLD);
      const y0 = Math.max(top, mid - (logoH + hH + m * 0.08 + bh + m * 0.06 + sH) / 2);
      drawLogo(ctx, env, true, lt, y0);
      const head = animText(ctx, env, { text: scene.headline, x: cx, y: y0 + logoH, size: big, maxW, maxLines: 3, color: c.main, anim, p: lt, glow });
      ctx.font = fontStr(theme, size);
      const bt = display(theme, btn);
      const bw = Math.min(maxW, measure(ctx, bt, theme, size) + m * 0.16);
      const by = y0 + logoH + head.height + m * 0.08;
      const k = easeBack((lt - 0.4) / 0.45) * (1 + 0.04 * pulse);
      if (k > 0) {
        ctx.save();
        ctx.translate(cx, by + bh / 2);
        ctx.scale(k, k);
        ctx.fillStyle = theme.accent;
        if (theme.glow) {
          ctx.shadowColor = theme.accent;
          ctx.shadowBlur = m * 0.05;
        }
        roundRect(ctx, -bw / 2, -bh / 2, bw, bh, theme.radius > 20 ? bh / 2 : theme.radius);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = theme.onAccent;
        ctx.textBaseline = 'middle';
        drawTracked(ctx, bt, 0, 0, theme, size, 'center');
        ctx.restore();
      }
      animText(ctx, env, { text: scene.subline, x: cx, y: by + bh + m * 0.06, size: big * 0.42, maxW, maxLines: 2, color: c.sub, anim: 'slide', p: lt - 0.8, font: BOLD });
      break;
    }
  }
}

function drawStar(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Timeline + transitions
// ---------------------------------------------------------------------------

/** Scene start times; with music, every scene change lands on a beat. */
export function adTimeline(scenes, bpm) {
  const beat = bpm ? 60 / bpm : 0;
  let ideal = 0;
  let t = 0;
  // Snap each scene's END to the nearest beat (at least two beats per scene),
  // so rounding doesn't add up and the ad stays close to its target length.
  return scenes.map((s, i) => {
    ideal += s.duration;
    // Long enough to read; the closing call to action gets at least 2 seconds.
    const min = i === scenes.length - 1 ? 2 : 1.2;
    const end = beat ? Math.max(t + Math.ceil(min / beat) * beat, Math.round(ideal / beat) * beat) : ideal;
    const item = { ...s, start: t, duration: end - t };
    t = end;
    return item;
  });
}

function drawFrame(ctx, env, tl, gt) {
  const { W, H } = env;
  let i = tl.findIndex((s) => gt < s.start + s.duration);
  if (i < 0) i = tl.length - 1;
  const scene = tl[i];
  const lt = gt - scene.start;
  env.gt = gt;
  const beat = env.beat;
  env.pulse = beat ? Math.exp(-((gt % beat) / beat) * 6) : 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;

  if (i === 0 || lt >= TRANSITION) {
    drawScene(ctx, env, scene, lt, i);
    return;
  }
  const prev = tl[i - 1];
  const p = easeInOut(lt / TRANSITION);
  const kind = env.theme.transition;
  const drawPrev = () => drawScene(ctx, env, prev, prev.duration + lt, i - 1);
  const drawCur = () => drawScene(ctx, env, scene, lt, i);
  ctx.save();
  if (kind === 'slide') {
    ctx.translate(-p * W, 0);
    drawPrev();
    ctx.setTransform(1, 0, 0, 1, (1 - p) * W, 0);
    drawCur();
  } else if (kind === 'wipe') {
    drawPrev();
    ctx.beginPath();
    ctx.rect(0, 0, W * p, H);
    ctx.clip();
    drawCur();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = env.theme.accent;
    ctx.fillRect(W * p - W * 0.015, 0, W * 0.015, H);
  } else if (kind === 'zoom') {
    ctx.translate(W / 2, H / 2);
    ctx.scale(1 + p * 0.25, 1 + p * 0.25);
    ctx.translate(-W / 2, -H / 2);
    drawPrev();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = p;
    ctx.translate(W / 2, H / 2);
    ctx.scale(0.85 + 0.15 * p, 0.85 + 0.15 * p);
    ctx.translate(-W / 2, -H / 2);
    drawCur();
  } else if (kind === 'flash') {
    if (p < 0.5) drawPrev();
    else drawCur();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1 - Math.abs(p - 0.5) * 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  } else {
    drawPrev();
    ctx.globalAlpha = p;
    drawCur();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * @param {object} ad        sanitised ad (theme, accent, scenes[])
 * @param {object} opts      { outDir, baseName, format, images: [path|null], logo: path|null,
 *                             music: { path, startAt, loudness, bpm } | null, musicLevel, onProgress }
 */
export async function renderAd(ad, opts) {
  loadFonts();
  const { outDir, baseName, format = '9:16', music, musicLevel = 'normal', onProgress } = opts;
  const { w: W, h: H } = FORMATS[format] || FORMATS['9:16'];
  const theme = resolveTheme(ad.theme, ad.accent);
  const images = await Promise.all((opts.images || []).map((p) => (p ? loadImage(p) : null)));
  const logo = opts.logo ? await loadImage(opts.logo) : null;
  const tl = adTimeline(ad.scenes, music?.bpm);
  const total = tl.reduce((s, x) => s + x.duration, 0);
  const frames = Math.round(total * FPS);
  const square = H / W < 1.4;
  const env = {
    W, H, theme, images, logo, square,
    beat: music?.bpm ? 60 / music.bpm : 0,
    // Keep text clear of app buttons: top bar, and captions/buttons at the bottom on 9:16.
    safeTop: square ? H * 0.09 : H * 0.15,
    safeBottom: square ? H * 0.91 : H * 0.74,
  };

  await fs.mkdir(outDir, { recursive: true });
  const mp4Name = `${baseName}.mp4`;
  const args = ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0'];
  let audioFilter;
  if (music) {
    args.push('-stream_loop', '-1', '-ss', (music.startAt || 0).toFixed(3), '-i', music.path);
    const level = { soft: 0.6, normal: 1, loud: 1.6 }[musicLevel] ?? 1;
    audioFilter = `[1:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${(level * musicGain(music)).toFixed(3)},afade=t=out:st=${Math.max(0, total - 1.2).toFixed(3)}:d=1.2,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[a]`;
  } else {
    // Silent track: some apps reject videos with no audio stream.
    args.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo');
    audioFilter = '[1:a]anull[a]';
  }
  args.push(
    '-filter_complex', `[0:v]format=yuv420p[v];${audioFilter}`,
    '-map', '[v]', '-map', '[a]', '-t', total.toFixed(3),
    ...(await h264Args()),
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-movflags', '+faststart',
    path.join(outDir, mp4Name),
  );

  const child = spawn(FFMPEG, args, { windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-20000);
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err.code === 'ENOENT' ? new Error('FFmpeg was not found. Install it with: brew install ffmpeg') : err));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-4).join('\n')}`))));
  });
  // Swallow EPIPE here; the real error comes from `done`.
  child.stdin.on('error', () => {});

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  let failed = false;
  done.catch(() => {
    failed = true;
  });
  for (let f = 0; f < frames && !failed; f++) {
    drawFrame(ctx, env, tl, f / FPS);
    if (!child.stdin.write(canvas.data())) await new Promise((r) => child.stdin.once('drain', r));
    if (f % 15 === 0) onProgress?.(f / frames);
  }
  child.stdin.end();
  await done;

  const thumbName = `${baseName}.jpg`;
  await thumbnail(path.join(outDir, mp4Name), path.join(outDir, thumbName), Math.min(1.5, total / 3));
  return {
    file: mp4Name,
    thumb: thumbName,
    duration: Math.round(total * 10) / 10,
    scenes: tl.map((s) => ({ type: s.type, start: Math.round(s.start * 100) / 100, duration: Math.round(s.duration * 100) / 100 })),
  };
}

/** Render one frame to PNG (used by tests and for quick previews). */
export async function renderAdFrame(ad, t, out, { format = '9:16', images = [], logo = null, bpm = 0 } = {}) {
  loadFonts();
  const { w: W, h: H } = FORMATS[format] || FORMATS['9:16'];
  const square = H / W < 1.4;
  const env = {
    W, H, square, theme: resolveTheme(ad.theme, ad.accent),
    images: await Promise.all(images.map((p) => (p ? loadImage(p) : null))),
    logo: logo ? await loadImage(logo) : null,
    beat: bpm ? 60 / bpm : 0,
    safeTop: square ? H * 0.09 : H * 0.15,
    safeBottom: square ? H * 0.91 : H * 0.74,
  };
  const canvas = createCanvas(W, H);
  drawFrame(canvas.getContext('2d'), env, adTimeline(ad.scenes, bpm), t);
  await fs.writeFile(out, await canvas.encode('png'));
  return out;
}
