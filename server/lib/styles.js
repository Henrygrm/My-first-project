// Video styles: each one is a different format with its own pacing,
// transitions, camera moves, colour grade, text look and music feel. Both the
// AI editor and the no-AI auto-edit build clips from these.

export const TRANSITIONS = {
  // name → [xfade transition, duration in seconds]
  cut: ['fade', 1 / 30], // a one-frame blend is visually a hard cut
  fade: ['fade', 0.45],
  dissolve: ['dissolve', 0.5],
  fadeblack: ['fadeblack', 0.5],
  flash: ['fadewhite', 0.22],
  slide: ['slideleft', 0.3],
  slideup: ['slideup', 0.3],
  whip: ['smoothleft', 0.25],
  zoom: ['zoomin', 0.3],
  wipe: ['wipeleft', 0.35],
  circle: ['circleopen', 0.4],
  blur: ['hblur', 0.3],
};

export const EFFECTS = ['none', 'zoom_in', 'zoom_out', 'punch'];

export const GRADES = {
  none: '',
  clean: 'eq=contrast=1.04:saturation=1.08',
  punchy: 'eq=contrast=1.12:saturation=1.28:brightness=0.01,vignette=angle=PI/6',
  warm: 'colorbalance=rs=0.05:gs=0.01:bs=-0.06:rm=0.04:bm=-0.04,eq=contrast=1.05:saturation=1.12',
  moody: 'eq=contrast=1.12:saturation=0.85:brightness=-0.03,vignette=angle=PI/5',
  bright: 'eq=contrast=1.06:saturation=1.18:brightness=0.03:gamma=1.04',
};

export const STYLES = {
  montage: {
    id: 'montage',
    label: 'Beat montage',
    blurb: 'Fast cuts on the beat, zoom punches and flash transitions.',
    brief: 'High-energy montage. Many short shots (about 1–2 beats each), cut on the beat. Mix hard cuts with a few flash/zoom/whip transitions on big moments. Use punch-in and zoom effects for energy. Very little text: a bold hook and 1–2 short captions.',
    beats: [1, 2],
    segLen: [0.9, 1.8],
    transitions: { cut: 6, flash: 2, zoom: 2, whip: 2, blur: 1 },
    effects: { punch: 3, zoom_in: 2, none: 3, zoom_out: 1 },
    grade: 'punchy',
    text: 'bold',
    captionEvery: 4,
    mood: 'energetic',
    mix: { original: 0.3, music: 1 },
  },
  transformation: {
    id: 'transformation',
    label: 'Before & after',
    blurb: 'Starts on the "before", builds through the work, slow-mo reveal, split-screen finish.',
    brief: 'Transformation story. Open on the clearest BEFORE shot, show the work in chronological order, slow the reveal down (speed 0.6–0.8), and finish with a split-screen segment (layout "split") comparing a before moment (compare_video/compare_start) with the after. Smooth transitions (fade, slide, wipe) between stages.',
    beats: [2, 4],
    segLen: [1.6, 3],
    transitions: { fade: 3, wipe: 2, slideup: 2, cut: 2 },
    effects: { none: 3, zoom_in: 2 },
    grade: 'clean',
    text: 'box',
    captionEvery: 2,
    split: true,
    mood: 'build',
    mix: { original: 0.5, music: 0.9 },
  },
  satisfying: {
    id: 'satisfying',
    label: 'Satisfying process',
    blurb: 'Longer, calm shots, smooth crossfades, the real sound up front, minimal text.',
    brief: 'Satisfying / ASMR-style process video. Fewer, longer shots (3–5 seconds) of the most tactile moments, gentle slow push-ins, soft crossfades or dissolves, keep the original sound prominent, minimal lowercase text.',
    beats: [4, 8],
    segLen: [2.8, 4.5],
    transitions: { dissolve: 3, fade: 3 },
    effects: { zoom_in: 3, none: 2, zoom_out: 1 },
    grade: 'clean',
    text: 'minimal',
    captionEvery: 3,
    mood: 'chill',
    mix: { original: 0.85, music: 0.65 },
  },
  story: {
    id: 'story',
    label: 'Story / day in the life',
    blurb: 'A caption on every shot that tells a story, soft transitions, warm look.',
    brief: 'Behind-the-scenes story told through captions: every segment gets a short narrative caption in first person ("6am, prepping the brisket"). Medium-length shots, soft transitions (fade, slide, fadeblack), warm feel.',
    beats: [2, 4],
    segLen: [1.8, 3.2],
    transitions: { fade: 3, slide: 2, fadeblack: 1, cut: 2 },
    effects: { none: 3, zoom_in: 1, zoom_out: 1 },
    grade: 'warm',
    text: 'story',
    captionEvery: 1,
    mood: 'chill',
    mix: { original: 0.7, music: 0.8 },
  },
  listicle: {
    id: 'listicle',
    label: 'Top 3 list',
    blurb: 'Numbered moments ("3 reasons…") with list captions.',
    brief: 'Listicle. Hook like "3 things that make us different". Then exactly three sections, each opened by a caption starting with its number ("1. Hand-cut every morning"), each 1–2 shots. Wipe or slide transitions between sections, cuts within a section.',
    beats: [2, 4],
    segLen: [1.6, 2.8],
    transitions: { wipe: 2, slide: 2, cut: 2 },
    effects: { punch: 1, zoom_in: 2, none: 2 },
    grade: 'bright',
    text: 'list',
    captionEvery: 1,
    mood: 'energetic',
    mix: { original: 0.4, music: 0.95 },
  },
  promo: {
    id: 'promo',
    label: 'Promo ad',
    blurb: 'Offer-led ad: big bold text, quick cuts, strong call to action.',
    brief: 'Short promotional ad. Hook states the offer or main benefit. Quick, punchy shots of the best results, zoom and flash transitions, bold captions that sell (benefits, price, urgency), ending with a big call to action.',
    beats: [1, 2],
    segLen: [1.1, 2],
    transitions: { zoom: 2, flash: 2, cut: 3, slide: 1 },
    effects: { punch: 2, zoom_in: 2, none: 2 },
    grade: 'punchy',
    text: 'promo',
    captionEvery: 2,
    mood: 'energetic',
    mix: { original: 0.3, music: 1 },
  },
};

export const STYLE_IDS = Object.keys(STYLES);

export function getStyle(id) {
  return STYLES[id] || STYLES.montage;
}

/** The style for each clip: the chosen one, or a varied mix that suits the business. */
export function stylesForClips(choice, clipCount, businessId, rng = Math.random) {
  if (choice && STYLES[choice]) return Array(clipCount).fill(choice);
  const lead = {
    restaurant: ['montage', 'satisfying', 'story', 'promo', 'listicle'],
    detailing: ['transformation', 'satisfying', 'montage', 'promo', 'listicle'],
    trades: ['transformation', 'story', 'listicle', 'montage', 'promo'],
    barber: ['transformation', 'montage', 'satisfying', 'promo', 'story'],
    gym: ['montage', 'listicle', 'story', 'promo', 'transformation'],
  }[businessId] || ['montage', 'story', 'transformation', 'listicle', 'promo'];
  // Keep the best-suited style first, shuffle the rest so repeats differ.
  const rest = lead.slice(1).sort(() => rng() - 0.5);
  return [lead[0], ...rest].slice(0, clipCount);
}

export function weightedPick(weights, rng = Math.random) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) {
    if ((r -= w) <= 0) return k;
  }
  return entries[0][0];
}

export function publicStyleList() {
  return Object.values(STYLES).map(({ id, label, blurb }) => ({ id, label, blurb }));
}
