// Google connection. The owner's Google Form runs a small Apps Script
// (integrations/google-form/Code.gs) that Cutline talks to with a secret
// connection code: it hands over new form answers and uploaded files, saves
// approved videos to Google Drive, sends approved emails from the owner's Gmail
// and reports client replies. What happens with all of it is in cprojects.js.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, loadProject, newId, updateProject } from './store.js';
import { duplicateProject } from './clients.js';
import { resizeAds } from './ads.js';
import { FORMATS } from '../../public/engine/compose.js';
import { cleanProfile } from './pipeline.js';
import { aiConfigured } from './ai.js';
import { voiceConfigured } from '../providers/tts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCRIPT_FILE = path.join(ROOT, 'integrations', 'google-form', 'Code.gs');
export const SCRIPT_VERSION = 3;
const DIR = path.join(DATA_DIR, 'intake');
const CONFIG_FILE = path.join(DIR, 'config.json');
const TMP = path.join(DATA_DIR, 'tmp');
export const CHECK_EVERY_MS = Number(process.env.CUTLINE_FORM_CHECK_MS || 2 * 60_000);
const MAX_FILE = 50 * 1024 * 1024;
const LENGTHS = [10, 15, 20, 30];

const DEFAULTS = {
  autoProduce: false, mode: 'ai', dailyLimit: 10, voiceover: true, since: 0, connectedAt: null, lastCheck: null, lastError: null,
  formTitle: '', formUrl: '', formEditUrl: '', scriptVersion: 0, gmail: '', lastInboxCheck: null, inboxError: null,
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let cfgLock = Promise.resolve();
export const loadConfig = async () => ({ ...DEFAULTS, ...(await readJson(CONFIG_FILE, {})) });
/** Change the connection settings under a lock (the checker and the page both write). */
export function updateConfig(mutate) {
  const run = cfgLock.then(async () => {
    const cfg = await loadConfig();
    await mutate(cfg);
    await fs.mkdir(DIR, { recursive: true });
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await fs.rename(tmp, CONFIG_FILE);
    return cfg;
  });
  cfgLock = run.catch(() => {});
  return run;
}

export const formConfigured = () => Boolean(process.env.GOOGLE_FORM_URL && process.env.GOOGLE_FORM_KEY);

/** Only Google's Apps Script addresses get the connection code. */
export function validFormUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:' && url.hostname === 'script.google.com' && /^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname)) return true;
    return process.env.CUTLINE_FORM_ALLOW_LOCAL === '1' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Talking to the Apps Script
// ---------------------------------------------------------------------------

export async function callScript(params) {
  const url = new URL(process.env.GOOGLE_FORM_URL);
  url.searchParams.set('key', process.env.GOOGLE_FORM_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    throw new Error(`Could not reach Google (${err.cause?.code || err.message}). Check the internet connection.`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // A sign-in page instead of JSON means the web app isn't open to "Anyone".
    throw new Error(/<html/i.test(text)
      ? 'Google answered with a web page instead of form answers. In Apps Script, deploy it again with "Who has access: Anyone", and paste the new Web app URL.'
      : `Unexpected answer from Google (HTTP ${res.status}).`);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

/** POST to the script (saving videos to Drive, sending email). */
export async function postScript(body) {
  let res;
  try {
    res = await fetch(process.env.GOOGLE_FORM_URL, {
      method: 'POST', redirect: 'follow', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, key: process.env.GOOGLE_FORM_KEY }), signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    throw new Error(`Could not reach Google (${err.cause?.code || err.message}). Check the internet connection.`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(/doPost/.test(text)
      ? 'Your Google script is an old version. Update it (Client Onboarding → "Update your Google script").'
      : `Unexpected answer from Google (HTTP ${res.status}).`);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

export async function downloadFile(responseId, file) {
  if (file.size > MAX_FILE) throw new Error(`"${file.name}" is ${(file.size / 1048576).toFixed(0)} MB, too big to fetch automatically. It is in your Google Drive.`);
  await fs.mkdir(TMP, { recursive: true });
  const out = path.join(TMP, `${newId('form')}${path.extname(file.name || '').toLowerCase().replace(/[^.a-z0-9]/g, '')}`);
  const handle = await fs.open(out, 'w');
  try {
    let offset = 0;
    for (let i = 0; i < 40; i++) {
      const piece = await callScript({ response: responseId, file: file.id, offset });
      const buf = Buffer.from(piece.data || '', 'base64');
      await handle.write(buf);
      offset += buf.length;
      if (piece.done || !buf.length) break;
    }
  } catch (err) {
    await handle.close();
    await fs.rm(out, { force: true });
    throw err;
  }
  await handle.close();
  return out;
}

// ---------------------------------------------------------------------------
// Understanding the answers
// ---------------------------------------------------------------------------

const asText = (a) => (Array.isArray(a) ? a.flat().filter((x) => x && typeof x !== 'object').join(', ') : a == null ? '' : String(a)).trim();

// Ordered: the first rule whose pattern matches a question title claims it, so
// specific questions come before general ones. Titles can be reworded a little.
const RULES = [
  ['logo', /logo/],
  ['clips', /video clip|clips|footage/],
  ['photos', /photo|picture|image/],
  ['email', /e-?mail/],
  ['contactName', /your name|contact name|contact person|first name|full name|who should we|^name$/],
  ['inspiration', /videos or brands|brands whose|inspiration|style you love/],
  ['mustNot', /must not|not show|never (show|say)|avoid/],
  ['mustSay', /must-? ?say|must include|key details/],
  ['name', /business name|name of (your )?business|company name|trading name/],
  ['type', /type of business|business type|kind of business|industry/],
  ['offer', /offer or deal|deal to promote|special offer|promotion/],
  ['focus', /focus/],
  ['services', /what do you (sell|offer|do)|products? or services|what you sell|^services/],
  ['location', /suburb|city|location|where are you based|address/],
  ['audience', /customers|audience|target market|who (do you|are you) (serve|target)/],
  ['about', /about (your|the) business|tell us about|describe your business|menu|story/],
  ['contact', /contact|phone|website|handle/],
  ['goal', /goal|objective/],
  ['cta', /viewers do|at the end|call to action/],
  ['platforms', /post|platform/],
  ['length', /how long|length|seconds/],
  ['colors', /colou?r/],
  ['style', /style|look and feel|vibe/],
  ['music', /music/],
  ['voice', /voice/],
  ['review', /review|testimonial/],
  ['deadline', /when do you need|deadline|need (it|the video) by|due/],
  ['count', /how many versions|versions|options to choose/],
  ['notes', /anything else|other notes|comments/],
];

const BUSINESS = [
  ['restaurant', /restaurant|bistro|pub\b|takeaway|pizza|diner/],
  ['cafe', /caf[eé]|coffee|bakery/],
  ['detailing', /detail|car wash|car care/],
  ['trades', /trade|plumb|electric|sparky|build|carpent|roof|landscap|paint/],
  ['barber', /barber|hair|salon/],
  ['gym', /gym|fitness|personal train|pilates|yoga/],
];
const OBJECTIVE = [['offer', /offer|special|deal/], ['bookings', /booking|order/], ['trust', /trust|review|quality/], ['local', /local/], ['showcase', /show|work|product/]];
const DIRECTION = [
  ['cinematic', /cinematic/], ['luxury', /luxury/], ['minimalist', /minimal/], ['futuristic', /futur|modern/], ['energetic', /energetic/],
  ['editorial', /editorial|magazine/], ['commercial', /commercial/], ['playful', /playful/], ['premium', /premium/], ['industrial', /industrial|rugged/],
];
const MOOD = [['energetic', /upbeat|energetic/], ['chill', /chill|relax|elegant|classy|calm/], ['build', /cinematic|dramatic|epic/]];
const VOICE = [['onyx', /deep/], ['coral', /warm|friendly/], ['verse', /energetic|upbeat/]];
const COLOURS = {
  black: '#111111', white: '#ffffff', grey: '#8a8a8a', gray: '#8a8a8a', silver: '#c0c0c0', charcoal: '#36454f',
  red: '#d62828', maroon: '#7a1f2b', burgundy: '#800020', crimson: '#c1121f', pink: '#ec4899', magenta: '#d4148a',
  orange: '#f77f00', peach: '#ffb38a', coral: '#ff6f61', yellow: '#fcbf49', gold: '#d4a017', mustard: '#d9a400',
  cream: '#f5ecd7', beige: '#e3d5b8', tan: '#c8a27a', brown: '#7b4a2a', bronze: '#a97142', copper: '#b87333',
  green: '#2a9d4b', olive: '#708238', sage: '#9caf88', mint: '#98e2c6', lime: '#9bd12f', emerald: '#1f8a5b', forest: '#225b37',
  teal: '#14868c', turquoise: '#30c5c5', aqua: '#2ec4d6', cyan: '#00b4d8', blue: '#1d6fd8', navy: '#1b2a4a', royal: '#2742b5', sky: '#7cc4f2',
  purple: '#7b3fbf', violet: '#8f5bd6', lilac: '#c8a2c8', lavender: '#b9a6e0', plum: '#7d3c63',
};
const pickBy = (table, text, fallback) => (table.find(([, re]) => re.test(text)) || [fallback])[0];

function parseColours(text) {
  const found = [];
  for (const m of text.matchAll(/#?\b([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    if (!/[a-f]/i.test(m[1]) && !m[0].startsWith('#')) continue; // plain numbers are not colours
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    found.push([m.index, `#${h.toLowerCase()}`]);
  }
  const lower = text.toLowerCase();
  for (const [name, hex] of Object.entries(COLOURS)) {
    const at = lower.search(new RegExp(`\\b${name}\\b`));
    if (at >= 0) found.push([at, hex]);
  }
  // In the order the client typed them: the first is usually the main colour.
  return [...new Set(found.sort((a, b) => a[0] - b[0]).map(([, hex]) => hex))].slice(0, 4);
}

/** Form answers → everything Cutline needs to make the ads. */
export function mapAnswers(answers = [], respondentEmail = '') {
  const got = {};
  const files = { logo: [], photos: [], clips: [] };
  const extra = [];
  for (const a of answers) {
    const title = String(a.title || '').toLowerCase();
    if (a.type === 'FILE_UPLOAD') {
      const list = (Array.isArray(a.answer) ? a.answer : []).filter((f) => f && f.id);
      let key = /logo/.test(title) ? 'logo' : /video|clip|footage/.test(title) ? 'clips' : /photo|picture|image/.test(title) ? 'photos' : null;
      for (const f of list) files[key || (/^video\//.test(f.type) ? 'clips' : 'photos')].push(f);
      continue;
    }
    const value = asText(a.answer);
    if (!value) continue;
    const rule = RULES.find(([k, re]) => re.test(title) && !(k in got));
    if (rule) got[rule[0]] = value;
    else extra.push(`${a.title}: ${value}`);
  }
  const lower = (k) => String(got[k] || '').toLowerCase();
  const notSure = (k) => !got[k] || /not sure|you decide|no preference|don.t know/.test(lower(k));
  const notes = [];

  const typeText = lower('type');
  const business = pickBy(BUSINESS, typeText, 'other');
  const platforms = lower('platforms');
  const formats = [];
  if (/tiktok|reel|stor|short|vertical/.test(platforms)) formats.push('9:16');
  if (/feed|post\b/.test(platforms)) formats.push('4:5');
  if (/website|landscape|widescreen|youtube(?!\s*shorts)/.test(platforms)) formats.push('16:9');
  if (/square/.test(platforms)) formats.push('1:1');
  if (!formats.length) formats.push('9:16');
  const n = Number((lower('length').match(/\d+/) || [])[0]);
  const seconds = n ? LENGTHS.reduce((best, l) => (Math.abs(l - n) < Math.abs(best - n) ? l : best), 15) : 15;
  const voiceText = lower('voice');
  const voiceover = Boolean(voiceText) && !/^no\b|no,|music only|none/.test(voiceText);
  const count = Math.max(1, Math.min(3, Number((lower('count').match(/\d/) || [])[0]) || 2));

  const instructions = [
    got.focus && `Focus this video on: ${got.focus}.`,
    got.cta && `End with this call to action: ${got.cta}.`,
    got.mustSay && `Must mention: ${got.mustSay}.`,
    got.mustNot && `Never show or say: ${got.mustNot}.`,
    got.inspiration && `Styles the client likes: ${got.inspiration}.`,
    got.music && !notSure('music') && `Music the client wants: ${got.music}.`,
    got.notes && `Client notes: ${got.notes}`,
    ...extra.slice(0, 6),
  ].filter(Boolean).join('\n').slice(0, 2000);

  return {
    name: (got.name || '').slice(0, 80),
    email: (got.email || respondentEmail || '').slice(0, 120),
    business,
    businessCustom: business === 'other' ? (got.type || '').slice(0, 80) : '',
    contactName: (got.contactName || '').slice(0, 80),
    profile: cleanProfile({ name: got.name, services: got.services, location: got.location, offer: got.offer, contact: got.contact, review: got.review, audience: got.audience, notes: got.about }),
    objective: notSure('goal') ? 'auto' : pickBy(OBJECTIVE, lower('goal'), 'auto'),
    direction: notSure('style') ? 'auto' : pickBy(DIRECTION, lower('style'), 'auto'),
    colors: got.colors ? parseColours(got.colors) : [],
    format: formats[0],
    formats: formats.slice(0, 3),
    seconds,
    count,
    musicMood: notSure('music') ? null : pickBy(MOOD, lower('music'), null),
    voiceover,
    voice: voiceover ? pickBy(VOICE, voiceText, 'coral') : null,
    instructions,
    focus: got.focus || '',
    deadline: got.deadline || '',
    files,
    notes,
  };
}

export { asText };

// ---------------------------------------------------------------------------
// New form answers
// ---------------------------------------------------------------------------

/**
 * Ask the form for answers newer than the last check. Returns the raw
 * responses (callers skip ones they already have) and remembers the script's
 * version, form links and Gmail account.
 */
export async function fetchResponses() {
  const cfg = await loadConfig();
  const out = [];
  let since = cfg.since || 0;
  let info = {};
  for (let round = 0; round < 10; round++) {
    const data = await callScript(since ? { since: since - 1000 } : {});
    info = { formTitle: data.form?.title || '', formUrl: data.form?.url || '', formEditUrl: data.form?.editUrl || '', scriptVersion: Number(data.version) || 1, gmail: data.account || '' };
    const fresh = (data.responses || []).filter((r) => r?.id && !out.some((x) => x.id === r.id));
    out.push(...fresh);
    for (const r of data.responses || []) since = Math.max(since, Number(r.time) || 0);
    if (!data.more || !fresh.length) break;
  }
  const saved = await updateConfig((c) => {
    Object.assign(c, info, { since: Math.max(c.since || 0, since), lastCheck: Date.now(), lastError: null });
    if (!c.connectedAt) c.connectedAt = Date.now();
  });
  return { responses: out, connectedAt: saved.connectedAt, config: saved };
}

export async function recordCheckError(err) {
  await updateConfig((c) => Object.assign(c, { lastCheck: Date.now(), lastError: err.message }));
}

// ---------------------------------------------------------------------------
// Extra sizes (job runner)
// ---------------------------------------------------------------------------

/**
 * Re-render a finished project's ads in another size, with no AI. `into`
 * refreshes an existing size project (after changes); otherwise the project
 * is copied first.
 */
export async function makeSize(projectId, { format, into = null }, ctx) {
  const src = await loadProject(projectId);
  if (!src?.adPlan?.ads?.length || !(src.adRenders || []).some(Boolean)) throw new Error('The main videos were not made, so this size was skipped.');
  let target = into ? await loadProject(into) : null;
  if (target) {
    ctx.stage('Updating this size with the latest changes', 0.02);
    await updateProject(target.id, (p) => {
      p.adPlan = structuredClone(src.adPlan);
      p.adAssets = structuredClone(src.adAssets || []);
    });
  } else {
    ctx.stage('Copying the project', 0.02);
    target = await duplicateProject(projectId);
    const label = FORMATS[format]?.label.split(' (')[0] || format;
    await updateProject(target.id, (p) => {
      p.name = `${src.name.replace(/ \(copy\)$/, '')} · ${label}`.slice(0, 80);
    });
  }
  await resizeAds(target.id, { format }, ctx);
  return { projectId: target.id };
}

// ---------------------------------------------------------------------------
// Settings for the page
// ---------------------------------------------------------------------------

export async function intakeStatus() {
  const cfg = await loadConfig();
  const key = process.env.GOOGLE_FORM_KEY || '';
  return {
    configured: formConfigured(),
    url: process.env.GOOGLE_FORM_URL || '',
    key: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
    autoProduce: cfg.autoProduce, mode: cfg.mode, dailyLimit: cfg.dailyLimit, voiceover: cfg.voiceover,
    connectedAt: cfg.connectedAt, lastCheck: cfg.lastCheck, lastError: cfg.lastError,
    formTitle: cfg.formTitle, formUrl: cfg.formUrl, formEditUrl: cfg.formEditUrl,
    scriptVersion: cfg.scriptVersion, latestScript: SCRIPT_VERSION, scriptOutdated: formConfigured() && cfg.lastCheck && cfg.scriptVersion < SCRIPT_VERSION,
    gmail: cfg.gmail, gmailReady: formConfigured() && cfg.scriptVersion >= 3, lastInboxCheck: cfg.lastInboxCheck, inboxError: cfg.inboxError,
    checkEveryMinutes: Math.max(1, Math.round(CHECK_EVERY_MS / 60000)),
    ai: aiConfigured(), voice: voiceConfigured(),
  };
}

export async function saveIntakeOptions(b = {}) {
  await updateConfig((cfg) => {
    if (typeof b.autoProduce === 'boolean') cfg.autoProduce = b.autoProduce;
    if (b.mode === 'ai' || b.mode === 'auto') cfg.mode = b.mode;
    if (b.dailyLimit !== undefined) cfg.dailyLimit = Math.max(0, Math.min(100, Math.round(Number(b.dailyLimit) || 0)));
    if (typeof b.voiceover === 'boolean') cfg.voiceover = b.voiceover;
    if (b.resetConnection) Object.assign(cfg, { since: 0, connectedAt: null, lastError: null, formTitle: '', formUrl: '', formEditUrl: '', scriptVersion: 0, gmail: '' });
  });
}
