// Worker thread: renders one range of frames of a composition and encodes
// them (video only) to a segment file. Several run in parallel.
import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';
import { renderFrame, sceneAt } from '../../../public/engine/compositor.js';
import { FFMPEG } from '../ffmpeg.js';
import { createCanvas, loadAssets, makeEnv, registerFonts } from './node.js';
import { VideoSource } from './video.js';

const { comp, assetSpec, videoSpec, start, end, out, vf, encoder } = workerData;

async function main() {
  registerFonts();
  const assets = await loadAssets(assetSpec);
  const W = comp.width, H = comp.height, fps = comp.fps;
  const sources = {};
  const frames = new Map();
  const env = makeEnv(assets, (src, ts, layer) => frames.get(`${src}|${layer.from || 0}`) || null, { externalGrade: true });

  // Which footage frames does time t need? (current scene, plus the previous one during a transition)
  async function prefetch(t) {
    const { i, lt } = sceneAt(comp, t);
    const need = [];
    const scene = comp.scenes[i];
    for (const l of scene.layers) if (l.type === 'video') need.push([l, lt]);
    const tr = scene.transition;
    if (i > 0 && tr && lt < (tr.duration || 0.5)) {
      const prev = comp.scenes[i - 1];
      for (const l of prev.layers) if (l.type === 'video') need.push([l, prev.duration + lt]);
    }
    for (const [l, at] of need) {
      const key = `${l.src}|${l.from || 0}`;
      const spec = videoSpec[l.src];
      if (!spec) continue;
      if (!sources[key]) sources[key] = new VideoSource(spec, W, H, fps);
      const f = await sources[key].frameAt(at + (l.from || 0));
      if (f) frames.set(key, f);
    }
  }

  const ff = spawn(FFMPEG, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', 'pipe:0', '-vf', vf, ...encoder, '-an', out], { windowsHide: true });
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr = (stderr + d).slice(-8000)));
  ff.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`))));
  });
  let failed = null;
  done.catch((e) => (failed = e));

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  for (let f = start; f < end && !failed; f++) {
    const t = f / fps;
    await prefetch(t);
    renderFrame(ctx, comp, t, env);
    if (!ff.stdin.write(canvas.data())) await new Promise((r) => ff.stdin.once('drain', r));
    if ((f - start) % 10 === 0) parentPort.postMessage({ type: 'progress', done: f - start });
  }
  ff.stdin.end();
  for (const s of Object.values(sources)) s.stop();
  await done;
  parentPort.postMessage({ type: 'done', frames: end - start });
}

main().catch((err) => parentPort.postMessage({ type: 'error', message: err.message, stack: err.stack }));
