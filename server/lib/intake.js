// Google Form intake. The owner's form runs a small Apps Script
// (integrations/google-form/Code.gs) that hands new answers to Cutline when
// asked with the secret connection code. Cutline checks every few minutes and
// turns each answer into a client (brand kit + photos), a project and a batch
// of ads, using the same jobs as the Ads page.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getJob, loadProject, newId, projectDir, updateProject } from './store.js';
import { addClientMedia, createClient, duplicateProject, listClients, loadClient, newProjectForClient, syncProjectBrand, updateClient } from './clients.js';
import { resizeAds } from './ads.js';
import { FORMATS } from '../../public/engine/compose.js';
import { cleanProfile } from './pipeline.js';
import { probe, thumbnail } from './ffmpeg.js';
import { aiConfigured } from './ai.js';
import { voiceConfigured } from '../providers/tts.js';
import { log } from './log.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCRIPT_FILE = path.join(ROOT, 'integrations', 'google-form', 'Code.gs');
const DIR = path.join(DATA_DIR, 'intake');
const CONFIG_FILE = path.join(DIR, 'config.json');
const REQUESTS_FILE = path.join(DIR, 'requests.json');
const TMP = path.join(DATA_DIR, 'tmp');
const CHECK_EVERY_MS = Number(process.env.CUTLINE_FORM_CHECK_MS || 2 * 60_000);
const MAX_FILE = 50 * 1024 * 1024;
const LENGTHS = [10, 15, 20, 30];

const DEFAULT_MESSAGE = 'Hi {name},\n\nYour new video is ready! Watch and download it here:\n\n{links}\n\nIf you would like any changes, just reply to this email.\n\nThanks,\n{sender}';
const DEFAULTS = {
  auto: true, mode: 'ai', dailyLimit: 10, voiceover: true, since: 0, connectedAt: null, lastCheck: null, lastError: null, formTitle: '', formUrl: '',
  scriptVersion: 0, senderName: '', emailSubject: 'Your new video is ready', emailMessage: DEFAULT_MESSAGE,
};
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_SEND = 40 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

const loadConfig = async () => ({ ...DEFAULTS, ...(await readJson(CONFIG_FILE, {})) });
const saveConfig = (c) => writeJson(CONFIG_FILE, c);

// All changes to the request list go through one lock so the checker, the
// queue and the page's buttons never overwrite each other.
let lock = Promise.resolve();
function withRequests(mutate) {
  const run = lock.then(async () => {
    const list = await readJson(REQUESTS_FILE, []);
    const out = await mutate(list);
    await writeJson(REQUESTS_FILE, list);
    return out;
  });
  lock = run.catch(() => {});
  return run;
}

async function patchRequest(id, fields) {
  return withRequests((list) => {
    const r = list.find((x) => x.id === id);
    if (r) Object.assign(r, fields);
    return r;
  });
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

async function callScript(params) {
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
async function postScript(body) {
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
      ? 'Your Google script is the old version. Update it (Requests page → "Update your Google script").'
      : `Unexpected answer from Google (HTTP ${res.status}).`);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

async function downloadFile(responseId, file) {
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
  ['inspiration', /videos or brands|brands whose|inspiration|style you love/],
  ['mustNot', /must not|not show|never (show|say)|avoid/],
  ['mustSay', /must-? ?say|must include|key details/],
  ['name', /business name|name of (your )?business|^name$/],
  ['type', /type of business|business type|kind of business|industry/],
  ['offer', /offer or deal|deal to promote|special offer|promotion/],
  ['focus', /focus/],
  ['services', /what do you (sell|offer|do)|products? or services|what you sell|^services/],
  ['location', /suburb|city|location|where are you based|address/],
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
    profile: cleanProfile({ name: got.name, services: got.services, location: got.location, offer: got.offer, contact: got.contact, review: got.review }),
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

// ---------------------------------------------------------------------------
// Checking for new answers
// ---------------------------------------------------------------------------

let checking = null;

/** Ask the form for new answers and queue them. */
export function checkNow() {
  if (!checking) checking = doCheck().finally(() => (checking = null));
  return checking;
}

async function doCheck() {
  if (!formConfigured()) return { ok: false, message: 'Paste the Web app URL and connection code first.' };
  const cfg = await loadConfig();
  let added = 0;
  try {
    let more = true;
    for (let round = 0; more && round < 10; round++) {
      // Ask from just before the newest answer we have (duplicates are skipped).
      const data = await callScript(cfg.since ? { since: cfg.since - 1000 } : {});
      more = Boolean(data.more);
      cfg.formTitle = data.form?.title || cfg.formTitle;
      cfg.scriptVersion = Number(data.version) || 1;
      cfg.formUrl = data.form?.url || cfg.formUrl;
      const first = !cfg.connectedAt;
      if (first) cfg.connectedAt = Date.now();
      const today = new Date().toDateString();
      const fresh = await withRequests((list) => {
        const out = [];
        let todays = list.filter((r) => r.autoStarted && new Date(r.receivedAt).toDateString() === today).length;
        for (const resp of data.responses || []) {
          cfg.since = Math.max(cfg.since || 0, Number(resp?.time) || 0);
          if (!resp?.id || list.some((r) => r.responseId === resp.id)) continue;
          const mapped = mapAnswers(resp.answers, resp.email);
          const req = {
            id: newId('r'), responseId: String(resp.id), submittedAt: resp.time, receivedAt: Date.now(),
            name: mapped.name || mapped.email || 'Unnamed business', email: mapped.email,
            answers: (resp.answers || []).slice(0, 60), status: 'waiting', notes: [],
          };
          if (resp.time < cfg.connectedAt) req.notes.push('Sent before Cutline was connected, so it was not made automatically.');
          else if (!cfg.auto) req.notes.push('Automatic making is off: press Make videos.');
          else if (todays >= cfg.dailyLimit) req.notes.push(`Today's limit of ${cfg.dailyLimit} automatic requests was reached: press Make videos.`);
          else {
            req.status = 'queued';
            req.autoStarted = true;
            todays++;
          }
          list.unshift(req);
          out.push(req);
        }
        list.splice(200);
        return out;
      });
      added += fresh.length;
      if (!fresh.length) break;
    }
    Object.assign(cfg, { lastCheck: Date.now(), lastError: null });
    await saveConfig(cfg);
    runQueue();
    return { ok: true, added, message: added ? `${added} new request${added > 1 ? 's' : ''} found.` : `Connected to "${cfg.formTitle || 'your form'}". No new requests.` };
  } catch (err) {
    Object.assign(cfg, { lastCheck: Date.now(), lastError: err.message });
    await saveConfig(cfg);
    log('warn', `form check failed: ${err.message}`);
    return { ok: false, added, message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Turning a request into ads (one request at a time)
// ---------------------------------------------------------------------------

let startJob = null;
let queueRunning = false;

async function runQueue() {
  if (queueRunning || !startJob) return;
  queueRunning = true;
  try {
    for (;;) {
      const list = await readJson(REQUESTS_FILE, []);
      const next = [...list].reverse().find((r) => r.status === 'queued');
      if (!next) break;
      try {
        await prepare(next);
      } catch (err) {
        log('warn', `form request ${next.id} failed: ${err.message}`);
        await patchRequest(next.id, { status: 'error', error: err.message });
      }
    }
  } finally {
    queueRunning = false;
  }
}

async function findClient(mapped) {
  const name = mapped.name.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const c of await listClients()) {
    const full = await loadClient(c.id);
    if (mapped.email && full?.email && full.email.toLowerCase() === mapped.email.toLowerCase()) return full;
    if (name && c.name.toLowerCase().replace(/\s+/g, ' ').trim() === name) return full;
  }
  return null;
}

async function addVideo(projectId, tmpPath, name) {
  const dir = path.join(projectDir(projectId), 'videos');
  await fs.mkdir(dir, { recursive: true });
  const id = newId('v');
  const ext = (path.extname(name).toLowerCase().match(/^\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts)$/) || ['.mp4'])[0];
  const file = `${id}${ext}`;
  const dest = path.join(dir, file);
  await fs.copyFile(tmpPath, dest);
  try {
    const meta = await probe(dest);
    if (meta.duration < 1) throw new Error('shorter than 1 second');
    await thumbnail(dest, path.join(dir, `${id}.jpg`), Math.min(1, meta.duration / 3), meta);
    const stat = await fs.stat(dest);
    await updateProject(projectId, (p) => {
      p.videos.push({ id, name, file, size: stat.size, thumb: `${id}.jpg`, meta, uploadedAt: new Date().toISOString() });
    });
  } catch (err) {
    await fs.rm(dest, { force: true });
    throw new Error(`"${name}" could not be read as a video (${err.message.includes('ffprobe') ? 'unsupported or corrupt file' : err.message}).`);
  }
}

async function prepare(req) {
  const cfg = await loadConfig();
  const mapped = mapAnswers(req.answers, req.email);
  const notes = [...mapped.notes];
  const stage = (s) => patchRequest(req.id, { status: 'preparing', stage: s, error: null });

  // A project from an earlier attempt: just make the ads again.
  if (req.projectId && (await loadProject(req.projectId)) && req.jobOpts) {
    const job = startJob(req.projectId, 'ads', req.jobOpts);
    await patchRequest(req.id, { status: 'making', jobId: job.id, stage: null, error: null, extras: startSizes(req.projectId, mapped.formats) });
    return;
  }

  await stage('Setting up the client');
  let client = await findClient(mapped);
  const fill = (old = {}) => Object.fromEntries(Object.entries(mapped.profile).map(([k, v]) => [k, v || old[k] || '']));
  if (!client) {
    client = await createClient({
      name: mapped.name || mapped.email || 'New client', business: mapped.business, businessCustom: mapped.businessCustom,
      profile: fill(), brand: { colors: mapped.colors, direction: mapped.direction },
    });
  }
  client = await updateClient(client.id, (c) => {
    c.profile = cleanProfile(fill(c.profile));
    if (mapped.email) c.email = mapped.email;
    if (mapped.business !== 'other' || !c.business) Object.assign(c, { business: mapped.business, businessCustom: mapped.businessCustom });
    if (mapped.colors.length) c.brand.colors = mapped.colors;
    if (mapped.direction !== 'auto') c.brand.direction = mapped.direction;
  });

  // Files: logo and photos go into the client's library (for next time too).
  const newPhotos = [];
  const clipFiles = [];
  const all = [...mapped.files.logo.slice(0, 1).map((f) => ['logo', f]), ...mapped.files.photos.slice(0, 15).map((f) => ['photo', f]), ...mapped.files.clips.slice(0, 5).map((f) => ['clip', f])];
  for (const [i, [kind, f]] of all.entries()) {
    await stage(`Downloading ${kind === 'clip' ? 'video' : kind} ${i + 1} of ${all.length}`);
    let tmp = null;
    try {
      tmp = await downloadFile(req.responseId, f);
      if (kind === 'clip') {
        clipFiles.push({ tmp, name: f.name || 'clip.mp4' });
        tmp = null;
        continue;
      }
      const out = await addClientMedia(client.id, [{ path: tmp, originalname: f.name || 'photo.jpg' }], kind);
      if (out.failed.length) notes.push(`${f.name}: ${out.failed[0].error}`);
      if (kind === 'photo') newPhotos.push(...out.added.map((a) => a.id));
    } catch (err) {
      notes.push(err.message);
    } finally {
      if (tmp) await fs.rm(tmp, { force: true });
    }
  }

  await stage('Creating the project');
  const day = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const project = await newProjectForClient(client.id, `${client.name}${mapped.focus ? ` · ${mapped.focus}` : ''} · ${day}`.slice(0, 80), { mediaIds: newPhotos.length ? newPhotos : null });
  for (const c of clipFiles) {
    try {
      await addVideo(project.id, c.tmp, c.name);
    } catch (err) {
      notes.push(err.message);
    } finally {
      await fs.rm(c.tmp, { force: true });
    }
  }
  if (!newPhotos.length && !(client.media || []).length) notes.push('No photos were sent, so the ads are made from text, colours and the logo.');

  let mode = cfg.mode === 'auto' ? 'auto' : 'ai';
  if (mode === 'ai' && !aiConfigured()) {
    mode = 'auto';
    notes.push('No Claude key saved, so free mode was used.');
  }
  let voiceover = mapped.voiceover;
  if (voiceover && !cfg.voiceover) {
    voiceover = false;
    notes.push('They asked for a voiceover, but voiceovers for form requests are switched off.');
  } else if (voiceover && !voiceConfigured()) {
    voiceover = false;
    notes.push('They asked for a voiceover, but no OpenAI key is saved.');
  }
  const jobOpts = {
    mode, business: mapped.business, businessCustom: mapped.businessCustom, profile: client.profile,
    count: mapped.count, seconds: mapped.seconds, format: mapped.format, direction: mapped.direction, objective: mapped.objective,
    music: 'auto', musicMood: mapped.musicMood, voiceover, voice: mapped.voice || 'coral', instructions: mapped.instructions, review: true,
  };
  await updateProject(project.id, (p) => {
    p.instructions = mapped.instructions;
    p.request = { id: req.id, from: 'Google Form', submittedAt: req.submittedAt, deadline: mapped.deadline, email: mapped.email };
  });
  await syncProjectBrand(project.id);
  const job = startJob(project.id, 'ads', jobOpts);
  await patchRequest(req.id, { status: 'making', stage: null, clientId: client.id, projectId: project.id, jobId: job.id, jobOpts, extras: startSizes(project.id, mapped.formats), notes: [...(req.notes || []).filter((n) => !/press Make|not made automatically/.test(n)), ...notes].slice(0, 20) });
}

/** Extra sizes the client asked for: queued after the main videos, no extra AI. */
function startSizes(projectId, formats) {
  return formats.slice(1).map((format) => ({ format, jobId: startJob(projectId, 'ads-size', { format }).id }));
}

/** Job runner: copy the finished project and re-render its ads in another size. */
export async function makeSize(projectId, { format }, ctx) {
  const src = await loadProject(projectId);
  if (!src?.adPlan?.ads?.length || !(src.adRenders || []).some(Boolean)) throw new Error('The main videos were not made, so this size was skipped.');
  ctx.stage('Copying the project', 0.02);
  const copy = await duplicateProject(projectId);
  const label = FORMATS[format]?.label.split(' (')[0] || format;
  await updateProject(copy.id, (p) => {
    p.name = `${src.name.replace(/ \(copy\)$/, '')} · ${label}`.slice(0, 80);
  });
  await resizeAds(copy.id, { format }, ctx);
  return { projectId: copy.id };
}

// ---------------------------------------------------------------------------
// Public API for the routes
// ---------------------------------------------------------------------------

/** Request list with live job status (finished jobs are written back). */
const fill = (t, vars) => String(t).replace(/\{(name|sender)\}/g, (_, k) => vars[k] || '');

/** Every finished video of a request (all versions, all sizes). */
async function requestVideos(r) {
  const out = [];
  const projects = [[r.projectId, null], ...(r.extras || []).filter((e) => e.projectId).map((e) => [e.projectId, e.format])];
  for (const [pid, extraFormat] of projects) {
    const p = pid && (await loadProject(pid).catch(() => null));
    if (!p) continue;
    const format = extraFormat || p.adPlan?.format || '9:16';
    const size = { '9:16': 'Vertical', '4:5': 'Feed', '1:1': 'Square', '16:9': 'Landscape' }[format] || format;
    (p.adRenders || []).forEach((v, i) => {
      if (!v?.file) return;
      out.push({ key: `${pid}/${v.file}`, projectId: pid, file: v.file, thumb: v.thumb || null, format, label: `Version ${i + 1}${projects.length > 1 ? ` · ${size}` : ''}` });
    });
  }
  return out;
}

export async function listRequests() {
  const cfg = await loadConfig();
  return withRequests(async (list) => {
    for (const r of list) {
      if (r.status !== 'making') continue;
      const job = r.jobId && getJob(r.jobId);
      if (!job) {
        Object.assign(r, { status: 'error', error: 'The job was lost (Cutline restarted). Press Try again.' });
        continue;
      }
      if (job.status === 'error' || job.status === 'interrupted') {
        Object.assign(r, { status: 'error', error: job.error || 'The job failed.' });
        continue;
      }
      if (job.status !== 'done') {
        Object.assign(r, { progress: job.progress, stage: job.stage });
        continue;
      }
      // Main videos done: follow the extra sizes.
      let pending = null;
      for (const e of r.extras || []) {
        if (e.status === 'done' || e.status === 'error') continue;
        const ej = getJob(e.jobId);
        if (!ej) Object.assign(e, { status: 'error', error: 'Lost when Cutline restarted.' });
        else if (ej.status === 'done') Object.assign(e, { status: 'done', projectId: ej.result?.projectId || null });
        else if (ej.status === 'error' || ej.status === 'interrupted') Object.assign(e, { status: 'error', error: ej.error });
        else pending = pending || { stage: `${e.format} size: ${ej.stage}`, progress: ej.progress };
      }
      if (pending) Object.assign(r, pending);
      else {
        // Ready for the owner to check; nothing is sent until they approve.
        Object.assign(r, { status: 'review', stage: null, progress: null, finishedAt: Date.now() });
        for (const e of (r.extras || []).filter((x) => x.status === 'error')) r.notes = [...(r.notes || []), `The ${e.format} size could not be made: ${e.error}`];
      }
    }
    const views = [];
    for (const r of list) {
      const m = mapAnswers(r.answers, r.email);
      const ready = ['review', 'done', 'sending', 'sent'].includes(r.status);
      const vars = { name: m.profile.name || r.name, sender: cfg.senderName };
      views.push({
        id: r.id, name: r.name, email: r.email, status: r.status, stage: r.stage || null, progress: r.progress ?? null,
        error: r.error || null, notes: r.notes || [], submittedAt: r.submittedAt, receivedAt: r.receivedAt, finishedAt: r.finishedAt || null,
        projectId: r.projectId || null, clientId: r.clientId || null,
        sizes: (r.extras || []).filter((e) => e.projectId).map((e) => ({ format: e.format, projectId: e.projectId })),
        summary: { business: m.business, businessCustom: m.businessCustom, objective: m.objective, direction: m.direction, format: m.format, formats: m.formats, seconds: m.seconds, count: m.count, voiceover: m.voiceover, deadline: m.deadline, photos: m.files.photos.length, logo: m.files.logo.length > 0, clips: m.files.clips.length },
        answers: r.answers.filter((a) => a.type !== 'FILE_UPLOAD').map((a) => ({ title: a.title, answer: asText(a.answer) })),
        videos: ready ? await requestVideos(r) : [],
        draft: r.lastEmail || { to: r.email || '', subject: fill(cfg.emailSubject, vars), message: fill(cfg.emailMessage, vars) },
        sendError: r.sendError || null, sentAt: r.sentAt || null, sentTo: r.sentTo || null, links: r.links || [],
      });
    }
    return views;
  });
}

export async function intakeStatus() {
  const cfg = await loadConfig();
  return {
    configured: formConfigured(),
    url: process.env.GOOGLE_FORM_URL || '',
    key: process.env.GOOGLE_FORM_KEY ? `${process.env.GOOGLE_FORM_KEY.slice(0, 4)}…${process.env.GOOGLE_FORM_KEY.slice(-4)}` : '',
    auto: cfg.auto, mode: cfg.mode, dailyLimit: cfg.dailyLimit, voiceover: cfg.voiceover,
    connectedAt: cfg.connectedAt, lastCheck: cfg.lastCheck, lastError: cfg.lastError, formTitle: cfg.formTitle, formUrl: cfg.formUrl,
    scriptVersion: cfg.scriptVersion, canEmail: cfg.scriptVersion >= 2, senderName: cfg.senderName, emailSubject: cfg.emailSubject, emailMessage: cfg.emailMessage, defaultMessage: DEFAULT_MESSAGE,
    checkEveryMinutes: Math.round(CHECK_EVERY_MS / 60000),
    ai: aiConfigured(), voice: voiceConfigured(),
  };
}

export async function saveIntakeOptions(b = {}) {
  const cfg = await loadConfig();
  if (typeof b.auto === 'boolean') cfg.auto = b.auto;
  if (b.mode === 'ai' || b.mode === 'auto') cfg.mode = b.mode;
  if (b.dailyLimit !== undefined) cfg.dailyLimit = Math.max(0, Math.min(100, Math.round(Number(b.dailyLimit) || 0)));
  if (typeof b.voiceover === 'boolean') cfg.voiceover = b.voiceover;
  if (typeof b.senderName === 'string') cfg.senderName = b.senderName.trim().slice(0, 60);
  if (typeof b.emailSubject === 'string') cfg.emailSubject = b.emailSubject.trim().slice(0, 150) || DEFAULTS.emailSubject;
  if (typeof b.emailMessage === 'string') cfg.emailMessage = b.emailMessage.slice(0, 5000).trim() || DEFAULT_MESSAGE;
  if (b.resetConnection) Object.assign(cfg, { since: 0, connectedAt: null, lastError: null, formTitle: '', formUrl: '' });
  await saveConfig(cfg);
}

export async function makeRequest(id) {
  const r = await withRequests((list) => {
    const x = list.find((y) => y.id === id);
    if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
    if (['queued', 'preparing', 'making', 'sending'].includes(x.status)) throw Object.assign(new Error('This request is already being made.'), { status: 409 });
    Object.assign(x, { status: 'queued', error: null });
    return x;
  });
  runQueue();
  return r;
}

/**
 * The owner approved: upload the chosen videos to their Google Drive and email
 * the client links, through their Google script. Runs in the background.
 */
export async function sendRequest(id, b = {}) {
  const cfg = await loadConfig();
  if (!formConfigured()) throw Object.assign(new Error('Connect your Google Form first.'), { status: 400 });
  if (cfg.scriptVersion < 2) throw Object.assign(new Error('Your Google script needs updating before it can email clients. See "Update your Google script" on this page.'), { status: 400 });
  const to = String(b.to || '').trim();
  if (!EMAIL_RE.test(to)) throw Object.assign(new Error('Type the client\'s email address.'), { status: 400 });
  const subject = String(b.subject || '').trim().slice(0, 150) || cfg.emailSubject;
  const message = String(b.message || '').slice(0, 5000).trim();
  if (!message) throw Object.assign(new Error('Write a message for the email.'), { status: 400 });
  const view = (await listRequests()).find((r) => r.id === id);
  if (!view) throw Object.assign(new Error('Request not found'), { status: 404 });
  if (!['review', 'done', 'sent'].includes(view.status)) throw Object.assign(new Error(view.status === 'sending' ? 'Already sending.' : 'The videos are not ready yet.'), { status: 409 });
  const keys = Array.isArray(b.videos) ? b.videos.map(String) : [];
  const chosen = view.videos.filter((v) => keys.includes(v.key));
  if (!chosen.length) throw Object.assign(new Error('Tick at least one video to send.'), { status: 400 });
  for (const v of chosen) {
    const st = await fs.stat(path.join(projectDir(v.projectId), 'ad-output', path.basename(v.file))).catch(() => null);
    if (!st) throw Object.assign(new Error(`${v.label} is missing. Make the videos again.`), { status: 400 });
    if (st.size > MAX_SEND) throw Object.assign(new Error(`${v.label} is too big to send (over 40 MB).`), { status: 400 });
  }
  const before = view.status === 'sent' ? 'sent' : 'review';
  const lastEmail = { to, subject, message };
  await patchRequest(id, { status: 'sending', stage: 'Saving the videos to your Google Drive', sendError: null, lastEmail });

  (async () => {
    try {
      const links = [];
      const base = (view.name || 'Video').replace(/[\\/:*?"<>|]+/g, '').slice(0, 50).trim() || 'Video';
      for (const [i, v] of chosen.entries()) {
        await patchRequest(id, { stage: `Saving video ${i + 1} of ${chosen.length} to your Google Drive` });
        const data = (await fs.readFile(path.join(projectDir(v.projectId), 'ad-output', path.basename(v.file)))).toString('base64');
        const up = await postScript({ action: 'upload', folder: base, name: `${base} - ${v.label.replace(/ · /g, ' ')}.mp4`, type: 'video/mp4', data });
        if (up.shared === false) throw new Error('Google Drive would not make a shareable link (your account blocks link sharing).');
        links.push({ name: v.label, url: up.url });
      }
      await patchRequest(id, { stage: `Emailing ${to}` });
      await postScript({ action: 'email', to, subject, body: message, links, senderName: cfg.senderName });
      await patchRequest(id, { status: 'sent', stage: null, sentAt: Date.now(), sentTo: to, links });
      log('info', `form request ${id}: emailed ${chosen.length} video(s) to ${to}`);
    } catch (err) {
      log('warn', `form request ${id}: send failed: ${err.message}`);
      await patchRequest(id, { status: before, stage: null, sendError: `Not sent: ${err.message}` });
    }
  })();
  return { ok: true };
}

export async function dismissRequest(id) {
  const r = await patchRequest(id, { status: 'dismissed' });
  if (!r) throw Object.assign(new Error('Request not found'), { status: 404 });
  return r;
}

/** Start the background checker. `run` starts a Cutline job (from server/index.js). */
export function startIntake(run) {
  startJob = run;
  // Requests caught mid-way by a restart go back in the queue.
  withRequests((list) => {
    for (const r of list) {
      if (r.status === 'preparing') Object.assign(r, { status: 'queued', stage: null });
      if (r.status === 'sending') Object.assign(r, { status: r.sentAt ? 'sent' : 'review', stage: null, sendError: 'Not sent: Cutline was closed while sending. Press Approve and send again.' });
    }
  }).then(() => runQueue()).catch(() => {});
  const tick = () => formConfigured() && checkNow().catch(() => {});
  setTimeout(tick, 5000).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
  // Keep request statuses current even when nobody has the page open.
  setInterval(() => listRequests().catch(() => {}), 30_000).unref();
}
