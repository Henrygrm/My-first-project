// Google Form intake, end to end, against a stand-in for the Apps Script web
// app (same JSON and chunked file downloads as integrations/google-form/Code.gs)
// and the mock Claude API. No Google account or API credit needed.
//
//   npm run test:form
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requests as claudeRequests, startMock } from './mock-anthropic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-form-'));
const PORT = 3591, FORM_PORT = 4591, MOCK_PORT = 4592;
const B = `http://127.0.0.1:${PORT}`;
const KEY = 'ab12'.repeat(16);
const results = [];
const ok = (cond, msg) => {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  console.log(results.at(-1));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- media ---------------------------------------------------------------
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);
ff('-f', 'lavfi', '-i', 'testsrc2=s=1200x1500', '-frames:v', '1', path.join(TMP, 'p1.jpg'));
ff('-f', 'lavfi', '-i', 'mandelbrot=s=1200x1500', '-frames:v', '1', path.join(TMP, 'p2.jpg'));
ff('-f', 'lavfi', '-i', 'color=c=0x1b2a4a:s=600x600', '-vf', 'drawbox=x=150:y=150:w=300:h=300:color=0xd4a017:t=fill', '-frames:v', '1', path.join(TMP, 'logo.png'));
ff('-f', 'lavfi', '-i', 'testsrc2=s=720x1280:d=3', '-pix_fmt', 'yuv420p', path.join(TMP, 'clip.mp4'));
const FILES = {};
for (const [id, name, type] of [['F1', 'p1.jpg', 'image/jpeg'], ['F2', 'p2.jpg', 'image/jpeg'], ['F3', 'logo.png', 'image/png'], ['F4', 'clip.mp4', 'video/mp4']]) {
  const bytes = await fs.readFile(path.join(TMP, name));
  FILES[id] = { id, name, type, size: bytes.length, bytes };
}
const info = (id) => ({ id, name: FILES[id].name, size: FILES[id].size, type: FILES[id].type });

// --- stand-in Apps Script web app ------------------------------------------
const form = { responses: [], key: KEY, calls: 0 };
const CHUNK = 64 * 1024; // small, so downloads take several pieces
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = Object.fromEntries(u.searchParams);
  form.calls++;
  const send = (o) => res.end(JSON.stringify(o));
  if (p.key !== form.key) return send({ error: 'The connection code is wrong. Copy it again from the Apps Script log (run setupCutline).' });
  if (p.file) {
    const r = form.responses.find((x) => x.id === p.response);
    if (!r) return send({ error: 'No response with ID ' + p.response });
    const ids = r.answers.filter((a) => a.type === 'FILE_UPLOAD').flatMap((a) => a.answer.map((f) => f.id));
    if (!ids.includes(p.file)) return send({ error: 'That file is not part of this form answer.' });
    const f = FILES[p.file];
    const off = Number(p.offset) || 0;
    const piece = f.bytes.subarray(off, off + CHUNK);
    return send({ ok: true, name: f.name, type: f.type, size: f.size, offset: off, data: piece.toString('base64'), done: off + piece.length >= f.size });
  }
  const since = Number(p.since) || 0;
  const list = form.responses.filter((r) => r.time > since).sort((a, b) => a.time - b.time);
  send({ ok: true, version: 1, form: { title: 'Video request', url: 'https://docs.google.com/forms/d/e/TEST/viewform' }, responses: list.slice(0, 20), more: list.length > 20 });
}).listen(FORM_PORT, '127.0.0.1');
await startMock(MOCK_PORT);

const T = (title, answer, type = 'TEXT') => ({ title, answer, type });
function cafeAnswers(name) {
  return [
    T('Business name', name),
    T('What type of business are you?', 'Café & coffee', 'MULTIPLE_CHOICE'),
    T('What do you sell or offer?', 'Flat whites, smashed avo, house-made banana bread', 'PARAGRAPH_TEXT'),
    T('Suburb / city', 'Glebe'),
    T('What should customers use to contact you?', '@beanthere'),
    T('What\'s the main goal of this video?', 'Promote a special offer', 'MULTIPLE_CHOICE'),
    T('Do you have an offer or deal to promote?', 'Free coffee with any breakfast'),
    T('Which product or service should this video focus on?', 'Breakfast'),
    T('What should viewers do at the end?', 'Visit us', 'MULTIPLE_CHOICE'),
    T('Where will you post this video?', ['Instagram Reels / Stories', 'Instagram / Facebook feed'], 'CHECKBOX'),
    T('How long should the video be?', '10 seconds', 'MULTIPLE_CHOICE'),
    T('What style suits your brand best?', 'Premium: sleek and classy', 'MULTIPLE_CHOICE'),
    T('What are your brand colours?', 'Navy and gold'),
    T('What kind of music do you want?', 'Chill / relaxed', 'MULTIPLE_CHOICE'),
    T('Would you like a voiceover?', 'Yes, a warm, friendly voice', 'MULTIPLE_CHOICE'),
    T('Upload your logo', [info('F3')], 'FILE_UPLOAD'),
    T('Upload photos of your products, food, work or shop', [info('F1'), info('F2')], 'FILE_UPLOAD'),
    T('Got any video clips you\'d like included?', [info('F4')], 'FILE_UPLOAD'),
    T('Paste a real customer review we can feature', 'Best coffee in Glebe! - Sam', 'PARAGRAPH_TEXT'),
    T('Is there anything we must NOT show or say?', 'Never mention prices', 'PARAGRAPH_TEXT'),
    T('When do you need the video by?', '2026-11-20', 'DATE'),
    T('How many versions would you like to choose from?', '1', 'MULTIPLE_CHOICE'),
  ];
}

// --- Cutline ---------------------------------------------------------------
let child;
async function start() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: path.join(TMP, 'data'), ENV_FILE: path.join(TMP, 'env'),
      ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', CLAUDE_MODEL: '',
      CUTLINE_FORM_ALLOW_LOCAL: '1', CUTLINE_FORM_CHECK_MS: '1500', CUTLINE_CUTOUT_MODEL: 'u2netp', CUTLINE_MODEL_DIR: process.env.CUTLINE_MODEL_DIR || path.join(TMP, 'models'),
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(B + '/api/status');
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('Cutline did not start');
}
const j = async (p, o = {}) => {
  const r = await fetch(B + p, { method: o.method || 'GET', headers: { ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const intake = async () => (await j('/api/intake')).data;
async function waitFor(fn, label, ms = 420_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

try {
  // An answer sent before Cutline is connected.
  form.responses.push({ id: 'R0', time: Date.now() - 3600_000, email: 'old@test.au', answers: [T('Business name', 'Old Request Co'), T('What do you sell or offer?', 'Things')] });
  await start();

  ok((await j('/api/intake/settings', { method: 'POST', body: { url: 'https://evil.example.com/exec', key: KEY } })).status === 400, 'non-Google URL refused');
  ok((await j('/api/intake/settings', { method: 'POST', body: { url: `http://127.0.0.1:${FORM_PORT}/exec`, key: 'not a code' } })).status === 400, 'malformed connection code refused');
  ok((await j('/api/intake/check', { method: 'POST', headers: { origin: 'https://evil.example.com' } })).status === 403, 'other websites cannot trigger a check');

  form.key = 'cd34'.repeat(16); // the Google side has a different code
  await j('/api/intake/settings', { method: 'POST', body: { url: `http://127.0.0.1:${FORM_PORT}/exec`, key: KEY } });
  let c = (await j('/api/intake/check', { method: 'POST' })).data;
  ok(!c.ok && /connection code is wrong/.test(c.message) && /wrong/.test((await intake()).lastError), `wrong code explained: "${c.message}"`);
  form.key = KEY;
  c = (await j('/api/intake/check', { method: 'POST' })).data;
  ok(c.ok && c.added === 1, `connected: ${c.message}`);
  let it = await intake();
  const r0 = it.requests.find((r) => r.name === 'Old Request Co');
  ok(r0?.status === 'waiting' && /before Cutline was connected/.test(r0.notes.join(' ')), 'answer sent before connecting waits for the owner');
  ok(it.key && !it.key.includes(KEY) && it.formUrl.includes('viewform'), 'code masked; client form link known');
  ok(/^GOOGLE_FORM_KEY=/m.test(await fs.readFile(path.join(TMP, 'env'), 'utf8')), 'connection saved in .env');

  // A full request arrives: the background check picks it up and makes everything.
  form.responses.push({ id: 'R1', time: Date.now(), email: 'hello@beanthere.au', answers: cafeAnswers('Bean There Café') });
  const t0 = Date.now();
  const r1 = await waitFor(async () => (await intake()).requests.find((r) => r.name === 'Bean There Café' && ['done', 'error'].includes(r.status)), 'request 1');
  ok(r1.status === 'done', `request made automatically in ${Math.round((Date.now() - t0) / 1000)}s (${r1.status}${r1.error ? ': ' + r1.error : ''})`);
  ok(r1.notes.some((n) => /voiceover/i.test(n) && /OpenAI/.test(n)), 'voiceover asked for without an OpenAI key is explained');
  ok(r1.summary.formats.join() === '9:16,4:5' && r1.sizes.length === 1 && r1.sizes[0].format === '4:5', 'second size (4:5 feed) made as its own project');

  const p1 = (await j(`/api/projects/${r1.projectId}`)).data;
  const photos = p1.adAssets.filter((a) => a.kind === 'photo');
  ok(photos.length === 2 && p1.adAssets.some((a) => a.kind === 'logo') && p1.videos.length === 1, `project has their 2 photos, logo and clip (${photos.length}, ${p1.videos.length})`);
  ok(p1.adPlan?.source === 'ai' && p1.adPlan.seconds === 10 && p1.adPlan.format === '9:16' && p1.adPlan.ads.length === 1, 'AI plan: 10s, vertical, 1 version');
  ok(p1.adPlan.ads[0].direction === 'premium', `chosen style kept (${p1.adPlan.ads[0].direction})`);
  ok(p1.adRenders.filter(Boolean).length === 1, 'video rendered');
  const file = p1.adRenders[0]?.file;
  ok(file && (await fs.stat(path.join(TMP, 'data', 'projects', p1.id, 'ad-output', file))).size > 50_000, 'MP4 on disk');
  ok(p1.request?.deadline === '2026-11-20' && p1.request.email === 'hello@beanthere.au', 'deadline and email kept on the project');
  const asked = claudeRequests.map((r) => JSON.stringify(r.body)).find((b) => b.includes('Never show or say'));
  ok(Boolean(asked) && asked.includes('Never mention prices') && asked.includes('Visit us') && asked.includes('Free coffee with any breakfast'), 'client wishes and offer passed to the AI director');

  const p1b = (await j(`/api/projects/${r1.sizes[0].projectId}`)).data;
  ok(p1b.adPlan.format === '4:5' && p1b.adRenders.filter(Boolean).length === 1 && /Instagram|feed/i.test(p1b.name), `feed size rendered from the same storyboard ("${p1b.name}")`);
  ok(JSON.stringify(p1b.adPlan.ads[0].scenes.map((s) => s.headline)) === JSON.stringify(p1.adPlan.ads[0].scenes.map((s) => s.headline)), 'same scenes in both sizes (no second AI plan)');

  const clients = (await j('/api/clients')).data;
  const cl = (await j(`/api/clients/${r1.clientId}`)).data;
  ok(clients.length === 1 && cl.email === 'hello@beanthere.au' && cl.media.length === 2 && cl.logo, 'client saved with email, logo and photos');
  ok(cl.brand.colors[0] === '#1b2a4a' && cl.brand.colors[1] === '#d4a017' && cl.brand.direction === 'premium', `brand colours from "Navy and gold" (${cl.brand.colors})`);
  ok(cl.business === 'cafe' && cl.profile.location === 'Glebe' && cl.profile.review.startsWith('Best coffee'), 'business details saved');

  // Same client again (same email, name typed differently), free engine this time.
  await j('/api/intake/settings', { method: 'POST', body: { mode: 'auto' } });
  form.responses.push({ id: 'R2', time: Date.now(), email: 'hello@beanthere.au', answers: [T('Business name', 'bean there cafe'), T('What do you sell or offer?', 'Coffee'), T('How long should the video be?', 'Not sure, you decide'), T('How many versions would you like to choose from?', '1')] });
  const r2 = await waitFor(async () => (await intake()).requests.find((r) => r.name === 'bean there cafe' && ['done', 'error'].includes(r.status)), 'request 2');
  ok(r2.status === 'done' && r2.clientId === r1.clientId && (await j('/api/clients')).data.length === 1, 'returning client recognised (no duplicate)');
  const p2 = (await j(`/api/projects/${r2.projectId}`)).data;
  ok(p2.adPlan.source === 'auto' && p2.adPlan.seconds === 15, 'free engine used; "not sure" length → 15s');
  ok(p2.adAssets.filter((a) => a.kind === 'photo').length === 2 && p2.adAssets.some((a) => a.kind === 'logo'), 'no new photos sent → their saved photos and logo used');
  ok(p2.adPlan.ads[0].direction === 'premium' || p2.brand.direction === 'premium', 'saved style reused');

  // Daily limit and manual actions.
  await j('/api/intake/settings', { method: 'POST', body: { dailyLimit: 2 } });
  form.responses.push({ id: 'R3', time: Date.now(), email: 'x@spam.test', answers: [T('Business name', 'Spammy'), T('What do you sell or offer?', 'Stuff')] });
  await j('/api/intake/check', { method: 'POST' });
  const r3 = (await intake()).requests.find((r) => r.name === 'Spammy');
  ok(r3?.status === 'waiting' && /limit of 2/.test(r3.notes.join(' ')), 'daily limit holds extra requests for the owner');
  ok((await j(`/api/intake/requests/${r3.id}/dismiss`, { method: 'POST' })).data.status === 'dismissed', 'request dismissed');
  ok((await j('/api/intake/requests/nope/make', { method: 'POST' })).status === 404, 'unknown request → 404');
  await j('/api/intake/check', { method: 'POST' });
  ok((await intake()).requests.length === 4, 'no duplicates after repeated checks');

  // Restart: requests and connection survive.
  child.kill();
  await sleep(500);
  await start();
  it = await intake();
  ok(it.configured && it.requests.length === 4 && it.requests.find((r) => r.id === r1.id).sizes.length === 1, 'requests, links and connection survive a restart');
  const gs = await fetch(B + '/api/intake/script');
  ok((await gs.text()).includes('function setupCutline'), 'the Google script can be copied from Cutline');
  await j('/api/intake/settings', { method: 'POST', body: { url: '', key: '' } });
  ok(!(await intake()).configured, 'disconnect works');
} catch (err) {
  ok(false, err.message);
} finally {
  child?.kill();
}
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
