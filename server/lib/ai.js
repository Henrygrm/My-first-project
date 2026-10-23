import fs from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
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
  clips: z.array(ClipSchema),
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

function businessBlock(business, profile) {
  const p = profile || {};
  const lines = [
    `BUSINESS TYPE: ${business.label}`,
    p.name ? `Name: ${p.name}` : null,
    p.services ? `What they sell: ${p.services}` : null,
    p.location ? `Location: ${p.location}` : null,
    p.offer ? `Current offer: ${p.offer}` : null,
    p.audience ? `Their customers: ${p.audience}` : null,
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
  const { videos, business, profile, platform, instructions, clipCount, targetSeconds, styles, hasMusic } = p;
  const styleRule = styles
    ? `Use these styles: ${styles.map((id, i) => `clip ${i + 1} = "${id}"`).join(', ')}.`
    : `Choose the best style for each clip for this business and footage. Every clip must use a different style and a different angle.`;

  const content = [{
    type: 'text',
    text: `${businessBlock(business, profile)}

PLATFORM: ${platform.label}, sweet spot ${platform.sweetSpot}. ${platform.notes}
DELIVERABLE: ${clipCount} clip${clipCount > 1 ? 's' : ''}, each about ${targetSeconds} seconds, portrait 9:16.
${styleRule}
${instructions ? `\nINSTRUCTIONS FROM THE CREATOR (follow these closely):\n${instructions}\n` : ''}
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
MUSIC LIBRARY: ${tracks.length ? tracks.map((t) => `"${t.name}" (${t.mood}, ${Math.round(t.bpm)} BPM)`).join('; ') : 'empty'}

THE CURRENT CLIPS (video numbers are 1-based):
${JSON.stringify(current, null, 1)}

THE CREATOR'S REQUEST${clipNumber ? ` (about clip ${clipNumber})` : ''}:
"${request}"

Apply the request. Return every clip in order. Clips the request does not affect must come back unchanged with changed=false. Keep anything the creator did not ask to change. If the request needs footage that does not exist, say so in the reply and do the closest sensible thing.

The footage follows so you can choose different moments if asked.`,
  }];
  content.push(...(await footageContent(videos)));

  return structuredCall({ system: editorSystem(platform, hasMusic), content, schema: RevisionSchema, effort: 'medium' });
}
