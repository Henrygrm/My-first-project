// Storyboard → composition: builds every scene from its recipe, fits scene
// lengths to the music's beat, picks transitions from the creative direction,
// and collects sound-effect cues.
import { rng } from './core.js';
import { getDirection } from './styles.js';
import { buildScene, pickW } from './recipes.js';

export const FORMATS = {
  '9:16': { w: 1080, h: 1920, safe: { top: 0.13, bottom: 0.2 }, label: '9:16 vertical (TikTok, Reels, Shorts, Facebook Reels)' },
  '4:5': { w: 1080, h: 1350, safe: { top: 0.07, bottom: 0.08 }, label: '4:5 feed (Instagram / Facebook feed)' },
  '1:1': { w: 1080, h: 1080, safe: { top: 0.07, bottom: 0.07 }, label: '1:1 square' },
  '16:9': { w: 1920, h: 1080, safe: { top: 0.08, bottom: 0.1 }, label: '16:9 landscape (YouTube, website)' },
};

const TRANSITION_TIME = { whip: 0.35, push: 0.45, pushUp: 0.45, slide: 0.45, fade: 0.5, dissolve: 0.5, blur: 0.5, zoom: 0.5, flash: 0.3, brand: 0.6, iris: 0.55, split: 0.45, wipe: 0.45, cut: 0 };
const TRANSITION_SFX = { whip: 'whoosh', push: 'swoosh', pushUp: 'swoosh', zoom: 'whoosh', brand: 'swoosh', flash: 'impact', split: 'swoosh', wipe: 'swoosh', iris: 'swoosh', blur: 'soft', fade: null, dissolve: null, cut: null };
export const TRANSITIONS = Object.keys(TRANSITION_TIME);

/** Scene starts, with every scene END on a beat when there is music. */
export function timeScenes(durations, bpm) {
  const beat = bpm ? 60 / bpm : 0;
  let ideal = 0, t = 0;
  return durations.map((d, i) => {
    ideal += d;
    const min = i === durations.length - 1 ? 2 : 1.2;
    const end = beat ? Math.max(t + Math.ceil(min / beat) * beat, Math.round(ideal / beat) * beat) : Math.max(t + min, ideal);
    const out = { start: t, duration: end - t };
    t = end;
    return out;
  });
}

/**
 * board: { direction, format, palette, scenes: [spec], seed, music?: { bpm }, logo?, logoNeedsPlate? }
 * assets: { id: { cut: bool, w, h } } (what exists; the renderer loads pixels)
 */
export function compose(board, assets, industry = 'other') {
  const fmt = FORMATS[board.format] || FORMATS['9:16'];
  const direction = { ...getDirection(board.direction), id: board.direction };
  const seed = board.seed ?? 1;
  const r = rng(seed * 7 + 3);
  // Layout is all fractions of the frame, so a preview can run at lower resolution.
  const scale = board.scale || 1;
  const W = Math.round((fmt.w * scale) / 2) * 2, H = Math.round((fmt.h * scale) / 2) * 2;
  const kit = {
    W, H, square: H / W < 1.5, safe: fmt.safe, palette: board.palette, direction, industry, assets,
    logo: board.logo || null, logoNeedsPlate: Boolean(board.logoNeedsPlate), fonts: direction.fonts, seed,
  };
  const times = timeScenes(board.scenes.map((s) => s.duration || 2.5), board.music?.bpm);
  const scenes = [];
  const sfx = [];
  let lastTransition = null;
  board.scenes.forEach((spec, i) => {
    const { start, duration } = times[i];
    const built = buildScene({ ...spec, duration, seed: spec.seed ?? seed * 31 + i * 101 }, kit);
    let type = spec.transition && TRANSITION_TIME[spec.transition] !== undefined ? spec.transition : pickW(direction.transitions, r);
    // Avoid the same transition twice in a row (unless chosen explicitly).
    if (!spec.transition && type === lastTransition) type = pickW(direction.transitions, r);
    lastTransition = type;
    const transition = i === 0 ? null : { type, duration: TRANSITION_TIME[type] ?? 0.45, dir: r() < 0.5 ? 1 : -1 };
    scenes.push({ id: spec.id || `s${i + 1}`, recipe: built.recipe, start, duration, layers: built.layers, camera: built.camera, transition });
    if (transition && TRANSITION_SFX[type]) sfx.push({ t: Math.max(0, start - 0.08), kind: TRANSITION_SFX[type] });
    for (const c of built.sfx || []) {
      if (spec.sfx === 'none') continue;
      if (c.t < duration - 0.2) sfx.push({ t: start + c.t, kind: c.kind });
    }
  });
  const duration = scenes.reduce((s, x) => s + x.duration, 0);

  // A small logo in the corner on middle scenes (not the opener or the ending).
  const overlays = [];
  if (board.logo && scenes.length > 2 && board.logoBug !== false) {
    overlays.push({
      type: 'logo', src: board.logo, x: 0.16, y: fmt.safe.top * 0.62, w: 0.2, h: 0.045, fixed: true, opacity: 0.92,
      start: scenes[1].start + 0.3, end: scenes[scenes.length - 1].start, in: { type: 'fade', at: scenes[1].start + 0.3, dur: 0.4 }, mb: false,
      plate: board.logoNeedsPlate ? 'surface' : undefined,
    });
  }

  return {
    version: 3,
    width: W, height: H, fps: 30, duration, format: board.format || '9:16',
    palette: board.palette, fonts: direction.fonts, direction: board.direction,
    motion: { speed: direction.motion.speed, ease: direction.motion.ease, blur: true },
    shape: direction.shape, emStyle: direction.emStyle,
    grade: { ...direction.grade, leak: direction.grade.leak ? { ...direction.grade.leak, color: board.palette.accent } : undefined },
    beat: board.music?.bpm ? 60 / board.music.bpm : 0,
    scenes, overlays, sfx: dedupeSfx(sfx),
  };
}

/** Keep sound effects from piling up: at most one cue per 0.25s. */
function dedupeSfx(list) {
  const out = [];
  for (const c of list.sort((a, b) => a.t - b.t)) {
    if (out.length && c.t - out[out.length - 1].t < 0.25) continue;
    out.push(c);
  }
  return out;
}
