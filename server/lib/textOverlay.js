// Draws on-screen text (hook, captions, CTA, speech) as transparent PNGs that
// FFmpeg overlays onto the video. Used when the local FFmpeg was built without
// libass (no `subtitles` filter), which is the case for Homebrew's default
// build. Matches the look of the ASS styles in subtitles.js.
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { cleanOnScreenText } from './subtitles.js';

const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
const FAMILY = 'Cutline Inter';
let fontsLoaded = false;

function loadFonts() {
  if (fontsLoaded) return;
  GlobalFonts.registerFromPath(path.join(FONTS_DIR, 'Inter-ExtraBold.otf'), FAMILY);
  fontsLoaded = true;
}

const W = 1080;
const H = 1920;

// anchor: where `y` refers to — the block's top, middle or bottom edge.
const STYLES = {
  Hook: { size: 82, color: '#101010', box: '#ffffff', pad: 22, margin: 60, anchor: 'top', y: 330 },
  Caption: { size: 66, color: '#ffffff', outline: 5, shadow: true, margin: 120, anchor: 'top', y: 360 },
  CTA: { size: 78, color: '#101010', box: '#ffb03d', pad: 24, margin: 80, anchor: 'middle', y: H / 2 },
  Speech: { size: 60, color: '#ffffff', outline: 5, shadow: true, margin: 120, anchor: 'bottom', y: H - 560 },
};

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
 * @returns {{ file: string, x: number, y: number } | null}
 */
export async function renderTextPng(text, styleName, outPath) {
  loadFonts();
  const st = STYLES[styleName] || STYLES.Caption;
  const clean = cleanOnScreenText(text);
  if (!clean) return null;

  const measure = createCanvas(10, 10).getContext('2d');
  measure.font = `${st.size}px "${FAMILY}"`;
  const pad = st.pad || 0;
  const edge = (st.outline || 0) + (st.shadow ? 4 : 0);
  const lines = wrap(measure, clean, W - st.margin * 2 - pad * 2);
  const lineH = Math.round(st.size * 1.18);
  const textW = Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width)));
  const w = textW + pad * 2 + edge * 2;
  const h = lineH * lines.length + pad * 2 + edge * 2;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.font = `${st.size}px "${FAMILY}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (st.box) {
    ctx.fillStyle = st.box;
    ctx.beginPath();
    ctx.roundRect(edge, edge, w - edge * 2, h - edge * 2, 10);
    ctx.fill();
  }

  lines.forEach((line, i) => {
    const cx = w / 2;
    const cy = edge + pad + lineH * i + lineH / 2;
    if (st.shadow) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(line, cx + 3, cy + 4);
    }
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
  const x = Math.round((W - w) / 2);
  const top = st.anchor === 'top' ? st.y : st.anchor === 'middle' ? st.y - h / 2 : st.y - h;
  return { file: outPath, x, y: Math.round(Math.max(0, Math.min(H - h, top))) };
}
