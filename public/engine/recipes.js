// Composition recipes: each turns a storyboard scene (what it should show and
// say) into engine layers (how it looks and moves). Recipes are product-first:
// the client's photos, cutouts and footage are the subject; type supports.
// Every recipe has several layouts and takes its motion vocabulary from the
// creative direction, so the same recipe looks different per brand and seed.
import { clamp, rng } from './core.js';
import { INDUSTRY_ICONS, INDUSTRY_PARTICLES } from './styles.js';

export const RECIPES = {
  product_hero: { label: 'Product hero', needs: 'photo', brief: 'One product or result as the star: cut out, lit like a studio shot, floating with a light sweep and subtle particles. Short headline.' },
  photo_full: { label: 'Full-screen photo', needs: 'photo', brief: 'A strong photo filling the frame with a slow camera move (2.5D depth when the subject can be cut out) and a caption.' },
  gallery: { label: 'Photo stack', needs: '2+ photos', brief: 'Two or three photos fly in as tilted cards, stacking up: variety, abundance, "look at all this".' },
  compare: { label: 'Before / after', needs: '2 photos', brief: 'A divider sweeps across a before and after photo. Only when the photos really are a before and after.' },
  kinetic: { label: 'Kinetic type', needs: 'nothing', brief: 'Big animated statement. Use sparingly: a punchy hook or a single bold claim, ideally over a blurred photo.' },
  features: { label: 'Benefits list', needs: 'items', brief: '2–4 short benefits with icons appearing one by one, with a product photo when available.' },
  offer: { label: 'Offer burst', needs: 'an offer', brief: 'A spinning badge with the real offer, light rays and the product. Only when an offer is given.' },
  review: { label: 'Customer review', needs: 'a real review', brief: 'Five stars and a real customer quote over a soft photo. Only with a real review.' },
  stat: { label: 'Big number', needs: 'a real number', brief: 'A number that counts up with a short label. Only with a real figure.' },
  process: { label: 'Process steps', needs: '2+ photos', brief: 'Numbered steps with photos and a progress line: how it is made or how the service works.' },
  footage: { label: 'Client footage', needs: 'video', brief: 'A clip of the client\'s own video full screen with a caption.' },
  location: { label: 'Location', needs: 'location', brief: 'An animated map pin drops on the suburb name: "come and see us".' },
  cta: { label: 'Call to action', needs: 'nothing', brief: 'The ending: logo, the call to action, a button and contact details. Always the last scene.' },
};

export const RECIPE_IDS = Object.keys(RECIPES);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pick = (list, r) => list[Math.floor(r() * list.length) % list.length];
const pickW = (weights, r) => {
  const entries = Object.entries(weights);
  let total = entries.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [k, w] of entries) {
    x -= w;
    if (x <= 0) return k;
  }
  return entries[0][0];
};

/** Background layer suited to the direction (and a photo, when there is one). */
function background(kit, r, { photo, prefer } = {}) {
  const d = kit.direction;
  let kind = prefer || pick(d.backgrounds, r);
  if (kind === 'photo' && !photo) kind = d.backgrounds.find((b) => b !== 'photo') || 'gradient';
  if (kind === 'blob') {
    return [
      { type: 'bg', kind: 'gradient', colors: ['bg', 'bg2'], angle: 140 + r() * 60 },
      { type: 'shape', shape: 'blob', x: 0.15 + r() * 0.2, y: 0.2 + r() * 0.15, w: 0.8, h: 0.8, fill: 'accent', opacity: 0.35, seed: Math.floor(r() * 99), z: 0.8, mb: false },
      { type: 'shape', shape: 'blob', x: 0.85, y: 0.82, w: 0.7, h: 0.7, fill: 'primary', opacity: 0.3, seed: Math.floor(r() * 99), z: 0.8, mb: false },
    ];
  }
  const layer = { type: 'bg', kind, z: 0.9 };
  switch (kind) {
    case 'photo': Object.assign(layer, { src: photo, colors: ['bg'], tint: kit.palette.dark ? 0.6 : 0.5, blur: 0.035 }); break;
    case 'studio': Object.assign(layer, { colors: ['bg', 'bg2'], floor: 0.68 }); break;
    case 'spotlight': Object.assign(layer, { colors: ['bg', kit.palette.dark ? 'bg2' : 'surface'], cy: 0.42 }); break;
    case 'radial': Object.assign(layer, { colors: ['bg2', 'bg'], cy: 0.4 }); break;
    case 'mesh': Object.assign(layer, { colors: ['bg', 'primary', 'accent', 'bg2'], strength: kit.palette.dark ? 0.35 : 0.45 }); break;
    case 'stripes': Object.assign(layer, { colors: ['bg', 'accent'], strength: 0.07 }); break;
    case 'grid': Object.assign(layer, { colors: ['bg', 'accent'], strength: 0.22 }); break;
    case 'paper': Object.assign(layer, { colors: ['bg', 'surface'] }); break;
    case 'solid': Object.assign(layer, { colors: ['bg'] }); break;
    default: Object.assign(layer, { kind: 'gradient', colors: ['bg', 'bg2'], angle: 120 + r() * 90 });
  }
  return [layer];
}

function entranceFor(kit, r, role = 'subject') {
  const d = kit.direction;
  const list = role === 'subject'
    ? d.motion.entrances.filter((e) => !['wipe', 'reveal'].includes(e)).concat(role === 'subject' ? ['rise'] : [])
    : d.motion.entrances;
  return pick(list, r);
}

function textAnim(kit, r) {
  return pick(kit.direction.motion.textAnims, r);
}

function idleFor(kit, r) {
  return pick(kit.direction.motion.idle, r);
}

/** Gentle camera move matched to the direction's camera personality. */
function camera(kit, r, dur, kind) {
  const style = kit.direction.motion.camera;
  const k = style === 'dynamic' ? 1.6 : style === 'smooth' ? 1.1 : 0.8;
  const type = kind || pick(['push', 'push', 'pull', 'pan', 'rise'], r);
  switch (type) {
    case 'pull': return { zoom: [[0, 1 + 0.07 * k], [dur, 1, 'inOutQuad']] };
    case 'pan': { const dir = r() < 0.5 ? -1 : 1; return { x: [[0, -0.025 * k * dir], [dur, 0.025 * k * dir, 'inOutQuad']], zoom: [[0, 1.04], [dur, 1.06]] }; }
    case 'rise': return { y: [[0, 0.02 * k], [dur, -0.015 * k, 'inOutQuad']], zoom: [[0, 1.02], [dur, 1.06]] };
    case 'punch': return { zoom: [[0, 1.12], [0.5, 1.0, 'outExpo'], [dur, 1.03]] };
    case 'orbit': return { x: [[0, 0.02 * k], [dur, -0.02 * k, 'inOutQuad']], rot: [[0, -0.6 * k], [dur, 0.6 * k, 'inOutQuad']], zoom: [[0, 1.03], [dur, 1.07]] };
    case 'still': return {};
    case 'push':
    default: return { zoom: [[0, 1], [dur, 1 + 0.06 * k, 'inOutQuad']] };
  }
}

function particlesFor(kit, r, area, opts = {}) {
  const ind = INDUSTRY_PARTICLES[kit.industry] || INDUSTRY_PARTICLES.other;
  const dir = kit.direction.particles;
  const kinds = opts.kind ? [opts.kind] : ind.filter((k) => !dir.length || dir.includes(k) || ['steam', 'droplets', 'bubbles', 'foam'].includes(k));
  if (!kinds.length && !dir.length) return [];
  const kind = kinds.length ? pick(kinds, r) : pick(dir, r);
  const counts = { steam: 9, droplets: 26, bubbles: 18, foam: 30, sparkle: 14, embers: 30, confetti: 40, streaks: 12, bokeh: 12, dust: 40 };
  const colors = { steam: kit.palette.dark ? '#ffffff' : '#ffffff', droplets: '#dff4ff', bubbles: '#ffffff', foam: '#ffffff', embers: '#ffb347', sparkle: kit.palette.dark ? 'accent' : '#ffffff', confetti: 'accent', streaks: 'accent', bokeh: 'accent', dust: kit.palette.dark ? '#ffffff' : 'textMuted' };
  return [{ type: 'particles', kind, count: Math.round((counts[kind] || 20) * (opts.density || 1)), color: colors[kind] || 'accent', color2: 'primary', area, seed: Math.floor(r() * 1000) + 1, z: opts.z ?? -0.2, opacity: opts.opacity ?? 1, scale: opts.scale ?? 1, mb: false }];
}

/** Headline + optional subline block. Returns layers and the bottom y used. */
function headline(kit, r, spec, { y, size = 0.1, align = 'center', x = 0.5, w = 0.84, at = 0.25, anchor = 'top', onPhoto = false, color = 'text', role = 'display', lines = 3, subGap = 0.025, box } = {}) {
  const layers = [];
  if (spec.headline) {
    layers.push({
      type: 'text', id: 'headline', text: spec.headline, role, size, x, y, w, maxW: w, align, anchor, lines,
      color, onPhoto, textAnim: spec.textAnim || textAnim(kit, r), in: { type: 'none', at }, textAt: at, box,
      glow: kit.direction.glow && !onPhoto ? true : undefined,
    });
  }
  if (spec.subline) {
    layers.push({
      type: 'text', id: 'subline', text: spec.subline, role: 'body', size: 0.038, x, y: y + (anchor === 'top' ? size * 1.15 * Math.min(lines, estLines(spec.headline, size, w)) + subGap : size * 0.5 + subGap), w, maxW: w, align, anchor: 'top', lines: 2,
      color: onPhoto ? '#ffffff' : 'textMuted', onPhoto, textAnim: 'none', in: { type: 'rise', at: at + 0.45, dur: 0.5 },
    });
  }
  return layers;
}

/** Rough line count estimate so the subline sits under the headline. */
function estLines(text, size, w) {
  if (!text) return 0;
  const charsPerLine = Math.max(6, Math.floor((w / size) * 1.9));
  return clamp(Math.ceil(String(text).length / charsPerLine), 1, 3) * 0.75;
}

const hasCut = (kit, id) => Boolean(id && kit.assets[id]?.cut);
const photoOf = (spec, i = 0) => (i === 0 ? spec.main : spec.alt?.[i - 1]) || null;
const photosOf = (spec) => [spec.main, ...(spec.alt || [])].filter(Boolean);

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

function product_hero(spec, kit, r) {
  const dur = spec.duration;
  const main = spec.main;
  const cut = hasCut(kit, main);
  const layout = spec.layout ?? Math.floor(r() * 3); // 0 text top, 1 text bottom, 2 text overlaps big
  const S = kit.safe;
  const layers = [...background(kit, r, { photo: main, prefer: cut ? pick(['studio', 'spotlight', 'radial', 'mesh'].filter((b) => kit.direction.backgrounds.includes(b) || r() < 0.3), r) || 'studio' : undefined })];
  const prodY = layout === 0 ? 0.58 : layout === 1 ? 0.44 : 0.52;
  const prodH = kit.square ? 0.56 : 0.42;
  layers.push({ type: 'light', kind: 'glow', x: 0.5, y: prodY, r: 0.55, color: 'accent', strength: kit.palette.dark ? 0.35 : 0.22, pulse: true, z: 0.5 });
  if (kit.direction.id === 'futuristic' || kit.direction.id === 'energetic') layers.push({ type: 'light', kind: 'rays', x: 0.5, y: prodY, r: 1.0, color: 'accent', strength: 0.1, z: 0.6 });
  const entrance = spec.entrance || pick(cut ? ['rise', 'drop', 'zoom', 'tilt', 'blur', 'scaleDown'].filter((e) => kit.direction.motion.entrances.includes(e) || ['rise', 'tilt'].includes(e)) : ['rise', 'zoom', 'blur'], r);
  if (cut) {
    layers.push({ type: 'cutout', id: 'product', src: main, x: 0.5, y: prodY, w: 0.82, h: prodH, z: -0.05, in: { type: entrance, at: 0.1, dur: 0.8 }, idle: { type: 'float', amt: 1, phase: r() * 6 }, sweep: { at: 1.0, dur: 0.9, strength: 0.55 }, reflection: layout !== 1 && kit.palette.dark && ['premium', 'luxury', 'minimalist'].includes(kit.direction.id) });
  } else if (main) {
    layers.push({ type: 'image', id: 'product', src: main, x: 0.5, y: prodY, w: kit.square ? 0.62 : 0.74, h: kit.square ? 0.5 : 0.4, radius: Math.max(0.01, kit.direction.shape.radius * 1.2), shadow: true, z: -0.05, in: { type: entrance === 'drop' ? 'rise' : entrance, at: 0.1, dur: 0.8 }, idle: { type: 'float', amt: 0.6 }, sweep: { at: 1.1, dur: 1.0, strength: 0.3 }, kenburns: { from: 1.08, to: 1.0 } });
  }
  layers.push(...particlesFor(kit, r, { x: 0.15, y: prodY - prodH * 0.6, w: 0.7, h: prodH * 0.9 }));
  const ty = layout === 0 ? S.top + 0.02 : layout === 1 ? prodY + prodH / 2 + 0.04 : S.top + 0.04;
  layers.push(...headline(kit, r, spec, { y: Math.min(ty, 1 - S.bottom - 0.12), size: layout === 2 ? 0.13 : 0.1, at: 0.45 }));
  return { layers, camera: camera(kit, r, dur, cut ? pick(['push', 'orbit', 'rise'], r) : 'push'), sfx: [{ t: 0.1, kind: entrance === 'drop' ? 'impact' : 'whoosh' }, { t: 1.0, kind: 'shimmer' }] };
}

function photo_full(spec, kit, r) {
  const dur = spec.duration;
  const main = spec.main;
  const S = kit.safe;
  const cut = hasCut(kit, main);
  const layout = spec.layout ?? Math.floor(r() * 3); // 0 caption bottom-left, 1 centred, 2 boxed lower third
  const layers = [];
  const kbList = [
    { from: 1.0, to: 1.14 }, { from: 1.14, to: 1.0 },
    { from: 1.08, to: 1.08, x0: -0.04, x1: 0.04 }, { from: 1.1, to: 1.02, y0: 0.03, y1: -0.02 },
  ];
  const kb = pick(kbList, r);
  layers.push({ type: 'bg', kind: 'solid', colors: ['bg'] });
  if (cut && r() < 0.75) {
    // 2.5D: the photo behind, the cut-out subject in front, moving at different speeds.
    layers.push({ type: 'image', src: main, x: 0.5, y: 0.5, w: 1.0, h: 1.0, z: 0.5, kenburns: { from: 1.12, to: 1.04 }, in: { type: 'fade', dur: 0.3 }, scrim: { top: 0.2, bottom: 0.15 } });
    layers.push({ type: 'cutout', src: main, x: 0.5, y: 0.5, w: 1.0, h: 1.0, fit: 'cover', z: -0.25, shadow: 'none', in: { type: 'zoom', at: 0, dur: 1.2, ease: 'glide' }, sweep: { at: 0.9, dur: 1.1, strength: 0.35 } });
  } else {
    layers.push({ type: 'image', src: main, x: 0.5, y: 0.5, w: 1.0, h: 1.0, kenburns: kb, z: 0.2, in: { type: pick(['fade', 'zoom', 'blur'], r), dur: 0.6 }, scrim: { top: layout === 1 ? 0.35 : 0.25, bottom: layout === 1 ? 0.35 : 0.7 } });
  }
  if (r() < 0.5) layers.push(...particlesFor(kit, r, { x: 0, y: 0.2, w: 1, h: 0.6 }, { density: 0.6, opacity: 0.8 }));
  if (layout === 0) {
    layers.push({ type: 'shape', shape: 'rect', x: 0.1, y: 1 - S.bottom - 0.235, w: 0.12, h: 0.008, fill: 'accent', draw: { at: 0.3, dur: 0.5 }, z: -0.1 });
    layers.push(...headline(kit, r, spec, { y: 1 - S.bottom - 0.21, size: 0.095, align: 'left', x: 0.5, w: 0.84, onPhoto: true, color: '#ffffff', at: 0.35 }));
  } else if (layout === 1) {
    layers.push(...headline(kit, r, spec, { y: 0.42, size: 0.12, onPhoto: true, color: '#ffffff', at: 0.3 }));
  } else {
    layers.push(...headline(kit, r, spec, {
      y: 1 - S.bottom - 0.17, size: 0.07, align: 'left', x: 0.5, w: 0.8, color: 'onAccent', at: 0.35, box: { color: 'accent', perLine: true, reveal: true, pad: 0.022 },
    }).map((l) => (l.id === 'subline' ? { ...l, color: '#ffffff', onPhoto: true, y: l.y + 0.02 } : l)));
  }
  return { layers, camera: camera(kit, r, dur, cut ? 'push' : pick(['still', 'push', 'pan'], r)), sfx: [{ t: 0.35, kind: 'swoosh' }] };
}

function gallery(spec, kit, r) {
  const dur = spec.duration;
  const photos = photosOf(spec).slice(0, 3);
  const S = kit.safe;
  const layers = [...background(kit, r, { photo: photos[0] })];
  const n = photos.length;
  const layout = spec.layout ?? Math.floor(r() * 2); // 0 stacked cards, 1 fanned row
  const cw = kit.square ? 0.46 : 0.62, ch = kit.square ? 0.46 : 0.36;
  photos.forEach((p, i) => {
    const ang = layout === 0 ? (i - (n - 1) / 2) * 7 + (r() - 0.5) * 4 : (i - (n - 1) / 2) * 9;
    const x = layout === 0 ? 0.5 + (i - (n - 1) / 2) * 0.06 : 0.5 + (i - (n - 1) / 2) * (kit.square ? 0.26 : 0.22);
    const y = (layout === 0 ? 0.56 + (i - (n - 1) / 2) * 0.05 : 0.56) - (kit.square ? 0.02 : 0);
    const from = pick(['slideL', 'slideR', 'drop', 'rise', 'spin'], r);
    layers.push({
      type: 'image', src: p, x, y, w: layout === 0 ? cw : cw * 0.62, h: layout === 0 ? ch : ch * 0.9, radius: Math.max(0.008, kit.direction.shape.radius), shadow: true,
      border: { color: kit.palette.dark ? 'surface' : '#ffffff', width: 0.012 }, kf: { rot: [[0, ang]] }, z: -0.1 * i,
      in: { type: from, at: 0.15 + i * 0.35, dur: 0.6 }, idle: { type: 'float', amt: 0.4, phase: i * 2 }, kenburns: { from: 1.12, to: 1.0 },
    });
  });
  layers.push(...headline(kit, r, spec, { y: S.top + 0.01, size: 0.09, at: 0.1 }));
  return { layers, camera: camera(kit, r, dur, 'pan'), sfx: photos.map((_, i) => ({ t: 0.15 + i * 0.35, kind: 'swoosh' })) };
}

function compare(spec, kit, r) {
  const dur = spec.duration;
  const [a, b] = photosOf(spec);
  const S = kit.safe;
  const layers = [...background(kit, r, { photo: b })];
  const h = kit.square ? 0.62 : 0.5;
  layers.push({
    type: 'compare', a, b, x: 0.5, y: 0.56, w: 0.86, h, radius: Math.max(0.01, kit.direction.shape.radius), labelA: spec.items?.[0] || 'Before', labelB: spec.items?.[1] || 'After',
    split: [[0, 1], [0.5, 1], [Math.min(dur - 0.6, 2.2), 0.5, 'inOutCubic'], [dur, 0.45]], in: { type: 'rise', at: 0, dur: 0.6 }, z: -0.05,
  });
  layers.push(...headline(kit, r, spec, { y: S.top, size: 0.09, at: 0.15 }));
  return { layers, camera: camera(kit, r, dur, 'push'), sfx: [{ t: 0.5, kind: 'swoosh' }, { t: Math.min(dur - 0.6, 2.2), kind: 'shimmer' }] };
}

function kinetic(spec, kit, r) {
  const dur = spec.duration;
  const photo = spec.main;
  const layout = spec.layout ?? Math.floor(r() * 3); // 0 big centre, 1 left stack + shape, 2 outline + fill
  const layers = [...background(kit, r, { photo, prefer: photo && r() < 0.6 ? 'photo' : undefined })];
  if (layout === 1) layers.push({ type: 'shape', shape: 'blob', x: 0.72, y: 0.36, w: 0.7, h: 0.7, fill: 'accent', opacity: 0.18, seed: 4, z: 0.6, mb: false });
  if (layout === 2) layers.push({ type: 'shape', shape: 'frame', x: 0.5, y: 0.5, w: 0.88, h: kit.square ? 0.8 : 0.62, stroke: 'accent', lw: 0.006, draw: { at: 0.1, dur: 0.8 }, z: 0.3 });
  const size = spec.size || (kit.square ? 0.12 : 0.15);
  layers.push({
    type: 'text', id: 'headline', text: spec.headline, role: 'display', size, x: 0.5, y: 0.47, w: 0.86, maxW: 0.86, align: layout === 1 ? 'left' : 'center', anchor: 'middle', lines: 4,
    color: 'text', textAnim: spec.textAnim || textAnim(kit, r), textAt: 0.15, stagger: 0.11, underline: layout === 0 ? { color: 'accent' } : undefined,
    glow: kit.direction.glow ? true : undefined, idle: { type: kit.direction.id === 'energetic' ? 'pulse' : 'breathe', amt: 0.5 },
  });
  if (spec.subline) layers.push({ type: 'text', text: spec.subline, role: 'body', size: 0.04, x: 0.5, y: 0.74, w: 0.84, maxW: 0.84, align: layout === 1 ? 'left' : 'center', anchor: 'top', color: 'textMuted', textAnim: 'none', in: { type: 'rise', at: 0.8, dur: 0.5 } });
  layers.push(...particlesFor(kit, r, { x: 0, y: 0, w: 1, h: 1 }, { density: 0.5, z: 0.4 }));
  return { layers, camera: camera(kit, r, dur, kit.direction.motion.camera === 'dynamic' ? 'punch' : 'push'), sfx: [{ t: 0.15, kind: kit.direction.sound === 'punchy' ? 'impact' : 'whoosh' }] };
}

function features(spec, kit, r) {
  const dur = spec.duration;
  const S = kit.safe;
  const items = (spec.items || []).slice(0, 4);
  const photo = spec.main;
  const layout = spec.layout ?? (photo ? Math.floor(r() * 2) : 2); // 0 photo top + list, 1 cards over photo, 2 list only
  const layers = [...background(kit, r, { photo: layout === 1 ? photo : undefined, prefer: layout === 1 ? 'photo' : undefined })];
  const icons = INDUSTRY_ICONS[kit.industry] || INDUSTRY_ICONS.other;
  let listTop = S.top + 0.17;
  if (layout === 0 && photo) {
    const cut = hasCut(kit, photo);
    layers.push(cut
      ? { type: 'cutout', src: photo, x: 0.5, y: S.top + 0.17, w: 0.7, h: 0.26, in: { type: 'rise', at: 0.05, dur: 0.6 }, idle: { type: 'float', amt: 0.6 }, z: -0.05 }
      : { type: 'image', src: photo, x: 0.5, y: S.top + 0.17, w: 0.84, h: 0.25, radius: Math.max(0.01, kit.direction.shape.radius), shadow: 'soft', in: { type: 'rise', at: 0.05, dur: 0.6 }, kenburns: { from: 1.1, to: 1.0 }, z: -0.05 });
    listTop = S.top + 0.33;
  }
  layers.push(...headline(kit, r, spec, { y: listTop, size: 0.075, align: 'left', x: 0.5, w: 0.84, at: 0.2, lines: 2 }).filter((l) => l.id !== 'subline'));
  const rowTop = listTop + 0.075 * 1.2 * Math.max(1, Math.ceil(String(spec.headline || '').length / 16)) * 0.65 + 0.05;
  const avail = (1 - S.bottom) - rowTop;
  const row = Math.min(0.1, avail / Math.max(1, items.length));
  items.forEach((it, i) => {
    const y = rowTop + i * row + row * 0.35;
    const at = 0.55 + i * 0.32;
    if (layout === 1) layers.push({ type: 'shape', shape: 'rect', x: 0.5, y, w: 0.86, h: row * 0.82, radius: Math.max(0.012, kit.direction.shape.radius), fill: 'surface', opacity: 0.92, in: { type: 'slideL', at: at - 0.05, dur: 0.5 }, z: -0.1 });
    layers.push({ type: 'icon', icon: icons[i % icons.length], x: 0.13, y, size: 0.04, lineWidth: 2.8, color: 'onAccent', disc: 'accent', in: { type: 'pop', at, dur: 0.4 }, z: -0.1 });
    layers.push({ type: 'text', text: it, role: 'body', size: 0.05, x: 0.56, y, w: 0.66, maxW: 0.66, align: 'left', anchor: 'middle', lines: 2, color: layout === 1 ? 'onSurface' : 'text', textAnim: 'none', in: { type: 'slideR', at: at + 0.05, dur: 0.5 }, z: -0.1 });
  });
  return { layers, camera: camera(kit, r, dur, 'still'), sfx: items.map((_, i) => ({ t: 0.55 + i * 0.32, kind: 'pop' })) };
}

function offer(spec, kit, r) {
  const dur = spec.duration;
  const S = kit.safe;
  const photo = spec.main;
  const layers = [...background(kit, r, { photo, prefer: pick(['radial', 'mesh', 'stripes', 'gradient'], r) })];
  const by = photo ? 0.4 : 0.5;
  const R = kit.square ? 0.5 : 0.62;
  layers.push({ type: 'light', kind: 'rays', x: 0.5, y: by, r: 1.1, color: 'accent', strength: 0.14, z: 0.6 });
  layers.push({ type: 'shape', shape: 'burst', x: 0.5, y: by, w: R, h: R, fill: 'accent', points: 20, in: { type: 'pop', at: 0.1, dur: 0.6 }, idle: { type: 'pulse', amt: 1 }, z: 0.1, glow: kit.direction.glow });
  layers.push({ type: 'shape', shape: 'ring', x: 0.5, y: by, w: R * 1.15, h: R * 1.15, stroke: 'accent', lw: 0.005, draw: { at: 0.3, dur: 0.8 }, opacity: 0.6, z: 0.15 });
  layers.push({ type: 'text', id: 'offer', text: spec.headline, role: 'display', size: kit.square ? 0.09 : 0.1, x: 0.5, y: by, w: R * 0.78, maxW: R * 0.72, anchor: 'middle', lines: 3, color: 'onAccent', textAnim: 'pop', textAt: 0.35, in: { type: 'none' }, idle: { type: 'pulse', amt: 0.6 }, z: 0.05 });
  if (photo) {
    const cut = hasCut(kit, photo);
    layers.push(cut
      ? { type: 'cutout', src: photo, x: 0.5, y: by + R * 0.62 + 0.08, w: 0.7, h: 0.24, in: { type: 'rise', at: 0.5, dur: 0.6 }, idle: { type: 'float' }, sweep: { at: 1.1, dur: 0.8 }, z: -0.1 }
      : { type: 'image', src: photo, x: 0.5, y: by + R * 0.5 + 0.13, w: 0.6, h: 0.2, radius: Math.max(0.015, kit.direction.shape.radius), shadow: true, border: { color: '#ffffff', width: 0.01 }, kf: { rot: [[0, -4]] }, in: { type: 'rise', at: 0.5, dur: 0.6 }, z: -0.1 });
  }
  if (spec.subline) layers.push({ type: 'text', text: spec.subline, role: 'body', size: 0.042, x: 0.5, y: 1 - S.bottom - 0.06, w: 0.84, maxW: 0.84, anchor: 'bottom', color: 'text', textAnim: 'none', in: { type: 'rise', at: 0.9, dur: 0.5 } });
  if (['playful', 'energetic'].includes(kit.direction.id)) layers.push(...particlesFor(kit, r, { x: 0, y: -0.1, w: 1, h: 0.9 }, { kind: 'confetti', density: 0.8 }));
  else layers.push(...particlesFor(kit, r, { x: 0.15, y: by - 0.2, w: 0.7, h: 0.4 }, { kind: 'sparkle', density: 0.8 }));
  return { layers, camera: camera(kit, r, dur, 'punch'), sfx: [{ t: 0.1, kind: 'impact' }, { t: 0.35, kind: 'pop' }] };
}

function review(spec, kit, r) {
  const dur = spec.duration;
  const layers = [...background(kit, r, { photo: spec.main, prefer: spec.main ? 'photo' : undefined })];
  const quote = String(spec.headline || '').replace(/^["“]|["”]$/g, '');
  layers.push({ type: 'shape', shape: 'rect', x: 0.5, y: 0.5, w: 0.88, h: kit.square ? 0.62 : 0.42, radius: Math.max(0.02, kit.direction.shape.radius), fill: 'surface', opacity: 0.95, in: { type: 'rise', at: 0.05, dur: 0.6 }, z: 0 });
  layers.push({ type: 'stars', x: 0.5, y: kit.square ? 0.27 : 0.355, size: 0.035, color: 'accent', in: { type: 'none', at: 0.35 }, z: 0 });
  layers.push({ type: 'text', text: `“${quote}”`, role: kit.fonts?.accent ? 'accent' : 'display', size: 0.06, x: 0.5, y: 0.5, w: 0.76, maxW: 0.76, anchor: 'middle', lines: 5, color: 'onSurface', textAnim: 'lines', textAt: 0.6, z: 0 });
  layers.push({ type: 'text', text: spec.subline || 'Customer review', role: 'body', size: 0.034, x: 0.5, y: kit.square ? 0.74 : 0.65, w: 0.76, maxW: 0.76, anchor: 'top', color: 'onSurface', opacity: 0.7, textAnim: 'none', in: { type: 'fade', at: 1.1, dur: 0.5 }, z: 0 });
  return { layers, camera: camera(kit, r, dur, 'push'), sfx: [{ t: 0.35, kind: 'shimmer' }] };
}

function stat(spec, kit, r) {
  const dur = spec.duration;
  const layers = [...background(kit, r, { photo: spec.main })];
  const num = String(spec.headline || '').match(/\d[\d,.]*/);
  layers.push({ type: 'light', kind: 'glow', x: 0.5, y: 0.45, r: 0.6, color: 'accent', strength: 0.25, z: 0.5 });
  layers.push({ type: 'text', id: 'stat', text: num ? spec.headline.replace(num[0], `*${num[0]}*`) : spec.headline, role: 'display', size: kit.square ? 0.16 : 0.2, x: 0.5, y: 0.44, w: 0.9, maxW: 0.9, anchor: 'middle', lines: 2, color: 'text', textAnim: 'blurWords', textAt: 0.2, countUp: true, idle: { type: 'breathe', amt: 0.4 }, glow: kit.direction.glow ? true : undefined });
  if (spec.subline) layers.push({ type: 'text', text: spec.subline, role: 'body', size: 0.045, x: 0.5, y: 0.6, w: 0.84, maxW: 0.84, anchor: 'top', color: 'textMuted', textAnim: 'none', in: { type: 'rise', at: 0.7, dur: 0.5 } });
  return { layers, camera: camera(kit, r, dur, 'push'), sfx: [{ t: 0.2, kind: 'riser' }] };
}

function process(spec, kit, r) {
  const dur = spec.duration;
  const S = kit.safe;
  const photos = photosOf(spec).slice(0, 3);
  const n = Math.max(1, photos.length);
  const layers = [...background(kit, r, {})];
  layers.push(...headline(kit, r, spec, { y: S.top, size: 0.08, at: 0.1 }).filter((l) => l.id !== 'subline'));
  const top = S.top + 0.14, bottom = 1 - S.bottom - 0.02;
  const h = (bottom - top) / n;
  const step = Math.max(0.5, (dur - 0.8) / n);
  layers.push({ type: 'shape', shape: 'rect', x: 0.135, y: (top + bottom) / 2, w: 0.006, h: bottom - top - h * 0.4, fill: 'accent', opacity: 0.5, kf: { scale: [[0, 1]] }, in: { type: 'wipeDown', at: 0.3, dur: step * n }, z: 0 });
  photos.forEach((p, i) => {
    const y = top + h * i + h / 2;
    const at = 0.3 + i * step;
    layers.push({ type: 'icon', icon: 'check', x: 0.135, y, size: 0.05, color: 'onAccent', disc: 'accent', in: { type: 'pop', at, dur: 0.4 }, z: 0 });
    layers.push({ type: 'image', src: p, x: 0.42, y, w: 0.36, h: h * 0.8, radius: Math.max(0.01, kit.direction.shape.radius), shadow: 'soft', in: { type: 'slideR', at: at + 0.05, dur: 0.5 }, kenburns: { from: 1.15, to: 1.0 }, z: -0.05 });
    const label = spec.items?.[i] || `Step ${i + 1}`;
    layers.push({ type: 'text', text: label, role: 'body', size: 0.04, x: 0.81, y, w: 0.3, maxW: 0.3, align: 'left', anchor: 'middle', lines: 3, color: 'text', textAnim: 'none', in: { type: 'fade', at: at + 0.25, dur: 0.4 }, z: 0 });
  });
  return { layers, camera: camera(kit, r, dur, 'still'), sfx: photos.map((_, i) => ({ t: 0.3 + i * step, kind: 'click' })) };
}

function footage(spec, kit, r) {
  const dur = spec.duration;
  const S = kit.safe;
  const layers = [{ type: 'bg', kind: 'solid', colors: ['bg'] }];
  layers.push({ type: 'video', src: spec.video, from: spec.from || 0, x: 0.5, y: 0.5, w: 1, h: 1, z: 0.1, scrim: { top: 0.2, bottom: 0.6 }, in: { type: 'fade', dur: 0.25 } });
  const layout = spec.layout ?? Math.floor(r() * 2);
  if (layout === 0) layers.push(...headline(kit, r, spec, { y: 1 - S.bottom - 0.19, size: 0.085, align: 'left', x: 0.5, w: 0.84, onPhoto: true, color: '#ffffff', at: 0.3 }));
  else layers.push(...headline(kit, r, spec, { y: 1 - S.bottom - 0.14, size: 0.06, align: 'center', x: 0.5, w: 0.84, color: 'onAccent', at: 0.3, box: { color: 'accent', perLine: true, reveal: true } }).map((l) => (l.id === 'subline' ? { ...l, color: '#ffffff', onPhoto: true } : l)));
  return { layers, camera: camera(kit, r, dur, 'still'), sfx: [] };
}

function location(spec, kit, r) {
  const dur = spec.duration;
  const layers = [...background(kit, r, { photo: spec.main, prefer: spec.main ? 'photo' : undefined })];
  // Stylised map: soft grid of streets.
  layers.push({ type: 'bg', kind: 'grid', colors: ['bg', 'accent'], strength: 0.12, horizon: 0.25, opacity: 0.6, z: 0.8 });
  layers.push({ type: 'light', kind: 'glow', x: 0.5, y: 0.42, r: 0.4, color: 'accent', strength: 0.35, pulse: true, z: 0.3 });
  layers.push({ type: 'shape', shape: 'ring', x: 0.5, y: 0.47, w: 0.22, h: 0.22, stroke: 'accent', lw: 0.006, draw: { at: 0.6, dur: 0.6 }, idle: { type: 'pulse', amt: 2 }, z: 0.1 });
  layers.push({ type: 'icon', icon: 'pin', x: 0.5, y: 0.4, size: 0.2, color: 'accent', lineWidth: 2.4, in: { type: 'drop', at: 0.15 }, z: 0 });
  layers.push({ type: 'text', id: 'headline', text: spec.headline, role: 'display', size: 0.11, x: 0.5, y: 0.56, w: 0.86, maxW: 0.86, anchor: 'top', lines: 2, color: 'text', textAnim: 'words', textAt: 0.6 });
  if (spec.subline) layers.push({ type: 'text', text: spec.subline, role: 'body', size: 0.04, x: 0.5, y: 0.7, w: 0.84, maxW: 0.84, anchor: 'top', color: 'textMuted', textAnim: 'none', in: { type: 'rise', at: 1.0, dur: 0.5 } });
  return { layers, camera: camera(kit, r, dur, 'push'), sfx: [{ t: 0.35, kind: 'impact' }] };
}

function cta(spec, kit, r) {
  const dur = spec.duration;
  const S = kit.safe;
  const layers = [...background(kit, r, { photo: spec.main, prefer: pick(['mesh', 'radial', 'gradient', kit.direction.backgrounds[0]], r) })];
  const logo = kit.logo;
  let y = kit.square ? 0.2 : S.top + 0.08;
  if (logo) {
    layers.push({ type: 'logo', src: logo, x: 0.5, y: y + 0.05, w: 0.5, h: 0.11, plate: kit.logoNeedsPlate ? 'surface' : undefined, in: { type: 'zoom', at: 0.05, dur: 0.7, ease: 'glide' }, sweep: { at: 0.8, dur: 0.9, strength: 0.7 }, z: 0 });
    y += 0.16;
  } else if (spec.main && hasCut(kit, spec.main)) {
    layers.push({ type: 'cutout', src: spec.main, x: 0.5, y: y + 0.09, w: 0.6, h: 0.2, in: { type: 'rise', at: 0.05, dur: 0.6 }, idle: { type: 'float' }, sweep: { at: 0.9, dur: 0.8 }, z: -0.05 });
    y += 0.22;
  }
  layers.push({ type: 'text', id: 'headline', text: spec.headline, role: 'display', size: kit.square ? 0.1 : 0.115, x: 0.5, y, w: 0.86, maxW: 0.86, anchor: 'top', lines: 3, color: 'text', textAnim: spec.textAnim || textAnim(kit, r), textAt: 0.3, glow: kit.direction.glow ? true : undefined });
  const btnY = Math.min(1 - S.bottom - 0.12, y + 0.115 * 1.1 * Math.min(3, estLines(spec.headline, 0.115, 0.86) + 0.6) + 0.07);
  layers.push({ type: 'button', text: spec.items?.[0] || 'Book now', x: 0.5, y: btnY, size: 0.042, color: 'accent', in: { type: 'pop', at: 0.75, dur: 0.5 }, z: 0 });
  if (spec.subline) {
    layers.push({ type: 'text', text: spec.subline, role: 'body', size: 0.036, x: 0.5, y: btnY + 0.08, w: 0.84, maxW: 0.84, anchor: 'top', lines: 2, color: 'textMuted', textAnim: 'none', in: { type: 'rise', at: 1.05, dur: 0.5 }, z: 0 });
  }
  layers.push(...particlesFor(kit, r, { x: 0, y: 0, w: 1, h: 1 }, { density: 0.4, z: 0.5 }));
  return { layers, camera: camera(kit, r, dur, 'push'), sfx: [{ t: 0.05, kind: 'whoosh' }, { t: 0.75, kind: 'pop' }, { t: 0.8, kind: 'shimmer' }] };
}

const BUILDERS = { product_hero, photo_full, gallery, compare, kinetic, features, offer, review, stat, process, footage, location, cta };

/**
 * Build one scene. spec: { recipe, duration, headline, subline, items, main, alt[], video, from,
 * layout?, entrance?, textAnim?, transition?, seed? }
 * kit: { W, H, square, safe, palette, direction (with id), industry, assets, logo, logoNeedsPlate, fonts }
 */
export function buildScene(spec, kit) {
  const r = rng(spec.seed ?? kit.seed ?? 1);
  let recipe = BUILDERS[spec.recipe] ? spec.recipe : 'kinetic';
  // Degrade gracefully when the assets a recipe needs are missing.
  const photos = photosOf(spec).filter((id) => kit.assets[id]);
  if (['product_hero', 'photo_full'].includes(recipe) && !photos.length) recipe = 'kinetic';
  if (['gallery', 'process'].includes(recipe) && photos.length < 2) recipe = photos.length ? 'photo_full' : 'kinetic';
  if (recipe === 'compare' && photos.length < 2) recipe = photos.length ? 'photo_full' : 'kinetic';
  if (recipe === 'footage' && !spec.video) recipe = photos.length ? 'photo_full' : 'kinetic';
  if (recipe === 'features' && !(spec.items || []).length) recipe = 'kinetic';
  const clean = { ...spec, recipe, main: photos[0] || null, alt: photos.slice(1) };
  const out = BUILDERS[recipe](clean, kit, r);
  return { ...out, recipe };
}

export { pickW };
