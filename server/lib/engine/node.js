// Node side of the motion engine: fonts, image loading and an env for
// renderFrame. Video frames come from FFmpeg (see video.js).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage, Path2D } from '@napi-rs/canvas';
import { FONT_FILES } from '../../../public/engine/fonts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FONT_DIR = path.join(ROOT, 'assets', 'fonts', 'lib');

// The engine draws icons with Path2D, which browsers provide globally.
if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = Path2D;

let fontsDone = false;
export function registerFonts() {
  if (fontsDone) return;
  for (const f of FONT_FILES) GlobalFonts.registerFromPath(path.join(FONT_DIR, f.file), f.family);
  fontsDone = true;
}

/**
 * Load images for a composition.
 * spec: { id: { path, cutPath?, focus? } } → env.assets { id: { img, w, h, cut, cutW, cutH, focus } }
 */
export async function loadAssets(spec) {
  const out = {};
  for (const [id, a] of Object.entries(spec)) {
    try {
      const img = await loadImage(a.path);
      const entry = { img, w: img.width, h: img.height, focus: a.focus || { x: 0.5, y: 0.5 } };
      if (a.cutPath) {
        try {
          const cut = await loadImage(a.cutPath);
          Object.assign(entry, { cut, cutW: cut.width, cutH: cut.height });
        } catch {}
      }
      out[id] = entry;
    } catch {
      // A missing or unreadable file: recipes fall back to designs without it.
    }
  }
  return out;
}

export function makeEnv(assets, video, { externalGrade = false } = {}) {
  return { makeCanvas: (w, h) => createCanvas(w, h), assets, video, externalGrade };
}

export { createCanvas };
