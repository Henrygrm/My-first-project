import fs from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { RECIPE_IDS, RECIPES } from '../../public/engine/recipes.js';
import { DIRECTION_IDS, DIRECTIONS } from '../../public/engine/styles.js';
import { OBJECTIVES } from './director.js';
import { STYLES } from './styles.js';

export const MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 (best edits)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (about half the cost)',
};
export const DEFAULT_MODEL = 'claude-opus-5-5';

// Read on every call so a key or model changed on the Settings page applies immediately.
export const getModel = () => process.env.CLAUDE_MODEL || DEFAULT_MODEL;
// Server-side refusal fallback: if the model declines, the API re-runs the
// request on Anthropic's recommended fallback model. Set CLAUDE_FALLBACKS=off to disable.
const useFallbacks = () => (process.env.CLAUDE_FALLBACKS || 'on') !== 'off';

export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SETUP_REQUIRED';
  }
}

export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client = null;
let clientKey = null;
function getClient() {
  if (!aiConfigured()) {
    throw new SetupError('The AI needs a Claude API key. Add it on the Settings page.');
  }
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!client || clientKey !== key) {
    client = new Anthropic();
    clientKey = key;
  }
  return client;
}

/** Check the key and model work (a free metadata request, no tokens used). */
export async function checkKey() {
  try {
    await getClient().models.retrieve(getModel());
    return { ok: true, message: `Your key works and can use ${MODELS[getModel()] || getModel()}.` };
  } catch (err) {
    const e = friendlyError(err);
    return { ok: false, message: e.message };
  }
}

function friendlyError(err) {
  const model = getModel();
  if (err instanceof Anthropic.AuthenticationError) return new SetupError('Your Claude API key was rejected. Check it on the Settings page.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error(`Your API key can't use ${model}. Pick another model on the Settings page.`);
  if (err instanceof Anthropic.NotFoundError) return new Error(`Model "${model}" was not found. Pick another model on the Settings page.`);
  if (err instanceof Anthropic.RateLimitError) return new Error('Claude rate limit reached (or your credit ran out). Wait a minute, or check your balance at console.anthropic.com.');
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return new SetupError('Your Anthropic account is out of credit. Add credit at console.anthropic.com → Billing.');
    return new Error(`Claude rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) return new Error('Could not reach Claude. Check your internet connection.');
  if (err instanceof Anthropic.APIError) return new Error(`Claude API error (${err.status ?? 'unknown'}): ${err.message}`);
  if (/Failed to parse structured output/.test(err?.message)) {
    console.error(err);
    return new Error('Claude returned an answer in the wrong shape. Please try again.');
  }
  return err;
}

async function structuredCall({ system, content, schema, effort = 'medium', maxTokens = 32000 }) {
  const anthropic = getClient();
  const params = {
    model: getModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
  };
  if (useFallbacks()) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let message;
  try {
    message = await anthropic.beta.messages.stream(params).finalMessage();
  } catch (err) {
    // Some accounts may not accept the fallback beta; retry without it.
    if (params.fallbacks && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
      const { betas, fallbacks, ...plain } = params;
      try {
        message = await anthropic.beta.messages.stream(plain).finalMessage();
      } catch (err2) {
        throw friendlyError(err2);
      }
    } else {
      throw friendlyError(err);
    }
  }

  if (message.stop_reason === 'refusal') throw new Error('Claude declined this request. Try rewording it.');
  if (message.stop_reason === 'max_tokens') throw new Error('Claude ran out of output space before finishing. Try fewer videos or clips.');
  if (!message.parsed_output) throw new Error('Claude returned a response in the wrong format. Please try again.');
  return { data: message.parsed_output, usage: message.usage, model: message.model };
}

// ---------------------------------------------------------------------------
// Shared schema + context
// ---------------------------------------------------------------------------

const SegmentSchema = z.object({
  video: z.number().describe('1-based video number this shot is taken from'),
  start: z.number().describe('Start time in the SOURCE video, seconds'),
  end: z.number().describe('End time in the SOURCE video, seconds'),
  role: z.string().describe('One of: hook, setup, process, reveal, payoff, cta'),
  caption: z.string().describe('On-screen text during this shot: max 6 words, no emoji, or empty string for none'),
  speed: z.number().describe('Playback speed 0.5–2. 1 normally; 1.5–2 to compress repetitive work; 0.6–0.8 for a slow-motion money shot'),
  focus_x: z.number().describe('Horizontal position of the main subject, 0 = left, 0.5 = centre, 1 = right. Used to crop landscape footage to 9:16'),
  transition: z.string().describe('Transition INTO THE NEXT shot. One of: cut, fade, dissolve, fadeblack, flash, slide, slideup, whip, zoom, wipe, circle, blur'),
  effect: z.string().describe('Camera move on this shot. One of: none, zoom_in (slow push-in), zoom_out (slow pull-out), punch (instant punch-in on a beat)'),
  layout: z.string().describe('"full" normally. "split" = before/after split screen: this shot (AFTER) on the bottom half, compare_video/compare_start (BEFORE) on top'),
  compare_video: z.number().describe('For layout "split" only: 1-based video number of the BEFORE shot; otherwise 0'),
  compare_start: z.number().describe('For layout "split" only: start time of the BEFORE shot; otherwise 0'),
  why: z.string().describe('One short sentence on why this shot is here'),
});

const ClipSchema = z.object({
  title: z.string().describe('Short name for the clip'),
  style: z.string().describe(`One of: ${Object.keys(STYLES).join(', ')}`),
  angle: z.string().describe('The content angle, e.g. "Transformation reveal", "Satisfying process", "Behind the scenes", "Offer", "Expert tip", "POV customer"'),
  target_viewer: z.string().describe('Who this clip is for and what they want, one sentence'),
  why_it_works: z.string().describe('Why this clip should get attention for THIS business, one or two sentences'),
  music_mood: z.string().describe('One of: energetic, chill, build'),
  concept: z.string().describe('One sentence describing the clip'),
  hook_text: z.string().describe('On-screen hook for the first 2–3 seconds: max 7 words, no emoji, specific to this business and footage'),
  hook_reason: z.string(),
  segments: z.array(SegmentSchema).describe('Shots in playback order'),
  cta_text: z.string().describe('On-screen call to action for the last 2–3 seconds: max 6 words, no emoji, specific (book / call / DM / visit + name or suburb when known)'),
  pacing_notes: z.string(),
  post_caption: z.string().describe('Ready-to-post caption for this clip, may include emoji'),
  hashtags: z.array(z.string()),
});

const PlanClipSchema = ClipSchema.extend({
  music_track: z.string().describe('Exact name of the song from the MUSIC LIBRARY that best fits this clip, or "auto" if no library is given'),
});

const PlanSchema = z.object({
  strategy: z.string().describe('2–4 sentences: what will make THIS business stand out on short-form video, who to target, and how the clips split the work between them'),
  summary: z.string().describe('2–3 sentences: what the footage contains and the editing approach'),
  footage_review: z.array(z.object({
    video: z.number().describe('1-based video number'),
    start: z.number(),
    end: z.number(),
    description: z.string(),
    quality: z.string().describe('One of: strong, usable, weak'),
  })).describe('Notable moments across all videos, in time order'),
  clips: z.array(PlanClipSchema),
  cut_sections: z.array(z.object({
    video: z.number().describe('1-based video number'),
    start: z.number(),
    end: z.number(),
    reason: z.string(),
  })).describe('Sections deliberately left out (dead time, shaky, dark, repetitive)'),
  reshoot_tips: z.array(z.string()).describe('Practical tips for filming better footage next time at this business'),
});

const PLAYBOOK = `What makes short-form videos for local businesses perform:
- The first second decides everything: open on the most visually striking moment with an on-screen hook that creates curiosity or promises a payoff ("Wait for the reveal", "3 years without a wash").
- Open a loop early (tease the result) and close it at the end with the payoff; it keeps people watching.
- Change something every 1.5–3 seconds (a cut, a zoom, new text) to hold attention.
- Most people watch with the sound off: the story must work from visuals and text alone.
- Specific beats generic: name the service, the suburb, a number, the actual dish or car. Never write vague filler like "Quality service".
- Give each clip a different angle that pulls a different viewer: satisfaction/curiosity (transformation reveal), trust (expert process, attention to detail), desire (the food money shot, the gloss), urgency (an offer), relatability (POV, day in the life), education (a tip or a myth busted).
- End with a clear, specific call to action that fits the business (book, call, DM, visit, link in bio), using the business name or suburb when known.
- For Shorts, an ending that flows back into the start encourages replays.`;

const digit = (v, scale) => (v === null || v === undefined ? '-' : String(Math.max(0, Math.min(9, Math.round(v * scale)))));

function describeSignals(s) {
  const motion = s.motion.map((m) => digit(m, 0.5)).join('');
  const loud = s.loudness.some((v) => v !== null) ? s.loudness.map((db) => (db === null ? '-' : digit((db + 60) / 6, 1))).join('') : null;
  const dark = s.brightness.map((b, i) => (b !== null && b < 45 ? i : null)).filter((i) => i !== null);
  const lines = [`  Motion per second (0 = still, 9 = very busy): ${motion}`];
  if (loud) lines.push(`  Audio level per second (0 = silent, 9 = loud): ${loud}`);
  if (s.cuts.length) lines.push(`  Hard camera cuts at: ${s.cuts.join('s, ')}s`);
  if (dark.length) lines.push(`  Very dark seconds: ${dark.join(', ')}`);
  return lines.join('\n');
}

const fmt = (t) => `${Number(t).toFixed(1)}s`;

const fmtLen = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const libraryList = (tracks) => tracks.map((t) => `- "${t.name}": ${t.mood === 'build' ? 'build-up' : t.mood}, ${Math.round(t.bpm)} BPM, ${fmtLen(t.duration)}`).join('\n');

function businessBlock(business, profile) {
  const p = profile || {};
  const lines = [
    `BUSINESS TYPE: ${business.label}`,
    p.name ? `Name: ${p.name}` : null,
    p.services ? `What they sell: ${p.services}` : null,
    p.location ? `Location: ${p.location}` : null,
    p.offer ? `Current offer: ${p.offer}` : null,
    p.audience ? `Their customers: ${p.audience}` : null,
    p.contact ? `Contact / where to book: ${p.contact}` : null,
    p.review ? `A real customer review: "${p.review}"` : null,
    p.notes ? `Notes: ${p.notes}` : null,
    '',
    'What usually performs for this industry (priority order):',
    ...business.priorities.map((x) => `- ${x}`),
    `Avoid: ${business.avoid.join('; ')}`,
    `Pacing: ${business.pacing}`,
    `Proven structure: ${business.structure}`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

const styleBriefs = () => Object.values(STYLES).map((s) => `- "${s.id}" (${s.label}): ${s.brief}`).join('\n');

async function footageContent(videos) {
  const content = [];
  for (const [i, v] of videos.entries()) {
    const m = v.meta;
    let text = `\n=== VIDEO ${i + 1}: "${v.name}", ${fmt(m.duration)}, ${m.width}x${m.height} ${m.orientation}${m.hasAudio ? '' : ', no audio'} ===\n${describeSignals(v.signals)}`;
    if (v.transcript?.text) {
      const segs = (v.transcript.segments || []).map((s) => `  [${fmt(s.start)}–${fmt(s.end)}] ${s.text.trim()}`).join('\n');
      text += `\n  Speech transcript:\n${segs || '  ' + v.transcript.text}`;
    }
    text += '\n  Sampled frames:';
    content.push({ type: 'text', text });
    for (const f of v.frames) {
      const data = (await fs.readFile(f.path)).toString('base64');
      content.push({ type: 'text', text: `Video ${i + 1} @ ${fmt(f.t)}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
    }
  }
  return content;
}

function editorSystem(platform, hasMusic) {
  return `You are the creative director and editor for a creator who makes ${platform.label} content for local businesses. You decide which clips will get the most attention for each specific business, then write precise edit decision lists that an automated FFmpeg pipeline renders exactly as written.

${PLAYBOOK}

Rules for the edit:
- Only use moments you can actually see in the frames or infer from the motion/audio signals. Never invent footage.
- Timestamps are seconds of the SOURCE video and must stay inside that video's duration.
- Frames are sampled every few seconds; place shot boundaries around the sampled moments, starting slightly before an action frame.
- Cut dead time: setup, walking around, shaky or dark footage, repetitive passes, long pauses.
- Each clip's playback length (sum of (end-start)/speed) should be close to its target and never above ${platform.maxSeconds}s. The pipeline fine-tunes the exact length.
- On-screen text is short, punchy, readable in under a second and has no emoji (the renderer cannot draw them). Captions are max 6 words.
- Use transitions and camera moves deliberately: hard cuts keep energy, flash/zoom/whip hit big moments, fades and dissolves calm things down. Not a fancy transition on every cut.
${hasMusic ? '- Music is added automatically and every cut is snapped to its beat, so think in rhythm: short punchy shots for energetic styles, longer shots for calm ones.' : '- There is no music library yet, so clips keep their original sound.'}

Styles the pipeline can render:
${styleBriefs()}`;
}

// ---------------------------------------------------------------------------
// Footage → edit plan
// ---------------------------------------------------------------------------

/**
 * @param {object} p
 *   videos: [{ name, meta, signals, frames: [{ t, path }], transcript? }]
 *   business, profile, platform, instructions, clipCount, targetSeconds
 *   styles: assigned style per clip, or null to let Claude choose
 */
export async function planEdit(p) {
  const { videos, business, profile, platform, instructions, clipCount, targetSeconds, styles, hasMusic, tracks = [] } = p;
  const styleRule = styles
    ? `Use these styles: ${styles.map((id, i) => `clip ${i + 1} = "${id}"`).join(', ')}.`
    : `Choose the best style for each clip for this business and footage. Every clip must use a different style and a different angle.`;

  const content = [{
    type: 'text',
    text: `${businessBlock(business, profile)}

PLATFORM: ${platform.label}, sweet spot ${platform.sweetSpot}. ${platform.notes}
DELIVERABLE: ${clipCount} clip${clipCount > 1 ? 's' : ''}, each about ${targetSeconds} seconds, portrait 9:16.
${styleRule}
${tracks.length ? `
MUSIC LIBRARY (pick one song per clip by its exact name; the mood label was set by the creator, so trust it; the tempo and the song name hint at the vibe. Match the song to the clip's style and energy and to what suits this business. Use a different song for each clip when there are enough):
${libraryList(tracks)}
` : ''}${instructions ? `\nINSTRUCTIONS FROM THE CREATOR (follow these closely):\n${instructions}\n` : ''}
First work out the strategy: what about this business and this footage will make people stop scrolling, and which ${clipCount > 1 ? `${clipCount} different angles` : 'angle'} will pull the most attention and customers. Then design the clip${clipCount > 1 ? 's' : ''}.

The raw footage follows: ${videos.length} video${videos.length > 1 ? 's' : ''}.`,
  }];
  content.push(...(await footageContent(videos)));
  content.push({ type: 'text', text: `Now write the strategy and exactly ${clipCount} clip${clipCount > 1 ? 's' : ''}.` });

  return structuredCall({ system: editorSystem(platform, hasMusic), content, schema: PlanSchema, effort: 'high' });
}

// ---------------------------------------------------------------------------
// "Ask for changes": revise existing clips from a plain-English request
// ---------------------------------------------------------------------------

const RevisionSchema = z.object({
  reply: z.string().describe('One or two sentences to the creator saying exactly what you changed (or why something is not possible)'),
  clips: z.array(ClipSchema.extend({
    clip_number: z.number().describe('1-based number of the existing clip this is'),
    changed: z.boolean().describe('true if anything about this clip changed'),
    target_seconds: z.number().describe('Length this clip should be, in seconds'),
    music_track: z.string().describe('"keep" to keep the current music, "none" for no music, or the exact name of a track from the library'),
  })).describe('Every existing clip, in order, revised or unchanged'),
});

const toOneBased = (seg) => {
  const out = { ...seg, video: seg.video + 1 };
  if (seg.layout === 'split') out.compare_video = seg.compare_video + 1;
  return out;
};

export async function reviseEdit(p) {
  const { videos, business, profile, platform, plan, request, clipNumber, tracks, hasMusic } = p;
  const current = plan.clips.map((c, i) => ({
    clip_number: i + 1,
    title: c.title,
    style: c.style,
    angle: c.angle || '',
    hook_text: c.hook_text,
    cta_text: c.cta_text,
    music: c.music ? c.music.name : 'none',
    length_seconds: c.estDuration,
    segments: c.segments.map((s) => {
      const o = toOneBased(s);
      return { video: o.video, start: o.start, end: o.end, role: o.role, caption: o.caption, speed: o.speed, focus_x: o.focus_x, transition: o.transition, effect: o.effect, layout: o.layout, compare_video: o.compare_video || 0, compare_start: o.compare_start || 0 };
    }),
  }));

  const content = [{
    type: 'text',
    text: `${businessBlock(business, profile)}

PLATFORM: ${platform.label} (max ${platform.maxSeconds}s).
${plan.strategy ? `STRATEGY SO FAR: ${plan.strategy}\n` : ''}
MUSIC LIBRARY:
${tracks.length ? libraryList(tracks) : 'empty'}

THE CURRENT CLIPS (video numbers are 1-based):
${JSON.stringify(current, null, 1)}

THE CREATOR'S REQUEST${clipNumber ? ` (about clip ${clipNumber})` : ''}:
"${request}"

Apply the request:
- ${clipNumber ? `Change only clip ${clipNumber}.` : 'If the request names clips, change those; otherwise apply it to every clip.'}
- Make the change clearly visible in the finished video. A tweak the creator would not notice does not count.
- Set changed=true on every clip you modify. Return every clip in order; clips you leave alone come back exactly as given with changed=false.
- Keep everything the creator did not ask to change, including the length (target_seconds = the current length_seconds unless asked).
- To use different shots, pick new moments from the footage below (video numbers are 1-based, times are seconds in that video).
- If something is impossible (e.g. footage that does not exist), say so in the reply and do the closest sensible thing.
- The reply says exactly what you changed, in plain words.

The footage follows so you can choose different moments if asked.`,
  }];
  content.push(...(await footageContent(videos)));

  return structuredCall({ system: editorSystem(platform, hasMusic), content, schema: RevisionSchema, effort: 'medium' });
}

// ---------------------------------------------------------------------------
// Ads (motion engine v3): creative director, revisions, frame review
// ---------------------------------------------------------------------------

const SceneSchema = z.object({
  recipe: z.string().describe(`Composition recipe. One of: ${RECIPE_IDS.join(', ')}`),
  purpose: z.string().describe('Why this scene exists and what it does for the ad (one sentence)'),
  duration: z.number().describe('Seconds, 1.5–5'),
  headline: z.string().describe('Main on-screen text, max 7 words, no emoji. Wrap the one word to emphasise in *asterisks*. For "review" the exact real quote; for "offer" the real offer; for "stat" a real number'),
  subline: z.string().describe('Small supporting line, max 9 words, or empty'),
  items: z.array(z.string()).describe('"features": 2–4 benefits (max 5 words each). "process": step labels. "compare": ["Before label", "After label"]. "cta": [button label]. Otherwise empty'),
  main_asset: z.string().describe('Asset id of the main photo for this scene, or empty'),
  other_assets: z.array(z.string()).describe('Extra photo asset ids (gallery, process, compare); else empty'),
  video: z.string().describe('Footage id for a "footage" scene, else empty'),
  video_from: z.number().describe('Start time in the footage (seconds), else 0'),
  camera: z.string().describe(`Camera move: one of ${['push', 'pull', 'pan', 'rise', 'orbit', 'punch', 'still'].join(', ')}, or empty for the default`),
  entrance: z.string().describe('How the subject enters: one of rise, drop, pop, zoom, scaleDown, blur, tilt, spin, slideL, slideR, whip, fade, or empty for the default'),
  text_animation: z.string().describe('How the headline animates: one of words, pop, blurWords, slideWords, lines, chars, or empty for the default'),
  transition: z.string().describe(`Transition INTO this scene: one of ${['push', 'whip', 'zoom', 'blur', 'fade', 'wipe', 'iris', 'brand', 'flash', 'split', 'cut'].join(', ')}, or empty for the default`),
});

const BoardSchema = z.object({
  title: z.string(),
  angle: z.string().describe('The persuasion angle, e.g. "Product showcase", "Offer", "Trust", "Problem → solution", "Local favourite"'),
  objective: z.string().describe(`One of: ${Object.keys(OBJECTIVES).filter((k) => k !== 'auto').join(', ')}`),
  why_it_works: z.string().describe('One or two sentences: why this ad will get attention and customers for THIS business'),
  direction: z.string().describe(`Creative direction. One of: ${DIRECTION_IDS.join(', ')}`),
  brand_colors: z.array(z.string()).describe('1–3 brand colours as #rrggbb taken from the logo or the business photos (most important first); empty if unclear'),
  music_track: z.string().describe('Exact name of a song from the MUSIC LIBRARY, or "auto"'),
  music_mood: z.string().describe('One of: energetic, chill, build'),
  voiceover_script: z.string().describe('A natural spoken script for this ad (about 2.3 words per second of ad), or empty if a voice would not help'),
  scenes: z.array(SceneSchema).describe('Scenes in order. Open with the strongest visual hook; end with a "cta" scene'),
  post_caption: z.string().describe('Ready-to-post caption, may include emoji'),
  hashtags: z.array(z.string()),
});

const BoardsSchema = z.object({
  strategy: z.string().describe('2–3 sentences: what will make this business stand out, and how the ads differ'),
  photo_notes: z.array(z.object({
    asset: z.string(),
    description: z.string().describe('What the photo shows, in a few words'),
    best_use: z.string().describe('hero product, supporting, background, before, after, or avoid'),
  })).describe('One entry per photo'),
  ads: z.array(BoardSchema),
});

const recipeBriefs = () => RECIPE_IDS.map((id) => `- "${id}" (${RECIPES[id].label}; needs ${RECIPES[id].needs}): ${RECIPES[id].brief}`).join('\n');
const directionBriefs = () => DIRECTION_IDS.map((id) => `- "${id}" (${DIRECTIONS[id].label}): ${DIRECTIONS[id].brief}`).join('\n');

function directorSystem() {
  return `You are the creative director of a small studio that makes premium short video ads (motion graphics with real photos and footage) for local businesses. Clients pay for ads that look designed by a professional team and bring in customers. An animation engine renders your storyboard exactly.

${PLAYBOOK}

How to direct:
- The client's PRODUCT is the hero, not the words: use their photos and footage in most scenes. Recipes like product_hero, photo_full, gallery and process put real things on screen; kinetic (text only) is for one punchy beat at most.
- "Cut-out available" photos can float as studio product shots (product_hero); others work full screen or as cards.
- The first 1.5 seconds must stop the scroll: a striking visual plus a short hook. Never open on the logo.
- Every scene needs a purpose (hook, desire, proof, value, offer, action) and the sequence must build to the call to action.
- Vary composition and rhythm: no two neighbouring scenes with the same recipe; mix close product shots with full-frame photos.
- Pick the creative direction that suits THIS brand (and its logo colours), not just the industry. In a batch, make each ad clearly different: different angle, structure, direction.
- Text is minimal: headlines max 7 words, sublines max 9, no emoji, no hashtags on screen.
- NEVER invent facts: no made-up prices, discounts, reviews, star ratings, statistics, awards, years in business, guarantees or claims like "licensed" unless given. Only use offer/review/stat scenes with real information supplied below.
- Never describe a photo as something it is not. If a photo is weak (blurry, dark, unrelated), avoid it.

Composition recipes:
${recipeBriefs()}

Creative directions:
${directionBriefs()}`;
}

async function mediaContent(photos, logo, footage) {
  const content = [];
  for (const p of photos) {
    content.push({ type: 'text', text: `Photo "${p.id}"${p.cut ? ' (cut-out available)' : ''}${p.note ? `: ${p.note}` : ''}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: (await fs.readFile(p.thumb)).toString('base64') } });
  }
  if (logo) {
    content.push({ type: 'text', text: 'The business logo (shown automatically in the corner and on the ending):' });
    content.push({ type: 'image', source: { type: 'base64', media_type: logo.thumb.endsWith('.png') ? 'image/png' : 'image/jpeg', data: (await fs.readFile(logo.thumb)).toString('base64') } });
  }
  for (const v of footage || []) {
    content.push({ type: 'text', text: `Footage "${v.id}" (${v.duration.toFixed(1)}s). Best moment around ${v.bestFrom.toFixed(1)}s:` });
    if (v.thumb) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: (await fs.readFile(v.thumb)).toString('base64') } });
  }
  return content;
}

/**
 * Plan ad storyboards.
 * p: { business, profile, count, seconds, format, direction ('auto'|id), objective, instructions,
 *      photos: [{ id, thumb, cut, note }], logo: { thumb } | null, footage: [{ id, duration, bestFrom, thumb }], tracks, voiceover }
 */
export async function planAdBoards(p) {
  const { business, profile, count, seconds, format, direction, objective, instructions, photos, logo, footage, tracks, voiceover } = p;
  const content = [{
    type: 'text',
    text: `${businessBlock(business, profile)}

DELIVERABLE: ${count} ad${count > 1 ? 's' : ''}, each ${seconds} seconds (scene durations add up to that), format ${format}.
OBJECTIVE: ${objective === 'auto' ? 'choose the best objective for each ad' : OBJECTIVES[objective]}.
${direction !== 'auto' ? `Use the "${direction}" creative direction for every ad.` : 'Choose the creative direction per ad.'}
MEDIA: ${photos.length} photo(s)${footage.length ? `, ${footage.length} video clip(s)` : ''}${logo ? ', a logo' : ', no logo'}. Asset ids are in quotes below; use them exactly.
${tracks.length ? `\nMUSIC LIBRARY (pick one song per ad by exact name; use different songs across ads when possible):\n${libraryList(tracks)}\n` : ''}${voiceover ? '\nThe creator wants a VOICEOVER: write voiceover_script for each ad.\n' : '\nNo voiceover: leave voiceover_script empty.\n'}${instructions ? `\nINSTRUCTIONS FROM THE CREATOR (follow these closely):\n${instructions}\n` : ''}
First look at every photo and note what it shows. Then decide what will make people stop scrolling and act for THIS business, and direct ${count > 1 ? `${count} clearly different ads` : 'the ad'}.`,
  }];
  content.push(...(await mediaContent(photos, logo, footage)));
  return structuredCall({ system: directorSystem(), content, schema: BoardsSchema, effort: 'high' });
}

const BoardRevisionSchema = z.object({
  reply: z.string().describe('One or two sentences to the creator saying exactly what you changed (or why something is not possible)'),
  ads: z.array(BoardSchema.extend({
    ad_number: z.number(),
    changed: z.boolean().describe('true if anything about this ad changed'),
  })).describe('Every existing ad, in order'),
});

/** Revise existing storyboards from a plain-English request (optionally one ad / one scene). */
export async function reviseAdBoards(p) {
  const { business, profile, boards, request, adNumber, sceneNumber, photos, logo, footage, tracks, format } = p;
  const current = boards.map((b, i) => ({ ad_number: i + 1, ...boardForAi(b) }));
  const content = [{
    type: 'text',
    text: `${businessBlock(business, profile)}

FORMAT: ${format}. MUSIC LIBRARY:
${tracks.length ? libraryList(tracks) : 'empty'}
(music_track: "keep" keeps the current song.)

THE CURRENT ADS:
${JSON.stringify(current, null, 1)}

THE CREATOR'S REQUEST${adNumber ? ` (about ad ${adNumber}${sceneNumber ? `, scene ${sceneNumber}` : ''})` : ''}:
"${request}"

Apply the request:
- ${adNumber ? `Change only ad ${adNumber}${sceneNumber ? `, and within it only scene ${sceneNumber} unless the request clearly needs more` : ''}.` : 'If the request names ads, change those; otherwise apply it to every ad.'}
- Make the change clearly visible. Keep everything the creator did not ask to change, including scene order, timing and assets.
- Set changed=true on every ad you modify; return the others exactly as given with changed=false.
- The reply says exactly what you changed.`,
  }];
  content.push(...(await mediaContent(photos, logo, footage)));
  return structuredCall({ system: directorSystem(), content, schema: BoardRevisionSchema, effort: 'medium' });
}

export function boardForAi(b) {
  return {
    title: b.title, angle: b.angle, objective: b.objective, why_it_works: b.why, direction: b.direction, brand_colors: b.brandColors,
    music_track: b.music?.name || 'auto', music_mood: b.musicMood, voiceover_script: b.voiceover || '',
    scenes: b.scenes.map((s) => ({
      recipe: s.recipe, purpose: s.purpose || '', duration: s.duration, headline: s.headline, subline: s.subline, items: s.items,
      main_asset: s.main || '', other_assets: s.alt || [], video: s.video || '', video_from: s.from || 0,
      camera: s.camera || '', entrance: s.entrance || '', text_animation: s.textAnim || '', transition: s.transition || '',
    })),
    post_caption: b.postCaption, hashtags: b.hashtags,
  };
}

const ReviewSchema = z.object({
  verdict: z.string().describe('"ready" if a client would be happy, otherwise "fix"'),
  summary: z.string().describe('One sentence on overall quality'),
  scenes: z.array(z.object({
    scene: z.number().describe('1-based scene number'),
    ok: z.boolean(),
    problem: z.string().describe('What looks wrong (layout, readability, weak or wrong photo, repetitive, off-brand, text too long), or empty'),
    fix_headline: z.string().describe('Better headline if the text is the problem, else empty'),
    fix_recipe: z.string().describe(`A better recipe if the composition is the problem (${RECIPE_IDS.join(', ')}), else empty`),
    fix_asset: z.string().describe('A better photo asset id if the photo is the problem, else empty'),
  })),
});

/** Claude looks at one still per scene (a contact sheet) and flags weak scenes with concrete fixes. */
export async function reviewAdFrames({ business, profile, board, frames, photos }) {
  const content = [{
    type: 'text',
    text: `${businessBlock(business, profile)}

You are reviewing a draft ad before it goes to a paying client. Below is one still frame per scene (taken late in each scene, after animations settle), plus the storyboard. Judge it like a senior designer: hierarchy, readability, composition, whether the product is the hero, colour, variety, and whether each scene earns its place. Be strict but practical: only flag real problems, and give concrete fixes using the available photo ids: ${photos.map((p) => `"${p.id}"`).join(', ') || 'none'}.

STORYBOARD:
${JSON.stringify(boardForAi(board).scenes.map((s, i) => ({ scene: i + 1, recipe: s.recipe, headline: s.headline, main_asset: s.main_asset })), null, 1)}`,
  }];
  for (const f of frames) {
    content.push({ type: 'text', text: `Scene ${f.scene}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: (await fs.readFile(f.path)).toString('base64') } });
  }
  return structuredCall({ system: directorSystem(), content, schema: ReviewSchema, effort: 'medium', maxTokens: 8000 });
}
