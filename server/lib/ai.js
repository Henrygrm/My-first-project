import fs from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { STYLES } from './styles.js';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
// Server-side refusal fallback: if the model declines, the API re-runs the
// request on Anthropic's recommended fallback model. Set CLAUDE_FALLBACKS=off to disable.
const USE_FALLBACKS = (process.env.CLAUDE_FALLBACKS || 'on') !== 'off';

export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SETUP_REQUIRED';
  }
}

export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client;
function getClient() {
  if (!aiConfigured()) {
    throw new SetupError('Claude is not configured. Add ANTHROPIC_API_KEY to your .env file and restart the server.');
  }
  client ??= new Anthropic();
  return client;
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new SetupError('Your ANTHROPIC_API_KEY was rejected. Check the key in .env and restart the server.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error(`Your API key does not have access to ${MODEL}. Set CLAUDE_MODEL in .env to a model your account can use.`);
  if (err instanceof Anthropic.NotFoundError) return new Error(`Model "${MODEL}" was not found. Check CLAUDE_MODEL in .env.`);
  if (err instanceof Anthropic.RateLimitError) return new Error('Claude rate limit reached. Wait a minute and try again.');
  if (err instanceof Anthropic.BadRequestError) return new Error(`Claude rejected the request: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Claude API. Check your internet connection.');
  if (err instanceof Anthropic.APIError) return new Error(`Claude API error (${err.status ?? 'unknown'}): ${err.message}`);
  return err;
}

async function structuredCall({ system, content, schema, effort = 'medium', maxTokens = 32000 }) {
  const anthropic = getClient();
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
  };
  if (USE_FALLBACKS) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let message;
  try {
    message = await anthropic.beta.messages.stream(params).finalMessage();
  } catch (err) {
    // Older accounts/proxies may not accept the fallback beta; retry plainly.
    if (USE_FALLBACKS && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
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

  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined this request. Try rephrasing your instructions.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Claude ran out of output space before finishing. Try fewer videos or clips.');
  }
  if (!message.parsed_output) {
    throw new Error('Claude returned a response that did not match the expected format. Please try again.');
  }
  return { data: message.parsed_output, usage: message.usage, model: message.model };
}

// ---------------------------------------------------------------------------
// Footage → edit plan
// ---------------------------------------------------------------------------

const SegmentSchema = z.object({
  video: z.number().describe('1-based video number this segment is taken from'),
  start: z.number().describe('Start time in the SOURCE video, seconds'),
  end: z.number().describe('End time in the SOURCE video, seconds'),
  role: z.string().describe('One of: hook, setup, process, reveal, payoff, cta'),
  caption: z.string().describe('On-screen text shown during this segment: max 6 words, no emoji, or empty string for none'),
  speed: z.number().describe('Playback speed between 0.5 and 2. Use 1 normally; 1.5–2 to compress repetitive work; 0.5–0.8 for a slow-motion money shot'),
  focus_x: z.number().describe('Horizontal position of the main subject in the frame, 0 = left edge, 0.5 = centre, 1 = right edge. Used to crop landscape footage to 9:16'),
  transition: z.string().describe('Transition INTO THE NEXT segment. One of: cut, fade, dissolve, fadeblack, flash, slide, slideup, whip, zoom, wipe, circle, blur. Ignored on the last segment'),
  effect: z.string().describe('Camera move on this shot. One of: none, zoom_in (slow push-in), zoom_out (slow pull-out), punch (instant punch-in, great on a beat)'),
  layout: z.string().describe('"full" normally. "split" = before/after split screen: this segment (the AFTER) on the bottom half and compare_video/compare_start (the BEFORE) on the top half'),
  compare_video: z.number().describe('For layout "split" only: 1-based video number of the BEFORE shot; otherwise 0'),
  compare_start: z.number().describe('For layout "split" only: start time of the BEFORE shot in that video; otherwise 0'),
  why: z.string().describe('One short sentence on why this moment was chosen'),
});

const ClipSchema = z.object({
  title: z.string().describe('Short internal name for the clip'),
  style: z.string().describe('The style id assigned to this clip'),
  music_mood: z.string().describe('Music for this clip. One of: energetic, chill, build'),
  concept: z.string().describe('One sentence describing the angle of this clip'),
  hook_text: z.string().describe('Bold on-screen hook for the first 2–3 seconds: max 7 words, no emoji'),
  hook_reason: z.string(),
  segments: z.array(SegmentSchema).describe('Segments in playback order'),
  cta_text: z.string().describe('On-screen call to action for the last 2–3 seconds: max 6 words, no emoji'),
  pacing_notes: z.string(),
  music_suggestion: z.string().describe('Style/tempo of trending audio to add in-app (do not name copyrighted tracks as requirements)'),
  post_caption: z.string().describe('Ready-to-post caption for this clip, may include emoji'),
  hashtags: z.array(z.string()),
});

const PlanSchema = z.object({
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
  reshoot_tips: z.array(z.string()).describe('Practical tips for filming better footage next time at this kind of business'),
});

const digit = (v, scale) => (v === null || v === undefined ? '-' : String(Math.max(0, Math.min(9, Math.round(v * scale)))));

function describeSignals(s) {
  const motion = s.motion.map((m) => digit(m, 60)).join('');
  const loud = s.loudness.some((v) => v !== null) ? s.loudness.map((db) => (db === null ? '-' : digit((db + 60) / 6, 1))).join('') : null;
  const dark = s.brightness.map((b, i) => (b !== null && b < 45 ? i : null)).filter((i) => i !== null);
  const lines = [`  Motion per second (0 = still, 9 = very busy): ${motion}`];
  if (loud) lines.push(`  Audio level per second (0 = silent, 9 = loud): ${loud}`);
  if (s.cuts.length) lines.push(`  Hard camera cuts at: ${s.cuts.join('s, ')}s`);
  if (dark.length) lines.push(`  Very dark seconds: ${dark.join(', ')}`);
  return lines.join('\n');
}

const fmt = (t) => `${Number(t).toFixed(1)}s`;

/**
 * @param {object} p
 *   videos: [{ name, meta, signals, frames: [{ t, path }], transcript? }]
 *   business, platform: profile objects; instructions: string
 *   clipCount, targetSeconds
 */
export async function planEdit(p) {
  const { videos, business, platform, instructions, clipCount, targetSeconds, styles, hasMusic } = p;
  const styleBriefs = [...new Set(styles)].map((id) => `- "${id}" (${STYLES[id].label}): ${STYLES[id].brief}`).join('\n');
  const assignment = styles.map((id, i) => `Clip ${i + 1}: style "${id}"`).join('\n');

  const system = `You are a senior short-form video editor who makes high-performing ${platform.label} content for local businesses. You review raw phone footage and produce precise, practical edit decision lists that an automated FFmpeg pipeline renders exactly as you specify.

Rules for the edit:
- Only use moments you can actually see in the provided frames or infer from the motion/audio signals. Never invent footage.
- Timestamps are in seconds of the SOURCE video. Every segment must stay inside that video's duration.
- Frames are sampled every few seconds, so choose segment boundaries around the sampled moments; prefer starting a segment slightly before a sampled action frame.
- The first segment is the hook: the single most scroll-stopping moment. It must work with the sound off.
- Remove dead time: setup, walking around, shaky or dark footage, repetitive passes, long pauses.
- Keep each clip's total playback length (sum of (end-start)/speed) close to the target and never above ${platform.maxSeconds}s.
- Different clips should use different angles or moments where the footage allows.
- On-screen text must be short, punchy, readable in under a second, and free of emoji (the renderer cannot draw them).
- Captions sit in the upper part of the frame; keep them under 6 words.
- Make each clip feel different: its own style, hook angle, shot order and transitions. Avoid generic, interchangeable edits.
- Choose transitions and camera moves deliberately for the style: hard cuts keep energy, flashes/zooms/whips hit big moments, fades and dissolves calm things down. Do not put a fancy transition on every cut.
${hasMusic ? '- Music will be added and every cut will be snapped to its beat automatically, so think in rhythm: short punchy shots for energetic styles, longer shots for calm ones.' : '- No music library is set up, so the clips keep their original sound.'}`;

  const content = [];
  content.push({
    type: 'text',
    text: `BUSINESS TYPE: ${business.label}
What performs best for this industry (in priority order):
${business.priorities.map((x) => `- ${x}`).join('\n')}
Avoid: ${business.avoid.join('; ')}
Pacing: ${business.pacing}
Proven structure: ${business.structure}

PLATFORM: ${platform.label} — sweet spot ${platform.sweetSpot}. ${platform.notes}
DELIVERABLE: ${clipCount} clip${clipCount > 1 ? 's' : ''}, each about ${targetSeconds} seconds, portrait 9:16.

STYLES TO USE:
${styleBriefs}

${assignment}
${instructions ? `\nINSTRUCTIONS FROM THE CREATOR (follow these closely):\n${instructions}\n` : ''}
The raw footage follows. ${videos.length} video${videos.length > 1 ? 's' : ''} in total.`,
  });

  for (const [i, v] of videos.entries()) {
    const m = v.meta;
    let text = `\n=== VIDEO ${i + 1}: "${v.name}" — duration ${fmt(m.duration)}, ${m.width}x${m.height} ${m.orientation}${m.hasAudio ? '' : ', no audio'} ===\n${describeSignals(v.signals)}`;
    if (v.transcript?.text) {
      const segs = (v.transcript.segments || []).map((s) => `  [${fmt(s.start)}–${fmt(s.end)}] ${s.text.trim()}`).join('\n');
      text += `\n  Speech transcript:\n${segs || '  ' + v.transcript.text}`;
    }
    text += `\n  Sampled frames:`;
    content.push({ type: 'text', text });
    for (const f of v.frames) {
      const data = (await fs.readFile(f.path)).toString('base64');
      content.push({ type: 'text', text: `Video ${i + 1} @ ${fmt(f.t)}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
    }
  }

  content.push({
    type: 'text',
    text: `Now produce the edit plan: review the footage, then design exactly ${clipCount} clip${clipCount > 1 ? 's' : ''} for ${business.label} on ${platform.label}.`,
  });

  return structuredCall({ system, content, schema: PlanSchema, effort: 'high' });
}

// ---------------------------------------------------------------------------
// Marketing content
// ---------------------------------------------------------------------------

export const MARKETING_SECTIONS = {
  captions: z.array(z.object({
    style: z.string().describe('e.g. Story, Short & punchy, Educational, Offer'),
    text: z.string().describe('Complete caption ready to paste, with line breaks and emoji where natural'),
  })).describe('5 social media captions in different styles'),
  hooks: z.array(z.string()).describe('8 opening hooks for videos (spoken or on-screen), each under 12 words'),
  hashtags: z.object({
    broad: z.array(z.string()),
    niche: z.array(z.string()),
    local: z.array(z.string()),
  }).describe('Hashtags without spaces, each starting with #: ~6 broad, ~8 niche/industry, ~6 local/location-based'),
  video_concepts: z.array(z.object({
    title: z.string(),
    hook: z.string(),
    description: z.string(),
    shot_list: z.array(z.string()).describe('4–6 specific shots to film'),
  })).describe('4 video concepts the business can film'),
  seven_day_plan: z.array(z.object({
    day: z.string().describe('Day 1 … Day 7'),
    theme: z.string(),
    format: z.string().describe('e.g. Reel, Carousel, Story, TikTok'),
    idea: z.string(),
    caption_starter: z.string(),
  })).describe('Exactly 7 entries, one per day'),
  promotions: z.array(z.object({
    title: z.string(),
    offer: z.string(),
    post_copy: z.string(),
  })).describe('3 promotional post ideas'),
  engagement_tips: z.array(z.string()).describe('6 specific, practical tips to improve engagement for this business'),
  ctas: z.array(z.string()).describe('6 calls to action tailored to the business'),
};

export const SECTION_LABELS = {
  captions: 'Captions',
  hooks: 'Video hooks',
  hashtags: 'Hashtags',
  video_concepts: 'Video concepts',
  seven_day_plan: '7-day content plan',
  promotions: 'Promotional posts',
  engagement_tips: 'Engagement tips',
  ctas: 'Calls to action',
};

export async function generateMarketing({ profile, business, section, previous, footageContext }) {
  const keys = section ? [section] : Object.keys(MARKETING_SECTIONS);
  const schema = z.object(Object.fromEntries(keys.map((k) => [k, MARKETING_SECTIONS[k]])));

  const system = `You are a social media strategist who writes for local, owner-operated businesses. You write like a real person from that business would: specific, local, warm and confident, never corporate or generic. You avoid clichés such as "elevate", "unleash", "game-changer", "look no further" and "in today's fast-paced world". Everything you write must be specific to the business details provided and ready to post without editing.`;

  const lines = [
    `Business name: ${profile.name || '(not given — write without the name)'}`,
    `Business type: ${business.label}`,
    `Location: ${profile.location || '(not given)'}`,
    `Services / products: ${profile.services || '(not given)'}`,
    `Target audience: ${profile.audience || '(not given)'}`,
    `Tone of voice: ${profile.tone || 'Friendly and confident'}`,
  ];
  if (profile.extra) lines.push(`Extra notes: ${profile.extra}`);

  let text = `Create social media marketing content for this business.\n\n${lines.join('\n')}\n\nWhat tends to perform for this industry: ${business.priorities.join('; ')}.\nDefault call to action for the industry: "${business.cta}".`;
  if (footageContext) {
    text += `\n\nThe creator has already edited these videos from real footage; tie captions and ideas to them where useful:\n${footageContext}`;
  }
  if (section) {
    text += `\n\nOnly produce the "${SECTION_LABELS[section]}" section.`;
    if (previous) {
      text += ` Write fresh alternatives that are clearly different from this previous version:\n${JSON.stringify(previous).slice(0, 6000)}`;
    }
  }

  return structuredCall({ system, content: [{ type: 'text', text }], schema, effort: 'medium', maxTokens: 24000 });
}
