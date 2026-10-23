// Understands common change requests ("make clip 2 15 seconds", "no music",
// "hook: Wait for it", "use the lofi song", "make it a promo") without the AI,
// so the change bar is useful even with no Claude key. Anything it can't
// understand is reported back honestly rather than guessed.
import { STYLES } from './styles.js';

const ORDINALS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };

const STYLE_WORDS = [
  [/\b(before\s*(and|&|n)\s*after|transformation|split\s*screen)\b/, 'transformation'],
  [/\b(montage|beat edit|fast cuts?)\b/, 'montage'],
  [/\b(satisfying|asmr|calm|chill(ed)? (edit|vibe|style))\b/, 'satisfying'],
  [/\b(story|day in the life|behind the scenes)\b/, 'story'],
  [/\b(top\s*3|top three|list(icle)?|numbered)\b/, 'listicle'],
  [/\b(promo|advert|ad|offer|sale)\b/, 'promo'],
];

function quoted(text, keyword) {
  const re = new RegExp(`${keyword}\\s*(?:text)?\\s*(?:to|:|=|says?|should say|as)?\\s*["“'‘](.+?)["”'’]`, 'i');
  const m = text.match(re);
  if (m) return m[1].trim();
  const loose = text.match(new RegExp(`${keyword}\\s*(?:text)?\\s*(?:to|:|=)\\s*(.+)$`, 'i'));
  return loose ? loose[1].trim().replace(/[.!]+$/, '') : null;
}

/**
 * @returns {{ understood: boolean, reply: string, clipIndexes: number[],
 *             patch: object, musicTrack?: string|null, musicLevel?: string,
 *             audio?: string, regenerate?: boolean }}
 */
export function parseRequest(text, plan, tracks) {
  const t = ` ${String(text).toLowerCase()} `;
  const n = plan.clips.length;
  const did = [];
  const patch = {};
  const out = { understood: false, reply: '', clipIndexes: [], patch };

  // Which clips?
  let idx = [];
  for (const m of t.matchAll(/\bclips?\s*(?:#|number\s*)?(\d)\b/g)) idx.push(Number(m[1]) - 1);
  for (const [w, v] of Object.entries(ORDINALS)) if (new RegExp(`\\b${w}\\s+(clip|one|video)`).test(t)) idx.push(v - 1);
  if (/\b(last|final)\s+(clip|one|video)\b/.test(t)) idx.push(n - 1);
  idx = [...new Set(idx)].filter((i) => i >= 0 && i < n);
  out.clipIndexes = idx.length ? idx : plan.clips.map((_, i) => i);
  const which = idx.length ? `clip ${idx.map((i) => i + 1).join(' and ')}` : n > 1 ? 'all clips' : 'the clip';

  // Length
  const secs = t.match(/\b(\d{1,2})\s*(?:s|sec|secs|seconds?)\b/);
  if (secs) {
    patch.targetSeconds = Number(secs[1]);
    did.push(`set ${which} to ${patch.targetSeconds} seconds`);
  } else if (/\b(shorter|cut it down|too long)\b/.test(t)) {
    patch.targetDelta = -5;
    did.push(`made ${which} about 5 seconds shorter`);
  } else if (/\b(longer|too short|extend)\b/.test(t)) {
    patch.targetDelta = 10;
    did.push(`made ${which} about 10 seconds longer`);
  }

  // Text
  const hook = quoted(text, 'hook');
  if (hook) {
    patch.hook_text = hook;
    did.push(`changed the hook to "${hook}"`);
  }
  const cta = quoted(text, '(?:cta|call to action|ending text|end text)');
  if (cta) {
    patch.cta_text = cta;
    did.push(`changed the call to action to "${cta}"`);
  }
  if (/\b(no|remove|without|hide|delete|get rid of)\s+(any\s+|all\s+(of\s+)?(the\s+)?|the\s+)?(on-?screen\s+)?(text|words|writing)\b/.test(t)) {
    patch.noText = true;
    did.push('removed all on-screen text');
  } else if (/\b(no|remove|without|hide|delete|get rid of)\s+(any\s+|all\s+(of\s+)?(the\s+)?|the\s+)?(on-?screen\s+)?captions?\b/.test(t)) {
    patch.noCaptions = true;
    did.push('removed the captions (kept the hook and call to action)');
  }

  // Music
  if (/\b(no|remove|without|turn off|stop)\s+(the\s+)?(music|song|track)\b/.test(t)) {
    out.musicTrack = null;
    did.push('removed the music');
  } else {
    const named = tracks.find((tr) => tr.name.length > 2 && t.includes(tr.name.toLowerCase()));
    const byWord = !named && tracks.find((tr) => tr.name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && new RegExp(`\\b${w}\\b`).test(t) && /\b(song|track|music|use)\b/.test(t)));
    const mood = t.match(/\b(energetic|upbeat|hype|chill|calm|lofi|lo-fi|relaxed|build|cinematic|epic)\b/);
    if (named || byWord) {
      out.musicTrack = (named || byWord).id;
      did.push(`switched the music to "${(named || byWord).name}"`);
    } else if (mood && /\b(song|track|music)\b/.test(t)) {
      const want = /energetic|upbeat|hype/.test(mood[1]) ? 'energetic' : /build|cinematic|epic/.test(mood[1]) ? 'build' : 'chill';
      const pick = tracks.find((tr) => tr.mood === want);
      if (pick) {
        out.musicTrack = pick.id;
        did.push(`switched the music to "${pick.name}" (${want})`);
      } else {
        did.push(`couldn't find a ${want} track in your music library`);
      }
    } else if (/\b(different|another|new|change( the)?)\s+(song|track|music)\b|\badd (some )?music\b/.test(t)) {
      out.musicTrack = 'next';
      did.push(tracks.length ? 'changed the song' : "couldn't add music because your music library is empty");
    }
  }
  if (/\b(music|song)\s+(louder|up)\b|\blouder\s+(music|song)\b/.test(t)) {
    out.musicLevel = 'loud';
    did.push('made the music louder');
  } else if (/\b(music|song)\s+(quieter|softer|down)\b|\b(quieter|softer)\s+(music|song)\b/.test(t)) {
    out.musicLevel = 'soft';
    did.push('made the music quieter');
  }
  if (/\b(mute|remove|no|without)\s+(the\s+)?(original|real|background|video('s)?)\s+(sound|audio|noise)\b/.test(t)) {
    out.audio = 'mute';
    did.push("muted the footage's own sound");
  } else if (/\b(keep|bring back|add back|turn on)\s+(the\s+)?(original|real)\s+(sound|audio)\b/.test(t)) {
    out.audio = 'original';
    did.push("brought back the footage's own sound");
  }

  // Style / pace
  let style = null;
  for (const [re, id] of STYLE_WORDS) if (re.test(t)) style = id;
  if (!style && /\b(faster|quicker|more energy|more energetic|snappier|punchier)\b/.test(t)) style = 'montage';
  if (!style && /\b(slower|calmer|more relaxed|less busy)\b/.test(t)) style = 'satisfying';
  if (style) {
    patch.style = style;
    did.push(`changed ${which} to the ${STYLES[style].label} style`);
  }

  // Fresh take
  if (/\b(redo|re-do|regenerate|new version|different shots|different clips?|try again|another version|start over)\b/.test(t)) {
    out.regenerate = true;
    did.push(`made a fresh version of ${which}`);
  }

  out.understood = did.length > 0;
  out.reply = out.understood
    ? `Done: ${did.join(', ')}.`
    : "I couldn't work out that change without the AI. Without a Claude key I understand things like: \"make clip 2 15 seconds\", \"hook: Wait for the reveal\", \"cta: Book at Gloss Boss\", \"no music\", \"use the lofi song\", \"louder music\", \"make it a promo\", \"faster\", \"no captions\" or \"redo clip 1\". Add a Claude key in Settings to ask for anything in plain English.";
  return out;
}
