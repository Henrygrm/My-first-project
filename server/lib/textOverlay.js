// Draws on-screen text (hook, captions, CTA, speech, split-screen tags) as
// transparent PNGs that FFmpeg overlays onto the video. Works with any FFmpeg
// build (no libass needed). Each video style has its own text theme.
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { cleanOnScreenText } from './subtitles.js';

const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
const HEAVY = 'Cutline Inter ExtraBold';
const BOLD = 'Cutline Inter Bold';
let fontsLoaded = false;

function loadFonts() {
  if (fontsLoaded) return;
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Inter-ExtraBold.otf'), HEAVY);
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Inter-Bold.otf'), BOLD);
  fontsLoaded = true;
}

const W = 1080;
const H = 1920;

// Positions keep text clear of TikTok/Reels buttons (top ~12%, bottom ~25%,
// right edge). anchor says whether `y` is the block's top, middle or bottom.
const BASE = {
  Hook: { size: 82, font: HEAVY, color: '#101010', box: '#ffffff', pad: 22, margin: 60, anchor: 'top', y: 330, radius: 12 },
  Caption: { size: 66, font: HEAVY, color: '#ffffff', outline: 5, shadow: true, margin: 120, anchor: 'top', y: 360 },
  CTA: { size: 78, font: HEAVY, color: '#101010', box: '#ffb03d', pad: 24, margin: 80, anchor: 'middle', y: 1180, radius: 14 },
  Speech: { size: 60, font: HEAVY, color: '#ffffff', outline: 5, shadow: true, margin: 120, anchor: 'bottom', y: H - 560 },
  TagTop: { size: 40, font: HEAVY, color: '#101010', box: '#ffffff', pad: 12, margin: 60, anchor: 'top', y: 260, align: 'left', x: 60, radius: 8, upper: true },
  TagBottom: { size: 40, font: HEAVY, color: '#101010', box: '#3ddc97', pad: 12, margin: 60, anchor: 'top', y: 1000, align: 'left', x: 60, radius: 8, upper: true },
};

const THEMES = {
  box: {},
  bold: {
    Hook: { size: 92, color: '#ffffff', box: null, outline: 9, shadow: true, upper: true, pad: 0 },
    Caption: { size: 74, color: '#ffe14d', outline: 7, upper: true },
    CTA: { size: 84, color: '#ffffff', box: '#ff4d2e', upper: true },
  },
  minimal: {
    Hook: { size: 66, font: BOLD, color: '#ffffff', box: null, outline: 0, shadow: true, lower: true, pad: 0, glow: true },
    Caption: { size: 54, font: BOLD, color: '#ffffff', outline: 0, shadow: true, lower: true, glow: true },
    CTA: { size: 60, font: BOLD, color: '#ffffff', box: 'rgba(0,0,0,0.45)', lower: true, radius: 40, pad: 20 },
  },
  story: {
    Hook: { size: 72, color: '#ffffff', box: 'rgba(12,12,16,0.72)', radius: 18, pad: 22 },
    Caption: { size: 58, font: BOLD, color: '#ffffff', box: 'rgba(12,12,16,0.62)', outline: 0, shadow: false, radius: 16, pad: 16, anchor: 'bottom', y: H - 600 },
    CTA: { size: 70, color: '#101010', box: '#ffd28a', radius: 18 },
  },
  list: {
    Hook: { size: 80, color: '#101010', box: '#ffffff' },
    Caption: { size: 64, color: '#ffffff', outline: 6, badge: '#ffb03d' },
    CTA: { size: 76, color: '#101010', box: '#ffb03d' },
  },
  promo: {
    Hook: { size: 90, color: '#101010', box: '#ffd400', upper: true, radius: 6 },
    Caption: { size: 66, color: '#ffffff', box: '#101010', outline: 0, shadow: false, pad: 16, radius: 6, upper: true },
    CTA: { size: 96, color: '#101010', box: '#ffd400', upper: true, radius: 6, pad: 30 },
  },
};

export function textStyle(role, theme) {
  return { ...BASE[role] || BASE.Caption, ...(THEMES[theme]?.[role] || {}) };
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Render one text event to a tightly-cropped transparent PNG.
 * @returns {{ file: string, x: number, y: number, w: number, h: number } | null}
 */
export async function renderTextPng(text, role, theme, outPath) {
  loadFonts();
  const st = textStyle(role, theme);
  let clean = cleanOnScreenText(text);
  if (!clean) return null;

  // List captions like "2. Fresh every morning" get a number badge.
  let badge = null;
  if (st.badge) {
    const m = clean.match(/^(\d{1,2})[.)]\s*(.+)$/);
    if (m) [badge, clean] = [m[1], m[2]];
  }
  if (st.upper) clean = clean.toUpperCase();
  if (st.lower) clean = clean.toLowerCase();

  const font = `${st.size}px "${st.font || HEAVY}"`;
  const measure = createCanvas(10, 10).getContext('2d');
  measure.font = font;
  const pad = st.box ? st.pad ?? 20 : 0;
  const edge = (st.outline || 0) + (st.shadow ? 6 : 0) + (st.glow ? 12 : 0);
  const badgeW = badge ? Math.round(st.size * 1.25) + 18 : 0;
  const lines = wrap(measure, clean, W - st.margin * 2 - pad * 2 - badgeW);
  const lineH = Math.round(st.size * 1.18);
  const textW = Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width)));
  const blockH = lineH * lines.length;
  const w = textW + pad * 2 + edge * 2 + badgeW;
  const h = Math.max(blockH, badge ? Math.round(st.size * 1.25) : 0) + pad * 2 + edge * 2;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'middle';

  if (st.box) {
    ctx.fillStyle = st.box;
    ctx.beginPath();
    ctx.roundRect(edge + badgeW, edge, w - edge * 2 - badgeW, h - edge * 2, st.radius ?? 10);
    ctx.fill();
  }

  if (badge) {
    const r = Math.round(st.size * 0.62);
    const cy = h / 2;
    ctx.fillStyle = st.badge;
    ctx.beginPath();
    ctx.arc(edge + r, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#101010';
    ctx.textAlign = 'center';
    ctx.fillText(badge, edge + r, cy + 2);
  }

  ctx.textAlign = 'center';
  const cx = edge + badgeW + (w - edge * 2 - badgeW) / 2;
  const top = (h - blockH) / 2;
  lines.forEach((line, i) => {
    const cy = top + lineH * i + lineH / 2;
    if (st.glow) {
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = 18;
    }
    if (st.shadow) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(line, cx + 3, cy + 5);
    }
    ctx.shadowBlur = 0;
    if (st.outline) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = st.outline * 2;
      ctx.strokeStyle = '#000000';
      ctx.strokeText(line, cx, cy);
    }
    ctx.fillStyle = st.color;
    ctx.fillText(line, cx, cy);
  });

  await fs.writeFile(outPath, await canvas.encode('png'));
  const x = st.align === 'left' ? st.x : Math.round((W - w) / 2);
  const topY = st.anchor === 'top' ? st.y : st.anchor === 'middle' ? st.y - h / 2 : st.y - h;
  return { file: outPath, x, y: Math.round(Math.max(0, Math.min(H - h, topY))), w, h };
}
