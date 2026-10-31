// Image analysis for the asset pipeline: size, sharpness, brightness and
// dominant colours (photos), brand colours (logos). Pure pixel maths, local.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { contrast, rgbToHex, toHsl } from '../../public/engine/core.js';

/** k-means over sampled pixels; returns colours sorted by share. */
function dominantColors(pixels, k = 5, { skipNeutral = false, skipAlpha = true } = {}) {
  const pts = [];
  for (let i = 0; i < pixels.length; i += 4) {
    if (skipAlpha && pixels[i + 3] < 128) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (skipNeutral) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn < 22 && (mx > 235 || mx < 25)) continue; // near-white / near-black
    }
    pts.push([r, g, b]);
  }
  if (!pts.length) return [];
  let centers = Array.from({ length: Math.min(k, pts.length) }, (_, i) => pts[Math.floor((i + 0.5) * pts.length / Math.min(k, pts.length))].slice());
  let assign = new Array(pts.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (pts[i][0] - centers[c][0]) ** 2 + (pts[i][1] - centers[c][1]) ** 2 + (pts[i][2] - centers[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const s = sums[assign[i]];
      s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++;
    }
    centers = sums.map((s, c) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centers[c]));
  }
  const counts = centers.map(() => 0);
  for (const a of assign) counts[a]++;
  return centers
    .map((c, i) => ({ hex: rgbToHex(c), share: counts[i] / pts.length }))
    .filter((c) => c.share > 0.02)
    .sort((a, b) => b.share - a.share);
}

/** Variance of the Laplacian on a 256px greyscale version: higher = sharper. */
function sharpness(gray, w, h) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += v; sum2 += v * v; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export async function analyzeImage(file, { kind = 'photo' } = {}) {
  const img = await loadImage(file);
  const W = img.width, H = img.height;
  const S = 256;
  const sw = W >= H ? S : Math.round((S * W) / H);
  const sh = W >= H ? Math.round((S * H) / W) : S;
  const c = createCanvas(sw, sh);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, sw, sh);
  const px = g.getImageData(0, 0, sw, sh).data;
  const gray = new Float32Array(sw * sh);
  let lum = 0, opaque = 0, transparent = 0;
  for (let i = 0; i < sw * sh; i++) {
    const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2], a = px[i * 4 + 3];
    gray[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
    if (a > 128) { lum += gray[i]; opaque++; } else transparent++;
  }
  const out = {
    w: W, h: H, megapixels: Math.round((W * H) / 1e4) / 100,
    brightness: Math.round(lum / Math.max(1, opaque)),
    sharpness: Math.round(sharpness(gray, sw, sh)),
    transparent: transparent / (sw * sh) > 0.05,
  };
  if (kind === 'logo') {
    const cols = dominantColors(px, 6, { skipNeutral: true });
    const all = dominantColors(px, 4, { skipNeutral: false });
    out.colors = cols.map((x) => x.hex);
    out.allColors = all.map((x) => x.hex);
    // Mostly dark ink or mostly light ink: decides whether the logo needs a plate.
    out.ink = all.length ? (toHsl(all[0].hex)[2] < 0.5 ? 'dark' : 'light') : 'dark';
  } else {
    out.colors = dominantColors(px, 5).map((x) => x.hex);
  }
  return out;
}

/** Does a logo need a light/dark plate behind it to be visible on background `bg`? */
export function logoNeedsPlate(analysis, bg) {
  if (!analysis) return false;
  if (!analysis.transparent) return false; // has its own background box
  const main = analysis.allColors?.[0];
  return main ? contrast(main, bg) < 2.2 : false;
}

/** Plain-English quality notes for a photo (used by QA and the asset panel). */
export function photoQuality(a, { targetLong = 1920 } = {}) {
  const notes = [];
  const long = Math.max(a.w, a.h);
  if (long < targetLong * 0.5) notes.push({ level: 'warn', text: `Low resolution (${a.w}×${a.h}); it will look soft at full screen.` });
  if (a.sharpness < 60) notes.push({ level: 'warn', text: 'Looks blurry or out of focus.' });
  if (a.brightness < 45) notes.push({ level: 'warn', text: 'Very dark.' });
  if (a.brightness > 225) notes.push({ level: 'info', text: 'Very bright / washed out.' });
  return notes;
}
