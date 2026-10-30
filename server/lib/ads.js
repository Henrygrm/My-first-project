// Animated ads: photo/logo assets, storyboard planning (Claude or templates),
// rendering and change requests. Ads live in the same project as the clips.
import fs from 'node:fs/promises';
import path from 'node:path';
import { AD_THEMES, ANIMATIONS, FORMATS, SCENE_TYPES, renderAd } from './adRender.js';
import { aiConfigured, planAds, reviseAds, SetupError } from './ai.js';
import { getBusiness } from './businesses.js';
import { FFMPEG, frameAt, run } from './ffmpeg.js';
import { findTrack, getTrack, listTracks, MUSIC_DIR, pickTrack } from './music.js';
import { cleanProfile } from './pipeline.js';
import { makeRng } from './planner.js';
import { cleanOnScreenText } from './subtitles.js';
import { loadProject, newId, projectDir, updateProject } from './store.js';

export const AD_LENGTHS = [10, 15, 20, 30];
const assetDir = (projectId) => path.join(projectDir(projectId), 'ad-assets');
const outDir = (projectId) => path.join(projectDir(projectId), 'ad-output');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const oneOf = (v, list, fallback) => {
  const s = String(v || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return list.includes(s) ? s : fallback;
};
const short = (text, n) => {
  const t = cleanOnScreenText(text);
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const pick = (list, rng) => list[Math.floor(rng() * list.length)];

// ---------------------------------------------------------------------------
// Assets: photos and logo
// ---------------------------------------------------------------------------

/** Convert an uploaded image (JPG, PNG, WebP, HEIC…) to a web-friendly file plus a small thumbnail. */
export async function addAsset(projectId, tmpPath, originalName, kind) {
  const dir = assetDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const id = newId('i');
  const isLogo = kind === 'logo';
  const file = `${id}.${isLogo ? 'png' : 'jpg'}`;
  const thumb = `${id}-t.${isLogo ? 'png' : 'jpg'}`;
  const big = isLogo ? "scale='min(1200,iw)':-2" : "scale='if(gt(iw,ih),min(2400,iw),-2)':'if(gt(iw,ih),-2,min(2400,ih))'";
  const small = "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'";
  try {
    await run(FFMPEG, ['-y', '-v', 'error', '-i', tmpPath, '-frames:v', '1', '-vf', big, ...(isLogo ? [] : ['-q:v', '3']), path.join(dir, file)]);
    await run(FFMPEG, ['-y', '-v', 'error', '-i', path.join(dir, file), '-frames:v', '1', '-vf', small, ...(isLogo ? [] : ['-q:v', '5']), path.join(dir, thumb)]);
  } catch {
    await fs.rm(path.join(dir, file), { force: true });
    throw new Error("Couldn't read this image. Save it as a JPG or PNG and try again.");
  }
  return { id, file, thumb, name: String(originalName || 'image').slice(0, 120), kind: isLogo ? 'logo' : 'photo', addedAt: new Date().toISOString() };
}

/** Rotate a photo 90° clockwise (for phone photos that come in sideways). */
export async function rotateAsset(projectId, assetId) {
  const project = await loadProject(projectId);
  const a = project?.adAssets?.find((x) => x.id === assetId);
  if (!a) throw Object.assign(new Error('Image not found'), { status: 404 });
  const dir = assetDir(projectId);
  for (const f of [a.file, a.thumb]) {
    const tmp = path.join(dir, `rot-${f}`);
    await run(FFMPEG, ['-y', '-v', 'error', '-i', path.join(dir, f), '-frames:v', '1', '-vf', 'transpose=1', ...(f.endsWith('.jpg') ? ['-q:v', '3'] : []), tmp]);
    await fs.rename(tmp, path.join(dir, f));
  }
  return updateProject(projectId, (p) => {
    const x = p.adAssets.find((y) => y.id === assetId);
    if (x) x.rev = (x.rev || 0) + 1;
  });
}

export async function deleteAsset(projectId, assetId) {
  let removed;
  const project = await updateProject(projectId, (p) => {
    const i = (p.adAssets || []).findIndex((x) => x.id === assetId);
    if (i < 0) throw Object.assign(new Error('Image not found'), { status: 404 });
    [removed] = p.adAssets.splice(i, 1);
  });
  for (const f of [removed.file, removed.thumb]) await fs.rm(path.join(assetDir(projectId), f), { force: true });
  return project;
}

/** Take sharp, bright stills from the project's videos to use as ad photos. */
export async function stillsFromFootage(projectId, want = 6) {
  const project = await loadProject(projectId);
  if (!project?.videos?.length) throw Object.assign(new Error('Add videos on the Home page first.'), { status: 400 });
  const dir = assetDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const total = project.videos.reduce((s, v) => s + v.meta.duration, 0);
  const picks = [];
  for (const v of project.videos) {
    const n = Math.max(1, Math.round((want * v.meta.duration) / total));
    let signals = null;
    try {
      signals = JSON.parse(await fs.readFile(path.join(projectDir(projectId), 'work', v.id, 'signals.json'), 'utf8'));
    } catch {}
    for (let k = 0; k < n; k++) {
      const d = v.meta.duration;
      // Evenly spread across the middle of the video, nudged to a bright, steady second when measured.
      let t = d * (0.1 + (0.8 * (k + 0.5)) / n);
      if (signals) {
        const lo = Math.floor(d * (0.1 + (0.8 * k) / n));
        const hi = Math.max(lo + 1, Math.floor(d * (0.1 + (0.8 * (k + 1)) / n)));
        let best = -Infinity;
        for (let s = lo; s < hi && s < signals.motion.length; s++) {
          const b = signals.brightness[s] ?? 100;
          const score = (b > 50 ? 1 : 0) - Math.abs((signals.motion[s] || 0) - 4) / 10;
          if (score > best) {
            best = score;
            t = s + 0.5;
          }
        }
      }
      picks.push({ v, t: Math.min(d - 0.1, t) });
    }
  }
  const added = [];
  for (const { v, t } of picks.slice(0, want + 2)) {
    const tmp = path.join(dir, `still-${newId()}.jpg`);
    try {
      await frameAt(path.join(projectDir(projectId), 'videos', v.file), t, tmp, 1920, v.meta);
      added.push(await addAsset(projectId, tmp, `${v.name} @ ${t.toFixed(1)}s`, 'photo'));
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  return updateProject(projectId, (p) => {
    p.adAssets = [...(p.adAssets || []), ...added];
  });
}

// ---------------------------------------------------------------------------
// Storyboards
// ---------------------------------------------------------------------------

/** Validate an ad storyboard (from Claude or the editor) so it always renders. */
export function sanitizeAd(raw, { photos, target, defaults = {} }) {
  const accent = String(raw.accent_color ?? raw.accent ?? '').trim();
  const ad = {
    title: short(raw.title || 'Ad', 60) || 'Ad',
    angle: String(raw.angle || '').slice(0, 120),
    why_it_works: String(raw.why_it_works || '').slice(0, 400),
    theme: AD_THEMES[raw.theme] ? raw.theme : oneOf(raw.theme, Object.keys(AD_THEMES), defaults.theme || 'bold'),
    accent: /^#?[0-9a-f]{6}$/i.test(accent) ? `#${accent.replace('#', '').toLowerCase()}` : defaults.accent || '',
    music_mood: oneOf(raw.music_mood, ['energetic', 'chill', 'build'], ''),
    post_caption: String(raw.post_caption || '').slice(0, 2200),
    hashtags: (raw.hashtags || []).map((h) => `#${String(h).replace(/^#+/, '').replace(/\s+/g, '')}`).filter((h) => h.length > 1).slice(0, 12),
  };
  let scenes = (raw.scenes || []).slice(0, 10).map((s) => {
    // Claude numbers photos from 1; the editor sends 0-based `photo` with `photoIndex: true`.
    const n = Math.round(Number(s.photo));
    const photo = s.zeroBased ? (n >= 0 && n < photos ? n : -1) : n >= 1 && n <= photos ? n - 1 : -1;
    const scene = {
      type: oneOf(s.type, SCENE_TYPES, 'hook'),
      headline: short(s.headline, 90),
      subline: short(s.subline, 90),
      items: (s.items || []).map((x) => short(x, 42)).filter(Boolean).slice(0, 4),
      photo,
      animation: oneOf(s.animation, ANIMATIONS, 'slide'),
      duration: clamp(Number(s.duration) || 2.5, 1.2, 6),
    };
    if (scene.type === 'photo' && scene.photo < 0) scene.type = 'hook';
    if (scene.type === 'features' && !scene.items.length) scene.type = 'hook';
    return scene;
  }).filter((s) => s.headline || s.items.length || s.photo >= 0);
  if (!scenes.length) scenes = [{ type: 'hook', headline: defaults.hook || 'Book today', subline: '', items: [], photo: -1, animation: 'pop', duration: 3 }];
  if (scenes.at(-1).type !== 'cta') {
    scenes.push({ type: 'cta', headline: defaults.cta || 'Book today', subline: defaults.ctaSub || '', items: [defaults.button || 'Link in bio'], photo: -1, animation: 'pop', duration: 3 });
  }
  ad.scenes = fitDurations(scenes, target);
  ad.targetSeconds = target;
  return ad;
}

/** Scale scene lengths so the ad lands on the target length. */
function fitDurations(scenes, target) {
  // The closing call to action always gets time to be read; the rest share what's left.
  const last = scenes.length > 1 ? Math.max(2.2, Math.min(4, scenes.at(-1).duration)) : target;
  let out = scenes.slice(0, -1).map((s) => ({ ...s }));
  const room = Math.max(1.2 * out.length, target - last);
  for (let pass = 0; pass < 4 && out.length; pass++) {
    const sum = out.reduce((a, s) => a + s.duration, 0);
    const k = room / sum;
    if (Math.abs(k - 1) < 0.01) break;
    out = out.map((s) => ({ ...s, duration: clamp(Math.round(s.duration * k * 100) / 100, 1.2, 6) }));
  }
  return [...out, { ...scenes.at(-1), duration: clamp(last, 1.2, 6) }];
}

function adDefaults(business, profile) {
  const name = profile.name;
  const sub = [profile.location, profile.contact].filter(Boolean).join('  ·  ');
  return {
    hook: business.hooks[0],
    cta: name && name.length <= 22 ? `${business.cta.split(' ')[0]} ${name} today` : business.cta,
    ctaSub: sub,
    button: profile.contact && profile.contact.length <= 24 ? 'Message us' : 'Link in bio',
  };
}

/** Template ads for free mode: three different concepts built from the business details. */
export function templateAds({ business, profile, photos, count, target, theme, accent, rng }) {
  const services = (profile.services || '').split(/[,;\n]|\band\b/).map((x) => x.trim().replace(/^./, (c) => c.toUpperCase())).filter((x) => x.length > 2 && x.length <= 40);
  const d = adDefaults(business, profile);
  const ph = (i) => (photos ? (i % photos) + 1 : 0);
  const photoScenes = (from, n, captions) => Array.from({ length: Math.min(n, photos) }, (_, i) => ({
    type: 'photo', headline: captions[i % captions.length], subline: '', items: [], photo: ph(from + i), animation: pick(['slide', 'typewriter'], rng), duration: 2.2,
  }));
  const cta = { type: 'cta', headline: d.cta, subline: d.ctaSub, items: [d.button], photo: 0, animation: 'pop', duration: 3 };
  const reasons = services.length >= 3 ? services.slice(0, 3) : business.reasons.slice(0, 3);
  const review = profile.review ? [{ type: 'review', headline: profile.review, subline: 'Customer review', items: [], photo: 0, animation: 'slide', duration: 3.2 }] : [];

  const concepts = [
    {
      title: profile.offer ? 'Offer ad' : 'Showcase ad',
      angle: profile.offer ? 'Offer' : 'Showcase',
      scenes: [
        { type: photos ? 'photo' : 'hook', headline: pick(business.hooks, rng), subline: profile.location || '', items: [], photo: ph(0), animation: 'words', duration: 2.4 },
        ...photoScenes(1, 2, services.length ? services : business.captions),
        profile.offer
          ? { type: 'offer', headline: profile.offer, subline: profile.name || '', items: [], photo: 0, animation: 'pop', duration: 2.6 }
          : { type: 'features', headline: 'What you get', subline: '', items: reasons, photo: 0, animation: 'slide', duration: 3.4 },
        cta,
      ],
    },
    {
      title: 'Why choose us',
      angle: 'Trust',
      scenes: [
        { type: 'hook', headline: profile.location ? `${profile.location}, this one's for you` : pick(business.hooks, rng), subline: profile.name || '', items: [], photo: 0, animation: 'words', duration: 2.4 },
        { type: 'features', headline: `Why locals choose ${profile.name || 'us'}`, subline: '', items: reasons, photo: 0, animation: 'pop', duration: 3.6 },
        ...photoScenes(2, 1, business.captions.slice(-1)),
        ...review,
        cta,
      ],
    },
    {
      title: 'Quick promo',
      angle: 'Promo',
      scenes: [
        { type: 'hook', headline: pick(business.hooks, rng), subline: profile.name || '', items: [], photo: 0, animation: 'zoom', duration: 1.8 },
        ...photoScenes(0, 3, services.length ? [...services].reverse() : business.captions),
        ...(profile.offer ? [{ type: 'offer', headline: profile.offer, subline: '', items: [], photo: 0, animation: 'pop', duration: 2.4 }] : []),
        cta,
      ],
    },
  ];
  const themes = Object.keys(AD_THEMES).sort(() => rng() - 0.5);
  return concepts.slice(0, count).map((c, i) => sanitizeAd({
    ...c,
    theme: theme !== 'auto' ? theme : themes[i],
    accent_color: accent,
    why_it_works: 'Template ad built from your business details. Add a Claude key for an ad planned around this business.',
    post_caption: `${c.scenes[0].headline} 👀\n\n${d.cta}.${profile.location ? ` 📍 ${profile.location}` : ''}`,
    hashtags: business.hashtagSeeds,
  }, { photos, target, defaults: { ...d, theme: themes[i], accent } }));
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function addAdChat(p, who, text, error = false) {
  p.adChat = [...(p.adChat || []), { who, text, at: new Date().toISOString(), ...(error ? { error: true } : {}) }].slice(-60);
}

const photosOf = (project) => (project.adAssets || []).filter((a) => a.kind === 'photo');
const logoOf = (project) => (project.adAssets || []).find((a) => a.kind === 'logo') || null;

async function chooseTrack(ad, musicChoice, tracks, used, rng) {
  if (musicChoice === 'none') return null;
  if (musicChoice !== 'auto') return getTrack(musicChoice);
  let track = ad.music_track && ad.music_track !== 'auto' ? findTrack(tracks, ad.music_track) : null;
  return track || pickTrack(ad.music_mood || AD_THEMES[ad.theme]?.mood || 'energetic', used, rng);
}

async function renderAll(projectId, indexes, ctx, base = 0.4) {
  const project = await loadProject(projectId);
  const photos = photosOf(project);
  const logo = logoOf(project);
  const dir = assetDir(projectId);
  const settings = project.adSettings || {};
  const span = 1 - base;
  for (const [n, idx] of indexes.entries()) {
    const ad = project.adPlan.ads[idx];
    ctx.stage(`Animating ad ${n + 1} of ${indexes.length}: "${ad.title}"`, base + (span * n) / indexes.length);
    const track = ad.music?.id ? await getTrack(ad.music.id) : null;
    const result = await renderAd(ad, {
      outDir: outDir(projectId),
      baseName: `ad-${idx + 1}-${Date.now().toString(36)}`,
      format: project.adPlan.format,
      images: photos.map((a) => path.join(dir, a.file)),
      logo: logo ? path.join(dir, logo.file) : null,
      music: track ? { path: path.join(MUSIC_DIR, track.file), startAt: track.startAt, loudness: track.loudness, bpm: track.bpm } : null,
      musicLevel: settings.musicLevel,
      onProgress: (p) => ctx.progress(base + (span * (n + p)) / indexes.length),
    });
    await updateProject(projectId, (p) => {
      p.adRenders = p.adRenders || [];
      p.adRenders[idx] = { ...result, renderedAt: new Date().toISOString() };
    });
    const keep = path.parse(result.file).name;
    for (const f of await fs.readdir(outDir(projectId))) {
      if (f.startsWith(`ad-${idx + 1}-`) && path.parse(f).name !== keep) await fs.rm(path.join(outDir(projectId), f), { force: true });
    }
  }
}

/** Plan and render a set of ads. */
export async function generateAds(projectId, opts, ctx) {
  const project = await loadProject(projectId);
  if (!project) throw new Error('Project not found');
  const business = getBusiness(opts.business, opts.businessCustom);
  const profile = cleanProfile(opts.profile);
  const count = clamp(Math.round(Number(opts.count) || 2), 1, 3);
  const seconds = AD_LENGTHS.includes(Number(opts.seconds)) ? Number(opts.seconds) : 15;
  const format = FORMATS[opts.format] ? opts.format : '9:16';
  const theme = AD_THEMES[opts.theme] ? opts.theme : 'auto';
  const accent = /^#[0-9a-f]{6}$/i.test(opts.accent || '') ? opts.accent.toLowerCase() : '';
  const musicChoice = opts.music || 'auto';
  const mode = opts.mode === 'auto' ? 'auto' : 'ai';
  const tracks = await listTracks();
  const photos = photosOf(project);
  const logo = logoOf(project);
  const rng = makeRng();
  if (!profile.name && !profile.services) throw new Error('Fill in the business name and what they sell first (Business details).');
  if (mode === 'ai' && !aiConfigured()) throw new SetupError('The AI needs a Claude API key. Add it on the Settings page, or switch the engine to Free auto-edit there.');

  let plan;
  if (mode === 'ai') {
    ctx.stage(`The AI is writing ${count} ad${count > 1 ? 's' : ''} for ${profile.name || business.label}…`, 0.05);
    let p = 0.05;
    const ticker = setInterval(() => ctx.progress((p = Math.min(0.35, p + 0.005))), 1000);
    let res;
    try {
      res = await planAds({
        business, profile, count, seconds, format: FORMATS[format].label,
        theme, accent, instructions: String(opts.instructions || '').slice(0, 2000),
        photos: photos.map((a) => path.join(assetDir(projectId), a.thumb)),
        logo: logo ? path.join(assetDir(projectId), logo.thumb) : null,
        tracks: musicChoice === 'auto' ? tracks : [],
      });
    } finally {
      clearInterval(ticker);
    }
    const d = adDefaults(business, profile);
    plan = {
      source: 'ai',
      model: res.model,
      strategy: res.data.strategy || '',
      ads: (res.data.ads || []).slice(0, count).map((a) => ({
        ...sanitizeAd(a, { photos: photos.length, target: seconds, defaults: { ...d, theme: theme === 'auto' ? 'bold' : theme, accent } }),
        music_track: a.music_track,
        ...(theme !== 'auto' ? { theme } : {}),
        ...(accent ? { accent } : {}),
      })),
    };
    if (!plan.ads.length) throw new Error('The AI did not return any ads. Try again.');
  } else {
    ctx.stage('Building ads from your business details', 0.1);
    plan = { source: 'auto', strategy: '', ads: templateAds({ business, profile, photos: photos.length, count, target: seconds, theme, accent, rng }) };
  }

  const used = [];
  for (const ad of plan.ads) {
    const track = await chooseTrack(ad, musicChoice, tracks, used, rng);
    if (track) used.push(track.id);
    ad.music = track ? { id: track.id, name: track.name, bpm: track.bpm } : null;
    delete ad.music_track;
  }
  if (musicChoice !== 'none' && !tracks.length) plan.musicNote = 'No music: your music library is empty. Add songs on the Music page, then make the ads again.';
  Object.assign(plan, { format, seconds, business: business.id, createdAt: new Date().toISOString() });

  await fs.rm(outDir(projectId), { recursive: true, force: true });
  await updateProject(projectId, (p) => {
    p.adPlan = plan;
    p.adRenders = [];
    p.profile = profile;
    p.adSettings = { count, seconds, format, theme, accent, music: musicChoice, musicLevel: opts.musicLevel || 'normal', mode };
    addAdChat(p, 'cutline', plan.source === 'ai'
      ? `Made ${plan.ads.length} ad${plan.ads.length > 1 ? 's' : ''}. ${plan.strategy}`.trim()
      : `Made ${plan.ads.length} template ad${plan.ads.length > 1 ? 's' : ''} (no AI).`);
  });
  await renderAll(projectId, plan.ads.map((_, i) => i), ctx);
  return { projectId };
}

/** Save hand edits to one ad and re-render it. */
export async function rerenderAd(projectId, index, edited, ctx) {
  const project = await loadProject(projectId);
  const idx = Number(index);
  const old = project?.adPlan?.ads?.[idx];
  if (!old) throw new Error('Ad not found');
  const photos = photosOf(project).length;
  const tracks = await listTracks();
  const ad = sanitizeAd({
    ...old,
    ...edited,
    accent_color: edited.accent ?? old.accent,
    scenes: (edited.scenes || old.scenes).map((s) => ({ ...s, zeroBased: true })),
  }, { photos, target: Number(edited.targetSeconds) || old.targetSeconds || 15, defaults: { theme: old.theme } });
  // Keep hand-set scene lengths: the editor already decides them.
  if (edited.scenes) ad.scenes = ad.scenes.map((s, i) => ({ ...s, duration: clamp(Number(edited.scenes[i]?.duration) || s.duration, 1.2, 6) }));
  let music = old.music;
  if (edited.music === 'none') music = null;
  else if (edited.music && edited.music !== old.music?.id) {
    const t = tracks.find((x) => x.id === edited.music);
    if (t) music = { id: t.id, name: t.name, bpm: t.bpm };
  }
  ad.music = music;
  await updateProject(projectId, (p) => {
    p.adPlan.ads[idx] = ad;
  });
  await renderAll(projectId, [idx], ctx, 0.05);
  return { projectId };
}

/** Rule-based ad changes for free mode. */
function parseAdRequest(text, plan, tracks) {
  const t = ` ${text.toLowerCase()} `;
  const did = [];
  const patch = {};
  let idx = [...t.matchAll(/\bads?\s*(?:#|number\s*)?(\d)\b/g)].map((m) => Number(m[1]) - 1).filter((i) => plan.ads[i]);
  const secs = t.match(/\b(10|15|20|30)\s*(?:s|sec|secs|seconds?)\b/);
  if (secs) {
    patch.targetSeconds = Number(secs[1]);
    did.push(`set the length to ${secs[1]} seconds`);
  }
  for (const id of Object.keys(AD_THEMES)) {
    if (new RegExp(`\\b${id}\\b`).test(t)) {
      patch.theme = id;
      did.push(`switched to the ${AD_THEMES[id].label} look`);
    }
  }
  const col = text.match(/#([0-9a-f]{6})\b/i);
  if (col) {
    patch.accent = `#${col[1].toLowerCase()}`;
    did.push(`set the brand colour to ${patch.accent}`);
  }
  const q = (k) => text.match(new RegExp(`${k}\\s*(?:to|:|=)\\s*["“']?(.+?)["”']?\\s*$`, 'i'))?.[1];
  const hook = q('(?:hook|headline|opening)');
  if (hook) {
    patch.hook = hook;
    did.push(`changed the opening to "${hook}"`);
  }
  const cta = q('(?:cta|call to action|ending)');
  if (cta) {
    patch.cta = cta;
    did.push(`changed the ending to "${cta}"`);
  }
  if (/\b(no|remove|without)\s+(the\s+)?(music|song)\b/.test(t)) {
    patch.music = 'none';
    did.push('removed the music');
  } else {
    const named = tracks.find((tr) => t.includes(tr.name.toLowerCase()));
    if (named) {
      patch.music = named.id;
      did.push(`switched the music to "${named.name}"`);
    } else if (/\b(different|another|new|change( the)?)\s+(song|track|music)\b/.test(t) && tracks.length) {
      patch.music = 'next';
      did.push('changed the song');
    }
  }
  if (/\b(redo|regenerate|new version|try again|start over)\b/.test(t)) {
    patch.redo = true;
    did.push('made a fresh version');
  }
  if (!idx.length) idx = plan.ads.map((_, i) => i);
  return {
    understood: did.length > 0,
    idx,
    patch,
    reply: did.length
      ? `Done: ${did.join(', ')}.`
      : `I couldn't work out that change without the AI. Without a Claude key I understand: "make it 20 seconds", "make it luxury" (or ${Object.keys(AD_THEMES).join(', ')}), "colour #ff3366", "hook: Your text", "cta: Your text", "no music", "different song", "redo ad 2". Add a Claude key in Settings to ask for anything.`,
  };
}

/** "Ask for changes" on the Ads page. */
export async function reviseAdsJob(projectId, { request, adIndex, mode }, ctx) {
  const project = await loadProject(projectId);
  if (!project?.adPlan) throw new Error('Make ads first, then ask for changes.');
  const text = String(request || '').trim().slice(0, 1000);
  const focus = Number.isInteger(adIndex) && project.adPlan.ads[adIndex] ? adIndex : null;
  await updateProject(projectId, (p) => addAdChat(p, 'you', focus !== null ? `Ad ${focus + 1}: ${text}` : text));

  const business = getBusiness(project.adPlan.business, project.businessCustom);
  const profile = cleanProfile(project.profile);
  const tracks = await listTracks();
  const photos = photosOf(project);
  const logo = logoOf(project);
  const plan = project.adPlan;
  const newAds = plan.ads.map((a) => ({ ...a }));
  const changed = [];
  let reply;
  const rng = makeRng();

  if (aiConfigured() && mode !== 'auto') {
    ctx.stage('The AI is working on your changes…', 0.05);
    let p = 0.05;
    const ticker = setInterval(() => ctx.progress((p = Math.min(0.35, p + 0.005))), 1000);
    let res;
    try {
      res = await reviseAds({
        business, profile, plan, request: text, adNumber: focus !== null ? focus + 1 : null, tracks,
        format: FORMATS[plan.format]?.label || plan.format,
        photos: photos.map((a) => path.join(assetDir(projectId), a.thumb)),
        logo: logo ? path.join(assetDir(projectId), logo.thumb) : null,
      });
    } catch (err) {
      await updateProject(projectId, (q) => addAdChat(q, 'cutline', `That didn't work: ${err.message}`, true));
      throw err;
    } finally {
      clearInterval(ticker);
    }
    reply = res.data.reply;
    for (const item of res.data.ads || []) {
      const i = Math.round(Number(item.ad_number)) - 1;
      if (!newAds[i] || (focus !== null && i !== focus)) continue;
      const before = JSON.stringify(newAds[i].scenes.map((s) => [s.type, s.headline, s.subline, s.items, s.photo + 1]));
      const after = JSON.stringify((item.scenes || []).map((s) => [s.type, s.headline, s.subline, s.items, s.photo]));
      const differs = before !== after || item.theme !== newAds[i].theme || (item.music_track && item.music_track !== 'keep');
      if (!item.changed && !differs) continue;
      const target = AD_LENGTHS.includes(Math.round(item.target_seconds)) ? Math.round(item.target_seconds) : clamp(Math.round(Number(item.target_seconds) || newAds[i].targetSeconds), 6, 60);
      const ad = sanitizeAd(item, { photos: photos.length, target, defaults: { theme: newAds[i].theme, accent: newAds[i].accent } });
      let music = newAds[i].music;
      if (item.music_track === 'none') music = null;
      else if (item.music_track && item.music_track !== 'keep') {
        const tr = findTrack(tracks, item.music_track);
        if (tr) music = { id: tr.id, name: tr.name, bpm: tr.bpm };
      }
      newAds[i] = { ...ad, music };
      changed.push(i);
    }
    console.log(`[ads revise] "${text}" → changed ads: ${changed.map((i) => i + 1).join(', ') || 'none'}`);
    if (!changed.length) reply += ' (No ad was actually changed. Try saying exactly what to change, e.g. "ad 1: open with the offer and use the neon look".)';
  } else {
    const cmd = parseAdRequest(text, plan, tracks);
    reply = cmd.reply;
    if (cmd.understood) {
      const indexes = focus !== null ? [focus] : cmd.idx;
      const p = cmd.patch;
      for (const i of indexes) {
        let ad = { ...newAds[i], scenes: newAds[i].scenes.map((s) => ({ ...s })) };
        if (p.redo) {
          const fresh = templateAds({ business, profile, photos: photos.length, count: 3, target: ad.targetSeconds, theme: ad.theme, accent: ad.accent, rng });
          ad = { ...fresh[Math.floor(rng() * fresh.length)], music: ad.music };
        }
        if (p.theme) ad.theme = p.theme;
        if (p.accent) ad.accent = p.accent;
        if (p.hook) ad.scenes[0].headline = short(p.hook, 90);
        if (p.cta) ad.scenes.at(-1).headline = short(p.cta, 90);
        if (p.targetSeconds) {
          ad.scenes = fitDurations(ad.scenes, p.targetSeconds);
          ad.targetSeconds = p.targetSeconds;
        }
        if (p.music === 'none') ad.music = null;
        else if (p.music === 'next') {
          const at = tracks.findIndex((t) => t.id === ad.music?.id);
          const t = tracks[(at + 1) % tracks.length];
          ad.music = { id: t.id, name: t.name, bpm: t.bpm };
        } else if (p.music) {
          const t = tracks.find((x) => x.id === p.music);
          ad.music = { id: t.id, name: t.name, bpm: t.bpm };
        }
        newAds[i] = ad;
        changed.push(i);
      }
    }
  }

  await updateProject(projectId, (q) => {
    for (const i of changed) q.adPlan.ads[i] = newAds[i];
    addAdChat(q, 'cutline', reply || 'Nothing needed changing.');
  });
  if (changed.length) await renderAll(projectId, changed, ctx, 0.4);
  return { projectId, changed, reply };
}
