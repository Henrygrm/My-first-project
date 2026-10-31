// Local background removal: cuts the subject out of a photo (a coffee, a car,
// a haircut) so the motion engine can place it like a studio product shot.
// Runs the ISNet model with onnxruntime-node on this computer: free, private,
// no API. The model (178 MB, Apache-2.0, from the rembg project) downloads
// on first use. If onnxruntime-node is not installed, cutouts are skipped and
// everything else still works.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { DATA_DIR } from './store.js';
import { log } from './log.js';

const require = createRequire(import.meta.url);
const MODEL_DIR = process.env.CUTLINE_MODEL_DIR || path.join(DATA_DIR, 'models');

export const MODELS = {
  'isnet-general-use': { size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1], bytes: 178648008 },
  u2netp: { size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], bytes: 4574861 },
};
const DEFAULT_MODEL = process.env.CUTLINE_CUTOUT_MODEL || 'isnet-general-use';
const URL = (name) => `https://github.com/danielgatis/rembg/releases/download/v0.0.0/${name}.onnx`;

let ort = null;
let ortError = null;
function runtime() {
  if (ort || ortError) return ort;
  try {
    ort = require('onnxruntime-node');
  } catch (err) {
    ortError = err;
    log('warn', 'onnxruntime-node not available; photo cutouts disabled:', err.message);
  }
  return ort;
}

export function cutoutsAvailable() {
  return Boolean(runtime());
}

const sessions = new Map();

async function ensureModel(name, onStage) {
  const file = path.join(MODEL_DIR, `${name}.onnx`);
  try {
    const st = await fsp.stat(file);
    if (st.size === MODELS[name].bytes) return file;
  } catch {}
  await fsp.mkdir(MODEL_DIR, { recursive: true });
  onStage?.(`Downloading the photo cut-out model (${Math.round(MODELS[name].bytes / 1e6)} MB, first time only)…`);
  const res = await fetch(URL(name));
  if (!res.ok || !res.body) throw new Error(`Couldn't download the cut-out model (HTTP ${res.status}). Check your internet connection.`);
  const tmp = `${file}.part`;
  await pipeline(res.body, fs.createWriteStream(tmp));
  const st = await fsp.stat(tmp);
  if (st.size !== MODELS[name].bytes) {
    await fsp.rm(tmp, { force: true });
    throw new Error('The cut-out model download was incomplete. Try again.');
  }
  await fsp.rename(tmp, file);
  return file;
}

async function session(name, onStage) {
  if (!sessions.has(name)) {
    const file = await ensureModel(name, onStage);
    sessions.set(name, await runtime().InferenceSession.create(file, { graphOptimizationLevel: 'all' }));
  }
  return sessions.get(name);
}

/**
 * Cut out the main subject of an image.
 * Returns { file, w, h, box: {x,y,w,h} in source pixels, coverage, confidence, usable }
 * and writes a transparent PNG cropped to the subject.
 */
export async function cutout(srcPath, outPath, { model = DEFAULT_MODEL, onStage } = {}) {
  if (!runtime()) return null;
  const cfg = MODELS[model] || MODELS[DEFAULT_MODEL];
  const sess = await session(model, onStage);
  const img = await loadImage(srcPath);
  const W = img.width, H = img.height, S = cfg.size;

  // Pre-process: squash to S×S, normalise into a CHW float tensor.
  const c = createCanvas(S, S);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, S, S);
  const px = g.getImageData(0, 0, S, S).data;
  const data = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    for (let ch = 0; ch < 3; ch++) data[ch * S * S + i] = (px[i * 4 + ch] / 255 - cfg.mean[ch]) / cfg.std[ch];
  }
  const feeds = { [sess.inputNames[0]]: new (runtime().Tensor)('float32', data, [1, 3, S, S]) };
  const out = await sess.run(feeds);
  const pred = out[sess.outputNames[0]].data;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < S * S; i++) {
    if (pred[i] < mn) mn = pred[i];
    if (pred[i] > mx) mx = pred[i];
  }
  const range = mx - mn || 1;

  // Mask → alpha with a gentle curve that removes haze but keeps soft edges.
  const mask = g.createImageData(S, S);
  let solid = 0, soft = 0;
  for (let i = 0; i < S * S; i++) {
    const v = (pred[i] - mn) / range;
    const a = Math.min(1, Math.max(0, (v - 0.12) / 0.76));
    mask.data[i * 4 + 3] = Math.round(a * 255);
    if (a > 0.8) solid++;
    else if (a > 0.15) soft++;
  }
  const coverage = (solid + soft * 0.5) / (S * S);
  const confidence = solid / Math.max(1, solid + soft);
  g.clearRect(0, 0, S, S);
  g.putImageData(mask, 0, 0);

  // Apply the mask at full resolution.
  const full = createCanvas(W, H);
  const f = full.getContext('2d');
  f.drawImage(img, 0, 0);
  f.globalCompositeOperation = 'destination-in';
  f.drawImage(c, 0, 0, W, H);

  // Subject box from the alpha channel.
  const alpha = f.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  const step = Math.max(1, Math.floor(Math.min(W, H) / 400));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (alpha[(y * W + x) * 4 + 3] > 40) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { usable: false, coverage: 0, confidence: 0 };
  const pad = Math.round(Math.max(W, H) * 0.01);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const crop = createCanvas(bw, bh);
  crop.getContext('2d').drawImage(full, x0, y0, bw, bh, 0, 0, bw, bh);
  await fsp.writeFile(outPath, await crop.encode('png'));

  // A cut-out is only "usable" as a floating product if it is a distinct
  // object (not the whole scene, not a speck) with mostly crisp edges.
  const boxFrac = (bw * bh) / (W * H);
  const usable = coverage > 0.03 && coverage < 0.78 && boxFrac < 0.97 && confidence > 0.7;
  return { file: path.basename(outPath), w: bw, h: bh, box: { x: x0, y: y0, w: bw, h: bh }, coverage: round(coverage), confidence: round(confidence), usable };
}

const round = (v) => Math.round(v * 1000) / 1000;
