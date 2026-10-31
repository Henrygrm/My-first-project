// Creative director: plans ad storyboards. With a Claude key the plan comes
// from Claude (see ai.js planAdBoards) and is validated here; without one,
// planFree builds distinct concepts from the business details and the media.
import { rng } from '../../public/engine/core.js';
import { RECIPES } from '../../public/engine/recipes.js';
import { DIRECTIONS, INDUSTRY_DIRECTIONS } from '../../public/engine/styles.js';
import { TRANSITIONS } from '../../public/engine/compose.js';

export const OBJECTIVES = {
  auto: 'Let the director decide',
  bookings: 'Get bookings / orders',
  offer: 'Promote an offer',
  showcase: 'Show off the work / product',
  trust: 'Build trust (quality, reviews)',
  local: 'Bring in locals (location)',
};

const ENTRANCES = ['rise', 'drop', 'pop', 'zoom', 'scaleDown', 'blur', 'tilt', 'spin', 'slideL', 'slideR', 'whip', 'fade'];
const TEXT_ANIMS = ['words', 'pop', 'blurWords', 'slideWords', 'lines', 'chars'];
const CAMERAS = ['push', 'pull', 'pan', 'rise', 'orbit', 'punch', 'still'];
const BASE_DUR = { product_hero: 2.8, photo_full: 2.3, gallery: 2.8, compare: 3.2, kinetic: 2.0, features: 3.4, offer: 2.6, review: 3.4, stat: 2.4, process: 3.6, footage: 2.6, location: 2.4, cta: 3.0 };

const pick = (list, r) => list[Math.floor(r() * list.length) % list.length];
/** Loose label → known id ("Product Hero" → product_hero, "Slide L" → slideL). */
const norm = (v, list) => {
  const raw = String(v || '').trim();
  if (list.includes(raw)) return raw;
  const k = raw.toLowerCase().replace(/[\s-]+/g, '_');
  return list.find((x) => x.toLowerCase() === k || x.toLowerCase() === k.replace(/_/g, '')) || null;
};
const clean = (t, n = 90) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
const titleCase = (s) => s.replace(/^./, (c) => c.toUpperCase());

/** Usable media for planning: photos ranked by quality, cut-outs flagged. */
export function mediaSummary(assets) {
  const photos = (assets || []).filter((a) => a.kind === 'photo').map((a) => {
    const an = a.analysis || {};
    const long = Math.max(an.w || 0, an.h || 0);
    const score = (an.sharpness ? Math.min(1, an.sharpness / 600) : 0.5) * 0.5 + Math.min(1, long / 1600) * 0.3 + (a.cut?.usable ? 0.2 : 0);
    return { id: a.id, cut: Boolean(a.cut?.usable), score, notes: a.notes || '' };
  });
  return photos.sort((x, y) => y.score - x.score);
}

/** Validate and complete a storyboard from Claude or the editor. */
export function normalizeBoard(raw, { assetIds, videoIds, seconds, defaults }) {
  const known = new Set(assetIds);
  const vids = new Set(videoIds);
  const direction = norm(raw.direction, Object.keys(DIRECTIONS)) || defaults.direction;
  let scenes = (raw.scenes || []).slice(0, 12).map((s, i) => {
    const recipe = norm(s.recipe, Object.keys(RECIPES)) || 'kinetic';
    const main = known.has(s.main_asset || s.main) ? (s.main_asset || s.main) : null;
    const alt = (s.other_assets || s.alt || []).filter((id) => known.has(id) && id !== main).slice(0, 3);
    const video = vids.has(s.video) ? s.video : null;
    return {
      id: s.id || `s${i + 1}`,
      recipe,
      purpose: clean(s.purpose, 160),
      duration: Math.max(1.2, Math.min(6, Number(s.duration) || BASE_DUR[recipe] || 2.5)),
      headline: clean(s.headline, 90),
      subline: clean(s.subline, 100),
      items: (s.items || []).map((x) => clean(x, 48)).filter(Boolean).slice(0, 4),
      main, alt, video,
      from: Math.max(0, Number(s.video_from ?? s.from) || 0),
      layout: Number.isInteger(s.layout) && s.layout >= 0 ? s.layout : undefined,
      entrance: norm(s.entrance, ENTRANCES) || undefined,
      textAnim: norm(s.text_animation || s.textAnim, TEXT_ANIMS) || undefined,
      camera: norm(s.camera, CAMERAS) || undefined,
      transition: norm(s.transition, TRANSITIONS) || undefined,
      sfx: s.sfx === 'none' ? 'none' : undefined,
      seed: Number.isInteger(s.seed) ? s.seed : undefined,
    };
  }).filter((s) => s.headline || s.main || s.video || s.recipe === 'cta');
  if (!scenes.length || scenes[scenes.length - 1].recipe !== 'cta') {
    scenes.push({ id: `s${scenes.length + 1}`, recipe: 'cta', purpose: 'Tell viewers exactly what to do next.', duration: 3, headline: defaults.cta, subline: defaults.ctaSub, items: [defaults.button], main: null, alt: [] });
  }
  scenes = fitDurations(scenes, seconds);
  return {
    title: clean(raw.title || 'Ad', 60),
    angle: clean(raw.angle, 80),
    objective: norm(raw.objective, Object.keys(OBJECTIVES)) || 'bookings',
    why: clean(raw.why_it_works || raw.why, 400),
    direction,
    brandColors: (raw.brand_colors || raw.brandColors || []).filter((c) => /^#?[0-9a-f]{6}$/i.test(c)).map((c) => `#${c.replace('#', '').toLowerCase()}`).slice(0, 4),
    musicTrack: clean(raw.music_track || raw.musicTrack, 120),
    musicMood: ['energetic', 'chill', 'build'].includes(raw.music_mood || raw.musicMood) ? (raw.music_mood || raw.musicMood) : DIRECTIONS[direction].mood,
    voiceover: clean(raw.voiceover_script || raw.voiceover, 600),
    postCaption: String(raw.post_caption || raw.postCaption || '').slice(0, 2200),
    hashtags: (raw.hashtags || []).map((h) => `#${String(h).replace(/^#+/, '').replace(/\s+/g, '')}`).filter((h) => h.length > 1).slice(0, 12),
    scenes,
    seconds,
  };
}

/** Scale scene lengths to the target; the call to action keeps reading time. */
export function fitDurations(scenes, target) {
  const out = scenes.map((s) => ({ ...s }));
  const last = out[out.length - 1];
  last.duration = Math.max(2.4, Math.min(4, last.duration));
  const rest = out.slice(0, -1);
  const room = Math.max(1.4 * rest.length, target - last.duration);
  for (let pass = 0; pass < 4 && rest.length; pass++) {
    const sum = rest.reduce((a, s) => a + s.duration, 0);
    const k = room / sum;
    if (Math.abs(k - 1) < 0.01) break;
    rest.forEach((s) => (s.duration = Math.max(1.4, Math.min(6, Math.round(s.duration * k * 100) / 100))));
  }
  return out;
}

export function adDefaults(business, profile) {
  const name = profile.name;
  return {
    cta: name && name.length <= 24 ? `${business.cta.split(' ')[0]} *${name}* today` : business.cta,
    ctaSub: [profile.location, profile.contact].filter(Boolean).join('  ·  '),
    button: profile.contact && profile.contact.length <= 24 ? 'Message us' : 'Link in bio',
  };
}

const INDUSTRY_KEY = { restaurant: 'restaurant', detailing: 'detailing', trades: 'trades', barber: 'barber', gym: 'gym', cafe: 'cafe', other: 'other' };

/**
 * Free-mode planning: up to 3 genuinely different concepts (structure,
 * direction, photo use, copy). Uses only facts the business gave us.
 */
export function planFree({ business, profile, media, videos = [], count = 2, seconds = 15, direction = 'auto', objective = 'auto', seed = Date.now() }) {
  const r = rng(seed);
  const industry = INDUSTRY_KEY[business.id] || (/caf|coffee/i.test(business.label) ? 'cafe' : 'other');
  const services = (profile.services || '').split(/[,;\n]|\band\b/).map((x) => titleCase(x.trim())).filter((x) => x.length > 2 && x.length <= 40);
  const d = adDefaults(business, profile);
  const photos = media.map((m) => m.id);
  const cuts = media.filter((m) => m.cut).map((m) => m.id);
  const hero = cuts[0] || photos[0] || null;
  // Only facts the business gave us: benefits come from its own services.
  const reasons = services.slice(0, 3);
  const hasReasons = reasons.length >= 2;
  const hooks = [...business.hooks].sort(() => r() - 0.5);
  const dirs = direction !== 'auto' ? [direction, direction, direction] : [...(INDUSTRY_DIRECTIONS[industry] || INDUSTRY_DIRECTIONS.other)].sort(() => r() - 0.4);
  const at = (i) => photos.length ? photos[i % photos.length] : null;
  const loc = profile.location;

  const concepts = [];
  // A: product showcase.
  concepts.push({
    title: 'Showcase', angle: 'Product showcase', objective: 'showcase',
    scenes: [
      { recipe: 'product_hero', headline: hooks[0], subline: loc || '', main: hero },
      ...(photos.length >= 3 ? [{ recipe: 'gallery', headline: services[0] || business.captions[1], main: at(1), alt: [at(2), at(3)] }] : photos.length ? [{ recipe: 'photo_full', headline: services[0] || business.captions[2], main: at(1) }] : []),
      ...(videos.length ? [{ recipe: 'footage', headline: business.captions[2], video: videos[0].id, from: videos[0].bestFrom || 0 }] : []),
      ...(hasReasons ? [{ recipe: 'features', headline: profile.name ? `Why people choose *${profile.name}*` : 'Why people choose us', items: reasons, main: at(0) }] : []),
      ...(profile.offer ? [{ recipe: 'offer', headline: profile.offer, subline: profile.name || '', main: cuts[1] || hero }] : []),
      { recipe: 'cta', headline: d.cta, subline: d.ctaSub, items: [d.button], main: hero },
    ],
  });
  // B: trust / proof.
  concepts.push({
    title: 'Why us', angle: 'Trust and proof', objective: 'trust',
    scenes: [
      { recipe: 'kinetic', headline: loc ? `${loc}, *this one's for you*` : hooks[1], subline: profile.name || '', main: at(0) },
      // Process steps describe how it's done (the industry's own steps), so
      // they don't repeat the benefits list that may follow.
      ...(photos.length >= 2 ? [{ recipe: 'process', headline: 'How we do it', items: business.captions.slice(1, 4), main: at(0), alt: [at(1), at(2)] }] : photos.length ? [{ recipe: 'photo_full', headline: hooks[2], main: at(0) }] : []),
      ...(profile.review ? [{ recipe: 'review', headline: profile.review, subline: 'Customer review', main: at(1) }] : hasReasons ? [{ recipe: 'features', headline: 'What you get', items: reasons, main: at(1) }] : []),
      ...(loc ? [{ recipe: 'location', headline: loc, subline: profile.contact || '' }] : []),
      { recipe: 'cta', headline: d.cta, subline: d.ctaSub, items: [d.button], main: hero },
    ],
  });
  // C: offer / quick promo.
  concepts.push({
    title: profile.offer ? 'Offer' : 'Quick promo', angle: profile.offer ? 'Offer' : 'Promo', objective: profile.offer ? 'offer' : 'bookings',
    scenes: [
      { recipe: hero ? 'photo_full' : 'kinetic', headline: profile.offer ? profile.offer : hooks[3] || hooks[0], main: at(0), camera: 'punch' },
      ...(hero ? [{ recipe: 'product_hero', headline: services[0] || business.captions[3], main: cuts[1] || at(1) || hero }] : []),
      ...(profile.offer ? [{ recipe: 'offer', headline: profile.offer, subline: loc ? `At ${profile.name || 'our place'}, ${loc}` : profile.name || '', main: cuts[2] || at(2) || hero }] : [{ recipe: 'kinetic', headline: hooks[2], main: at(1) }]),
      { recipe: 'cta', headline: d.cta, subline: d.ctaSub, items: [d.button], main: hero },
    ],
  });
  if (objective === 'offer' && profile.offer) concepts.unshift(concepts.splice(2, 1)[0]);
  if (objective === 'trust' || objective === 'local') concepts.unshift(concepts.splice(1, 1)[0]);

  // Shorter ads keep the strongest scenes only.
  const maxScenes = Math.max(3, Math.round(seconds / 2.6));
  return concepts.slice(0, count).map((c, i) => {
    let scenes = c.scenes.filter((s) => s.headline || s.main || s.video);
    if (scenes.length > maxScenes) scenes = [...scenes.slice(0, maxScenes - 1), scenes[scenes.length - 1]];
    const board = normalizeBoard({
      ...c,
      direction: dirs[i % dirs.length],
      why_it_works: 'Free mode: built from your business details and photos. Add a Claude key for an ad planned around this business.',
      post_caption: `${scenes[0].headline.replace(/\*/g, '')} \n\n${d.cta.replace(/\*/g, '')}.${loc ? ` 📍 ${loc}` : ''}`,
      hashtags: business.hashtagSeeds,
      scenes: scenes.map((s) => ({ ...s, duration: BASE_DUR[s.recipe], main_asset: s.main, other_assets: s.alt })),
    }, { assetIds: photos, videoIds: videos.map((v) => v.id), seconds, defaults: { direction: dirs[i % dirs.length], ...d } });
    board.seed = Math.floor(r() * 1e6);
    return board;
  });
}
