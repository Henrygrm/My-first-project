// The whole client workflow, end to end, against a stand-in for the Google
// Apps Script (form answers, file downloads, Drive uploads, Gmail sending and
// replies; same JSON as integrations/google-form/Code.gs) and the mock Claude
// API. No Google account or API credit needed.
//
//   npm run test:workflow
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requests as claudeRequests, startMock } from './mock-anthropic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-flow-'));
const PORT = 3593, GOOGLE_PORT = 4593, MOCK_PORT = 4594;
const B = `http://127.0.0.1:${PORT}`;
const KEY = 'ab12'.repeat(16);
const results = [];
const ok = (cond, msg) => {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  console.log(results.at(-1));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- client media -----------------------------------------------------------------
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);
ff('-f', 'lavfi', '-i', 'testsrc2=s=1200x1500', '-frames:v', '1', path.join(TMP, 'dish.jpg'));
ff('-f', 'lavfi', '-i', 'mandelbrot=s=1200x1500', '-frames:v', '1', path.join(TMP, 'plate.jpg'));
ff('-f', 'lavfi', '-i', 'color=c=0x7a1f2b:s=600x600', '-vf', 'drawbox=x=150:y=150:w=300:h=300:color=0xfcbf49:t=fill', '-frames:v', '1', path.join(TMP, 'logo.png'));
ff('-f', 'lavfi', '-i', 'testsrc2=s=720x1280:d=3', '-pix_fmt', 'yuv420p', path.join(TMP, 'cooking.mp4'));
const FILES = {};
for (const [id, name, type] of [['F1', 'dish.jpg', 'image/jpeg'], ['F2', 'plate.jpg', 'image/jpeg'], ['F3', 'logo.png', 'image/png'], ['F4', 'cooking.mp4', 'video/mp4']]) {
  const bytes = await fs.readFile(path.join(TMP, name));
  FILES[id] = { id, name, type, size: bytes.length, bytes };
}
const info = (id) => ({ id, name: FILES[id].name, size: FILES[id].size, type: FILES[id].type });

// --- stand-in Google (Apps Script web app v3) --------------------------------------
const G = { responses: [], uploads: [], sent: [], threads: {}, inbox: [], refs: {}, version: 3, failSend: false };
http.createServer(async (req, res) => {
  const send = (o) => res.end(JSON.stringify(o));
  if (req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    if (b.key !== KEY) return send({ error: 'The connection code is wrong.' });
    if (b.action === 'upload') {
      G.uploads.push({ name: b.name, folder: b.folder, bytes: Buffer.from(b.data, 'base64').length });
      return send({ ok: true, id: `D${G.uploads.length}`, url: `https://drive.google.com/file/d/D${G.uploads.length}/view`, shared: true });
    }
    if (b.action === 'send') {
      if (G.refs[b.ref]) return send({ ...G.refs[b.ref], duplicate: true });
      if (G.failSend) return send({ error: 'Service invoked too many times for one day: email.' });
      const threadId = b.threadId && G.threads[b.threadId] ? b.threadId : `T${Object.keys(G.threads).length + 1}`;
      G.threads[threadId] = G.threads[threadId] || [];
      const msg = { id: `M${G.sent.length + 1}`, ...b, threadId, at: Date.now() };
      G.threads[threadId].push(msg);
      G.sent.push(msg);
      G.refs[b.ref] = { ok: true, threadId, messageId: msg.id, from: 'owner@studio.test' };
      return send(G.refs[b.ref]);
    }
    if (b.action === 'inbox') {
      const messages = [];
      for (const it of b.items) {
        for (const m of G.inbox) if ((m.threadId === it.threadId || m.fromAddr === it.from) && m.date > it.after) messages.push({ ref: it.ref, id: m.id, threadId: m.threadId, from: m.from, date: m.date, subject: m.subject, text: m.text });
      }
      return send({ ok: true, messages, account: 'owner@studio.test' });
    }
    return send({ error: 'Unknown action' });
  }
  const p = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  if (p.key !== KEY) return send({ error: 'The connection code is wrong.' });
  if (p.file) {
    const r = G.responses.find((x) => x.id === p.response);
    const ids = r ? r.answers.filter((a) => a.type === 'FILE_UPLOAD').flatMap((a) => a.answer.map((f) => f.id)) : [];
    if (!ids.includes(p.file)) return send({ error: 'That file is not part of this form answer.' });
    const f = FILES[p.file], off = Number(p.offset) || 0, piece = f.bytes.subarray(off, off + 64 * 1024);
    return send({ ok: true, name: f.name, type: f.type, size: f.size, offset: off, data: piece.toString('base64'), done: off + piece.length >= f.size });
  }
  const since = Number(p.since) || 0;
  const list = G.responses.filter((r) => r.time > since).sort((a, b) => a.time - b.time);
  send({ ok: true, version: G.version, account: 'owner@studio.test', form: { title: 'Client video brief', url: 'https://docs.google.com/forms/d/e/BRIEF/viewform', editUrl: 'https://docs.google.com/forms/d/BRIEF/edit' }, responses: list.slice(0, 20), more: list.length > 20 });
}).listen(GOOGLE_PORT, '127.0.0.1');
await startMock(MOCK_PORT);

const T = (title, answer, type = 'TEXT') => ({ title, answer, type });
const restaurant = (name, email, contact) => [
  T('Business name', name), T('Your name', contact), T('Email address', email),
  T('What type of business are you?', 'Restaurant', 'MULTIPLE_CHOICE'),
  T('What do you sell or offer?', 'Wood-fired pizza, handmade pasta, natural wine', 'PARAGRAPH_TEXT'),
  T('Tell us about your business', 'Family-run Italian kitchen. Menu: margherita, nduja, cacio e pepe, tiramisu.', 'PARAGRAPH_TEXT'),
  T('Who are your customers?', 'Local families and date-night couples'),
  T('Suburb / city', 'Newtown'),
  T('What\'s the main goal of this video?', 'Get more bookings / orders', 'MULTIPLE_CHOICE'),
  T('Which product or service should this video focus on?', 'Wood-fired pizza'),
  T('Where will you post this video?', ['Instagram Reels / Stories', 'Instagram / Facebook feed'], 'CHECKBOX'),
  T('How long should the video be?', '10 seconds', 'MULTIPLE_CHOICE'),
  T('Is there anything we must NOT show or say?', 'No prices on screen', 'PARAGRAPH_TEXT'),
  T('How many versions would you like to choose from?', '1', 'MULTIPLE_CHOICE'),
  T('Upload your logo', [info('F3')], 'FILE_UPLOAD'),
  T('Upload photos of your food', [info('F1'), info('F2')], 'FILE_UPLOAD'),
  T('Upload cooking footage', [info('F4')], 'FILE_UPLOAD'),
];

// --- Cutline ------------------------------------------------------------------------
let child;
async function start() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: path.join(TMP, 'data'), ENV_FILE: path.join(TMP, 'env'),
      ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', CLAUDE_MODEL: '',
      CUTLINE_FORM_ALLOW_LOCAL: '1', CUTLINE_FORM_CHECK_MS: '2000', CUTLINE_CUTOUT_MODEL: 'u2netp', CUTLINE_MODEL_DIR: process.env.CUTLINE_MODEL_DIR || path.join(TMP, 'models'),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
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
const project = async (id) => (await j(`/api/cprojects/${id}`)).data;
async function waitStage(id, stages, label, ms = 420_000) {
  const end = Date.now() + ms;
  let p;
  while (Date.now() < end) {
    p = await project(id);
    if (stages.includes(p?.stage)) return p;
    if (p?.stage === 'failed' && !stages.includes('failed')) throw new Error(`${label}: failed: ${p.error}`);
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for ${label} (stage ${p?.stage})`);
}
const findByName = async (name) => (await j('/api/cprojects')).data.find((c) => c.name === name);

try {
  await start();
  // 0. My business details and price (Settings).
  await j('/api/business', { method: 'POST', body: { name: 'Bright Frame Studio', email: 'owner@studio.test', abn: '12 345 678 901', price: 30, paymentDetails: 'BSB 062-000  Account 1234 5678', taxMode: 'inclusive', taxRate: 10, paymentTerms: 7 } });
  const biz = (await j('/api/business')).data;
  ok(biz.name === 'Bright Frame Studio' && biz.price === 30 && biz.gaps.length === 0, 'business details and price saved');

  // Connect the existing form (Client Onboarding).
  ok((await j('/api/intake/settings', { method: 'POST', body: { url: 'https://evil.example.com/exec', key: KEY } })).status === 400, 'non-Google script URL refused');
  await j('/api/intake/settings', { method: 'POST', body: { url: `http://127.0.0.1:${GOOGLE_PORT}/exec`, key: KEY } });
  const conn = (await j('/api/intake/check', { method: 'POST' })).data;
  const st = (await j('/api/intake')).data;
  ok(conn.ok && st.formUrl.includes('viewform') && st.formEditUrl.includes('edit') && st.gmail === 'owner@studio.test' && st.gmailReady, `connected: "${conn.message}" (Gmail ${st.gmail})`);

  // 1–3. A business completes the form; it appears automatically, resources collected.
  G.responses.push({ id: 'R1', time: Date.now(), email: 'maria@lunapizza.test', answers: restaurant('Luna Pizzeria', 'maria@lunapizza.test', 'Maria Rossi') });
  G.responses.push({ id: 'R1', time: Date.now(), email: 'maria@lunapizza.test', answers: restaurant('Luna Pizzeria', 'maria@lunapizza.test', 'Maria Rossi') }); // duplicate delivery
  let luna;
  for (let i = 0; i < 40 && !luna; i++) {
    luna = await findByName('Luna Pizzeria');
    if (!luna) await sleep(1000);
  }
  ok(Boolean(luna) && /^CP-\d{4}$/.test(luna.number), `submission appeared automatically as ${luna?.number}`);
  let p = await waitStage(luna.id, ['ready_for_review'], 'resources');
  ok((await j('/api/cprojects')).data.filter((c) => c.name === 'Luna Pizzeria').length === 1, 'duplicate submission ignored');
  ok(p.resources.photos.length === 2 && p.resources.clips.length === 1 && p.resources.logo, 'photos, cooking footage and logo collected');
  ok(p.contact.name === 'Maria Rossi' && p.contact.email === 'maria@lunapizza.test' && p.requirements.profile.audience.includes('families'), 'contact details and audience understood');
  ok(p.production === null && p.versions.length === 0, 'nothing produced before I approve');
  const clip = await fetch(B + p.resources.clips[0].url);
  ok(clip.status === 200 && (await clip.arrayBuffer()).byteLength === FILES.F4.size, 'uploaded footage available in the project');
  ok((await fetch(`${B}/cp-files/${luna.id}/project.json`)).status === 404, 'project records are not served as files');

  // 4–5. I approve production; the AI makes a personalised video.
  const before = claudeRequests.length;
  await j(`/api/cprojects/${luna.id}/approve-production`, { method: 'POST' });
  p = await waitStage(luna.id, ['video_review'], 'first video');
  const brief = claudeRequests.slice(before).map((r) => JSON.stringify(r.body)).find((b) => b.includes('Wood-fired pizza'));
  ok(Boolean(brief) && brief.includes('No prices on screen') && brief.includes('Local families') && brief.includes('Family-run Italian kitchen'), 'AI director received the business, audience, menu and requirements');
  ok(p.versions.length === 1 && p.versions[0].videos.length === 2 && p.versions[0].videos.map((v) => v.format).join() === '9:16,4:5', 'version 1: vertical + feed videos');
  ok(Boolean(p.versions[0].description), 'AI description of the video stored');
  const pr = (await j(`/api/projects/${p.production.projectId}`)).data;
  ok(pr.videos.length === 1 && pr.adAssets.filter((a) => a.kind === 'photo').length === 2 && pr.adAssets.some((a) => a.kind === 'logo'), 'editing project uses their footage, photos and logo');
  const approvals = (await j('/api/approvals')).data;
  ok(approvals.some((a) => a.id === luna.id && a.current?.n === 1), 'video appears in the Video Approval Centre');

  // Internal changes, then regenerate: each a new version; history kept.
  await j(`/api/cprojects/${luna.id}/changes`, { method: 'POST', body: { instructions: 'Open on the pizza coming out of the oven and make the logo bigger at the end' } });
  p = await waitStage(luna.id, ['video_review'], 'internal changes');
  ok(p.versions.length === 2 && p.versions[0].reason === 'Your changes', 'internal changes → version 2');
  await j(`/api/cprojects/${luna.id}/regenerate`, { method: 'POST' });
  await sleep(500);
  p = await waitStage(luna.id, ['video_review'], 'regenerate');
  ok(p.versions.length === 3 && p.versions[0].reason === 'Regenerated', 'regenerate → version 3');
  ok((await fetch(B + p.versions[2].videos[0].url)).status === 200, 'version 1 still playable');

  // 6–7. I approve the video; email + invoice prepared, NOT sent.
  ok(G.sent.length === 0, 'nothing emailed yet');
  await j(`/api/cprojects/${luna.id}/approve-video`, { method: 'POST', body: { videos: p.versions[0].videos.map((v) => v.key) } });
  p = await project(luna.id);
  let pending = (await j('/api/emails/pending')).data.find((e) => e.cpId === luna.id);
  ok(p.stage === 'email_review' && pending, 'email waiting in Pending Emails');
  ok(pending.email.to === 'maria@lunapizza.test' && pending.email.subject === 'Your New Business Video Is Ready!' && pending.email.body.startsWith('Hi Maria,') && pending.email.body.includes('Luna Pizzeria') && pending.email.body.includes('Bright Frame Studio') && pending.email.body.includes('no charge'), 'personalised email (name, business, my business, no-charge promise)');
  const inv = pending.invoice;
  ok(inv && inv.number === 'INV-0001' && inv.total === 30 && inv.status === 'draft' && inv.client.business === 'Luna Pizzeria', `invoice ${inv?.number} prepared ($${inv?.total}, draft)`);
  const pdf = await fetch(`${B}/api/invoices/${inv.id}/pdf`);
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  ok(pdf.headers.get('content-type') === 'application/pdf' && pdfBytes.subarray(0, 4).toString() === '%PDF' && pdfBytes.length > 1500, 'invoice PDF downloads');

  // 8. Review, edit, Approve & Send.
  await j(`/api/cprojects/${luna.id}/emails/${pending.email.id}`, { method: 'PATCH', body: { subject: 'Your new Luna Pizzeria video is ready!' } });
  ok((await j(`/api/cprojects/${luna.id}/emails/${pending.email.id}/send`, { method: 'POST', body: {} })).status === 400, 'sending without the explicit approval flag refused');
  ok((await j(`/api/cprojects/${luna.id}/emails/${pending.email.id}/send`, { method: 'POST', body: { approved: true }, headers: { origin: 'https://evil.example.com' } })).status === 403, 'other websites cannot send');
  G.failSend = true;
  await j(`/api/cprojects/${luna.id}/emails/${pending.email.id}/send`, { method: 'POST', body: { approved: true } });
  p = await waitStage(luna.id, ['email_review'], 'failed send');
  pending = (await j('/api/emails/pending')).data.find((e) => e.cpId === luna.id);
  ok(pending.email.status === 'failed' && /too many times/.test(pending.email.error), 'Gmail failure reported, email kept for retry');
  G.failSend = false;
  await j(`/api/cprojects/${luna.id}/emails/${pending.email.id}/send`, { method: 'POST', body: { approved: true } });
  p = await waitStage(luna.id, ['sent'], 'send');
  const mail = G.sent.at(-1);
  ok(G.sent.length === 1 && mail.to === 'maria@lunapizza.test' && mail.subject === 'Your new Luna Pizzeria video is ready!' && mail.links.length === 2 && mail.links.every((l) => l.url.startsWith('https://drive.google.com/')), '9. client email sent through Gmail with both video links');
  ok(mail.attachments.length === 1 && mail.attachments[0].name === 'Invoice INV-0001.pdf' && Buffer.from(mail.attachments[0].data, 'base64').subarray(0, 4).toString() === '%PDF', 'invoice PDF attached');
  ok(G.uploads.length === 2, 'videos uploaded once (the failed attempt did not duplicate them)');
  ok((await j(`/api/invoices/${inv.id}`)).data.status === 'issued', 'invoice marked issued (not paid)');
  ok((await j(`/api/cprojects/${luna.id}/emails/${pending.email.id}/send`, { method: 'POST', body: { approved: true } })).status === 409, 'the same email cannot be sent twice');

  // 10–11. The client replies asking for changes; matched to the project.
  G.inbox.push({ id: 'IN1', threadId: mail.threadId, fromAddr: 'maria@lunapizza.test', from: 'Maria Rossi <maria@lunapizza.test>', date: Date.now() + 1000, subject: 'Re: Your new Luna Pizzeria video is ready!', text: 'Hi! Love the style. Could you show more of the pasta and swap the music for something calmer?\n\nThanks, Maria\n\nOn Mon, 3 Nov 2026 at 10:00, Bright Frame Studio <owner@studio.test> wrote:\n> Hi Maria,\n> We\'ve finished creating your video' });
  await j('/api/intake/check', { method: 'POST' });
  p = await waitStage(luna.id, ['revision_requested'], 'reply');
  ok(p.feedback.length === 1 && p.feedback[0].intent === 'revision' && !p.feedback[0].text.includes('finished creating'), '10–11. reply recognised as a change request on the right project (quoted text removed)');
  ok((await j('/api/revisions')).data.some((r) => r.id === luna.id), 'project listed in Client Revisions');

  // 12–14. My instructions → revised video → back in the approval centre.
  const b2 = claudeRequests.length;
  await j(`/api/cprojects/${luna.id}/revise`, { method: 'POST', body: { instructions: 'Replace the opening with the cooking footage and make the pasta shots more prominent.' } });
  p = await waitStage(luna.id, ['video_review'], 'revision');
  const revReq = claudeRequests.slice(b2).map((r) => JSON.stringify(r.body)).find((b) => b.includes('REVISION FOR THE CLIENT'));
  ok(Boolean(revReq) && revReq.includes('more of the pasta') && revReq.includes('cooking footage') && revReq.includes('No prices on screen'), 'AI received the client feedback, my instructions and the original brief');
  ok(p.versions.length === 4 && p.versions[0].reason === 'Client revision' && p.versions[1].sentAt, '14. revised video is version 4; earlier versions kept');

  // 15. Approve the new video and its email (same conversation).
  await j(`/api/cprojects/${luna.id}/approve-video`, { method: 'POST', body: {} });
  pending = (await j('/api/emails/pending')).data.find((e) => e.cpId === luna.id);
  ok(pending.email.kind === 'revision' && pending.email.threadId === mail.threadId && pending.email.subject.includes('updated video') && pending.invoice.id === inv.id, 'revision email prepared in the same conversation, same invoice');
  ok(G.sent.length === 1, 'revision email not sent before approval');
  await j(`/api/cprojects/${luna.id}/emails/${pending.email.id}/send`, { method: 'POST', body: { approved: true } });
  p = await waitStage(luna.id, ['sent'], 'revision send');
  ok(G.sent.length === 2 && G.sent[1].threadId === mail.threadId, '15. revision email sent in the existing Gmail conversation');
  G.inbox.push({ id: 'IN2', threadId: mail.threadId, fromAddr: 'maria@lunapizza.test', from: 'Maria <maria@lunapizza.test>', date: Date.now() + 2000, subject: 'Re: updated', text: 'Perfect, love it! Thank you.' });
  await j('/api/intake/check', { method: 'POST' });
  p = await waitStage(luna.id, ['completed'], 'accepted');
  ok(p.stage === 'completed', 'happy reply → project completed');
  ok((await j(`/api/invoices/${inv.id}/paid`, { method: 'POST' })).data.status === 'paid', 'I mark the invoice paid myself');

  // 16. Another client declines: project declined, invoice voided (no charge).
  await j('/api/intake/settings', { method: 'POST', body: { mode: 'auto' } });
  G.responses.push({ id: 'R2', time: Date.now(), email: 'sam@sparkle.test', answers: [T('Business name', 'Sparkle Detailing'), T('Your name', 'Sam'), T('What type of business are you?', 'Car detailing'), T('What do you sell or offer?', 'Ceramic coating'), T('How long should the video be?', '10 seconds'), T('How many versions would you like to choose from?', '1')] });
  await j('/api/intake/check', { method: 'POST' });
  const sp = await findByName('Sparkle Detailing');
  await waitStage(sp.id, ['ready_for_review'], 'sparkle resources');
  await j(`/api/cprojects/${sp.id}/approve-production`, { method: 'POST' });
  p = await waitStage(sp.id, ['video_review'], 'sparkle video');
  // A change the free engine can't make: no fake new version, and the reason is shown.
  await j(`/api/cprojects/${sp.id}/changes`, { method: 'POST', body: { instructions: 'Make the reflections on the bonnet more realistic' } });
  await sleep(300);
  p = await waitStage(sp.id, ['video_review'], 'no-change request');
  ok(p.versions.length === 1 && p.lastNoChange?.reply, `request the engine can't act on → no new version, reason shown ("${p.lastNoChange?.reply?.slice(0, 60)}…")`);
  await j(`/api/cprojects/${sp.id}/approve-video`, { method: 'POST', body: {} });
  pending = (await j('/api/emails/pending')).data.find((e) => e.cpId === sp.id);
  ok(pending.email.body.startsWith('Hi Sam,') && pending.invoice.number === 'INV-0002', 'second client: email + INV-0002 prepared');
  await j(`/api/cprojects/${sp.id}/emails/${pending.email.id}/send`, { method: 'POST', body: { approved: true } });
  await waitStage(sp.id, ['sent'], 'sparkle send');
  const thread2 = G.sent.at(-1).threadId;
  G.inbox.push({ id: 'IN3', threadId: thread2, fromAddr: 'sam@sparkle.test', from: 'sam@sparkle.test', date: Date.now() + 1000, subject: 'Re', text: 'Hmm, not sure yet. Let me talk to my partner.' });
  await j('/api/intake/check', { method: 'POST' });
  p = await waitStage(sp.id, ['needs_attention'], 'unclear');
  ok(p.feedback[0].intent === 'unclear', 'unclear reply flagged for my review, no decision made');
  G.inbox.push({ id: 'IN4', threadId: thread2, fromAddr: 'sam@sparkle.test', from: 'sam@sparkle.test', date: Date.now() + 3000, subject: 'Re', text: 'Thanks, but we have decided we don\'t want it. No thanks.' });
  await j('/api/intake/check', { method: 'POST' });
  p = await waitStage(sp.id, ['declined'], 'decline');
  const inv2 = (await j(`/api/invoices/${pending.invoice.id}`)).data;
  ok(p.archived && p.declined && inv2.status === 'void' && /declined/i.test(inv2.voidReason), '16. decline → project declined + archived, invoice voided (no charge)');
  ok((await j(`/api/invoices/${inv2.id}/paid`, { method: 'POST' })).status === 409, 'a voided invoice cannot be marked paid');
  const vpdf = await fetch(`${B}/api/invoices/${inv2.id}/pdf`);
  ok(vpdf.status === 200, 'voided invoice PDF still available (marked void)');

  // Dashboard, activity, history.
  const dash = (await j('/api/ops/dashboard')).data;
  ok(dash.stats.completed === 1 && dash.stats.declined === 1 && dash.stats.emailsSent === 3 && dash.stats.clients === 2, `dashboard counts (completed ${dash.stats.completed}, declined ${dash.stats.declined}, emails ${dash.stats.emailsSent}, clients ${dash.stats.clients})`);
  const types = new Set(dash.activity.map((a) => a.type));
  ok(['submission', 'video_ready', 'email_pending', 'email_sent', 'revision', 'declined'].every((t) => types.has(t)), 'activity feed has every step');
  p = await project(luna.id);
  ok(p.history.length >= 10 && p.activity.length >= 10, `project history recorded (${p.history.length} events)`);

  // Restart: everything persists; no duplicate processing.
  child.kill();
  await sleep(600);
  await start();
  await j('/api/intake/check', { method: 'POST' });
  p = await project(luna.id);
  ok(p.stage === 'completed' && p.versions.length === 4 && p.feedback.length === 2 && (await j('/api/cprojects')).data.length === 2, 'state survives a restart with no duplicates');
} catch (err) {
  ok(false, err.stack || err.message);
} finally {
  child?.kill();
}
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
