// Live ad preview: the same motion engine that renders the final video, run in
// the browser on a <canvas>. Edits re-compose instantly; no render needed.
import { buildPalette } from '/engine/brand.js';
import { compose } from '/engine/compose.js';
import { getDirection } from '/engine/styles.js';
import { renderFrame } from '/engine/compositor.js';
import { FONT_FILES } from '/engine/fonts.js';

let fontsReady = null;
export function loadFonts() {
  if (!fontsReady) {
    fontsReady = Promise.all(FONT_FILES.map(async (f) => {
      try {
        const face = new FontFace(f.family, `url(/fonts/lib/${f.file})`, { weight: String(f.weight), style: f.style });
        await face.load();
        document.fonts.add(face);
      } catch {}
    }));
  }
  return fontsReady;
}

const imageCache = new Map();
function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (!imageCache.has(url)) {
    imageCache.set(url, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    }));
  }
  return imageCache.get(url);
}

/** kit.urls: { id: { src, cut, focus } } → engine assets. */
export async function loadAssets(urls) {
  const out = {};
  await Promise.all(Object.entries(urls || {}).map(async ([id, u]) => {
    const img = await loadImage(u.src);
    if (!img) return;
    const entry = { img, w: img.naturalWidth, h: img.naturalHeight, focus: u.focus || { x: 0.5, y: 0.5 } };
    if (u.cut) {
      const cut = await loadImage(u.cut);
      if (cut) Object.assign(entry, { cut, cutW: cut.naturalWidth, cutH: cut.naturalHeight });
    }
    out[id] = entry;
  }));
  return out;
}

export class Player {
  constructor(canvas, { onTime } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onTime = onTime;
    this.t = 0;
    this.playing = false;
    this.videos = {};
    this.audio = new Audio();
    this.env = { makeCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }), assets: {}, externalGrade: true, video: (src, ts) => this.videoFrame(src, ts) };
  }

  /** kit from /ads/:i/kit; board may be an edited copy. */
  setBoard(board, kit, assets, { scale = 0.5 } = {}) {
    // Same palette maths as the server, so switching the look or background
    // here shows exactly what the render will look like.
    const palette = kit.brandColors
      ? buildPalette({ brandColors: kit.brandColors, industry: kit.industry, tone: board.tone || getDirection(board.direction).tone, seed: board.seed || 1, direction: board.direction })
      : { ...kit.palette };
    if (board.accent) palette.accent = board.accent;
    this.comp = compose({
      direction: board.direction, format: kit.format, palette, seed: board.seed || 1, scale,
      logo: kit.logo, logoNeedsPlate: kit.logoNeedsPlate, music: board.music?.bpm ? { bpm: board.music.bpm } : null, scenes: board.scenes,
    }, kit.info, kit.industry);
    this.env.assets = assets;
    this.env._cache = null;
    this.env._buf = null;
    this.env._scratch = null;
    this.env.scratch = null;
    this.canvas.width = this.comp.width;
    this.canvas.height = this.comp.height;
    // The grade is a CSS filter here (the final render bakes it in).
    this.canvas.style.filter = this.comp.grade?.filter && this.comp.grade.filter !== 'none' ? this.comp.grade.filter : '';
    for (const [id, v] of Object.entries(kit.videos || {})) {
      if (!this.videos[id]) {
        const el = document.createElement('video');
        Object.assign(el, { src: v.src, muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
        this.videos[id] = el;
      }
    }
    this.t = Math.min(this.t, this.comp.duration - 0.01);
    this.draw();
    return this.comp;
  }

  setMusic(track) {
    this.track = track || null;
    this.audio.src = track ? `/music-files/${track.file}` : '';
  }

  videoFrame(src, ts) {
    const v = this.videos[src];
    if (!v || v.readyState < 2) return null;
    if (Math.abs(v.currentTime - ts) > (this.playing ? 0.35 : 0.04)) v.currentTime = ts;
    return { img: v, w: v.videoWidth, h: v.videoHeight };
  }

  draw() {
    if (!this.comp) return;
    try {
      renderFrame(this.ctx, this.comp, this.t, this.env);
    } catch (err) {
      console.error('preview frame failed', err);
    }
    this.onTime?.(this.t, this.comp.duration);
  }

  seek(t) {
    this.t = Math.max(0, Math.min(this.comp?.duration ?? 0, t));
    if (this.playing && this.track) this.audio.currentTime = (this.track.startAt || 0) + this.t;
    this.draw();
  }

  /** Jump to the middle of a scene (used when a scene is selected). */
  seekScene(i) {
    const s = this.comp?.scenes[i];
    if (s) this.seek(s.start + Math.min(s.duration * 0.75, s.duration - 0.05));
  }

  play() {
    if (!this.comp || this.playing) return;
    if (this.t >= this.comp.duration - 0.05) this.t = 0;
    this.playing = true;
    if (this.track) {
      this.audio.currentTime = (this.track.startAt || 0) + this.t;
      this.audio.play().catch(() => {});
    }
    let last = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      this.t += (now - last) / 1000;
      last = now;
      if (this.t >= this.comp.duration) {
        this.t = this.comp.duration - 0.001;
        this.draw();
        this.pause();
        return;
      }
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.onTime?.(this.t, this.comp?.duration ?? 0);
  }

  destroy() {
    this.pause();
    for (const v of Object.values(this.videos)) v.removeAttribute('src');
    this.audio.removeAttribute('src');
  }
}
