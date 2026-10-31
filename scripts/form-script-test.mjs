// The Google Apps Script (integrations/google-form/Code.gs) run against fake
// Google services: setup, code check, listing, chunked and restricted downloads.
// Runs integrations/google-form/Code.gs against fake Google services.
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(process.argv[2] || new URL('../integrations/google-form/Code.gs', import.meta.url), 'utf8');
const props = {};
const logs = [];
const items = [];
const files = { f1: { name: 'logo.png', type: 'image/png', bytes: [...Buffer.from('LOGO-BYTES')] }, f2: { name: 'big.mov', type: 'video/quicktime', bytes: Array.from({ length: 12 * 1024 * 1024 }, (_, i) => i % 256 - 128) }, secret: { name: 'tax.pdf', type: 'application/pdf', bytes: [1, 2, 3] } };
const item = (title, type) => {
  const it = { title, type, setRequired() { return it; }, setChoiceValues(v) { it.choices = v; return it; }, showOtherOption() { return it; }, setHelpText() { return it; }, setTitle(t) { it.title = t; return it; }, getTitle: () => it.title, getType: () => ({ toString: () => type }) };
  items.push(it);
  return it;
};
const mkResp = (id, t, answers) => ({ getId: () => id, getTimestamp: () => new Date(t), getRespondentEmail: () => 'owner@cafe.test',
  getItemResponses: () => answers.map(([title, type, a]) => ({ getItem: () => ({ getTitle: () => title, getType: () => ({ toString: () => type }) }), getResponse: () => a })) });
const responses = [
  mkResp('R2', 2000, [['Business name', 'TEXT', 'Bean There'], ['Upload your logo', 'FILE_UPLOAD', ['f1']], ['Got any video clips you\'d like included?', 'FILE_UPLOAD', ['f2']]]),
  mkResp('R1', 1000, [['Business name', 'TEXT', 'Old Co'], ['Where will you post this video?', 'CHECKBOX', ['TikTok', 'YouTube / website']]]),
];
const form = {
  getId: () => 'FORM1', getEditUrl: () => 'https://docs.google.com/forms/d/FORM1/edit', getPublishedUrl: () => 'https://docs.google.com/forms/d/e/X/viewform', getTitle: () => 'Video request',
  setDescription() {}, setCollectEmail() {},
  getResponses: (d) => responses.filter((r) => !d || r.getTimestamp() > d),
  getResponse: (id) => { const r = responses.find((x) => x.getId() === id); if (!r) throw new Error('No response with ID ' + id); return r; },
};
for (const [m, t] of Object.entries({ addSectionHeaderItem: 'SECTION_HEADER', addTextItem: 'TEXT', addMultipleChoiceItem: 'MULTIPLE_CHOICE', addParagraphTextItem: 'PARAGRAPH_TEXT', addPageBreakItem: 'PAGE_BREAK', addCheckboxItem: 'CHECKBOX', addDateItem: 'DATE' })) form[m] = () => item('', t);
let created = 0;
let active = null;
// Gmail stand-in: threads of messages; drafts send into them.
const gmail = { threads: {}, n: 0 };
const mkMsg = (threadId, from, text, at, subject = 'Your video') => {
  const id = `m${++gmail.n}`;
  const m = {
    id, from, text, at, subject, threadId, replyTarget: null, opts: null,
    getId: () => id, getFrom: () => from, getDate: () => new Date(at), getSubject: () => subject, getPlainBody: () => text,
    getThread: () => thread(threadId),
    createDraftReply: (body, opts) => ({ send: () => { const r = mkMsg(threadId, 'Owner <owner@studio.test>', body, Date.now(), opts.subject); r.opts = opts; r.replyTarget = id; return r; } }),
  };
  (gmail.threads[threadId] ||= []).push(m);
  return m;
};
const thread = (tid) => ({ getId: () => tid, getMessages: () => gmail.threads[tid] || [] });
const drive = { folders: {}, files: [], sent: [] };
const folder = (path) => ({
  getFoldersByName: (n) => { const k = `${path}/${n}`; let done = !drive.folders[k]; return { hasNext: () => !done, next: () => { done = true; return folder(k); } }; },
  createFolder: (n) => { drive.folders[`${path}/${n}`] = true; return folder(`${path}/${n}`); },
  createFile: (blob) => { const f = { path, ...blob, id: `D${drive.files.length + 1}`, sharing: null }; drive.files.push(f); return { getId: () => f.id, getUrl: () => `https://drive.google.com/file/d/${f.id}/view`, setSharing: (a, p) => { f.sharing = [a, p]; } }; },
});
const ctx = {
  FormApp: { create: () => { created++; return form; }, openById: (id) => { if (id !== 'FORM1') throw new Error('bad'); return form; }, openByUrl: () => form, getActiveForm: () => active },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'Owner@Studio.test' }) },
  GmailApp: {
    createDraft: (to, subject, text, opts) => ({ send: () => { const m = mkMsg(`t${Object.keys(gmail.threads).length + 1}`, 'Owner <owner@studio.test>', text, Date.now(), subject); m.to = to; m.opts = opts; return m; } }),
    getThreadById: (id) => (gmail.threads[id] ? thread(id) : null),
    search: (q) => { const from = (q.match(/from:(\S+)/) || [])[1]; return Object.keys(gmail.threads).filter((t) => gmail.threads[t].some((m) => m.from.includes(from))).map(thread); },
  },
  MailApp: { sendEmail: (o) => drive.sent.push(o), getRemainingDailyQuota: () => 99 },
  DriveApp: { Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' }, getRootFolder: () => folder(''), getFileById: (id) => { const f = files[id]; if (!f) throw new Error('no file'); return { getName: () => f.name, getSize: () => f.bytes.length, getMimeType: () => f.type, getBlob: () => ({ getBytes: () => f.bytes }) }; } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(), base64Encode: (b) => Buffer.from(b.map((x) => x & 255)).toString('base64'),
    base64Decode: (s) => [...Buffer.from(s, 'base64')].map((x) => (x > 127 ? x - 256 : x)),
    newBlob: (bytes, type, name) => ({ bytes, type, name }),
    formatDate: (d) => d.toISOString().slice(0, 10).replace(/-/g, '/'),
  },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
  Logger: { log: (s) => logs.push(s) },
};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const call = (p) => JSON.parse(ctx.doGet({ parameter: p }).text);
const out = [];
const ok = (c, m) => out.push(`${c ? 'PASS' : 'FAIL'} ${m}`);

ok(call({ key: 'x' }).error, 'refuses before setup');
let threw = '';
try { ctx.setupCutline(); } catch (err) { threw = err.message; }
ok(/No form found/.test(threw) && !props.CUTLINE_KEY, 'setup without a form explains how to attach it (never creates one)');
active = form; // opened from inside the owner's form
ctx.setupCutline();
ok(created === 0 && props.FORM_ID === 'FORM1' && /^[a-f0-9]{64}$/.test(props.CUTLINE_KEY), 'setup attaches to the existing form and makes a 64-char code');
ok(logs[0].includes(props.CUTLINE_KEY) && logs[0].includes('viewform') && logs[0].includes('owner@studio.test'), 'log shows code, client link and Gmail account');
const key1 = props.CUTLINE_KEY;
ctx.setupCutline();
ok(created === 0 && props.CUTLINE_KEY === key1 && items.length === 0, 'running setup again keeps the code; the form is never changed');
ok(call({ key: 'wrong' }).error, 'wrong code refused');
const list = call({ key: props.CUTLINE_KEY });
ok(list.ok && list.responses.length === 2 && list.responses[0].id === 'R1', 'lists answers oldest first');
ok(list.responses[1].answers[1].answer[0].name === 'logo.png' && list.responses[1].email === 'owner@cafe.test', 'file details and email included');
ok(call({ key: props.CUTLINE_KEY, since: 1500 }).responses.length === 1, 'since filter');
const p = call({ key: props.CUTLINE_KEY, response: 'R2', file: 'f1' });
ok(p.ok && Buffer.from(p.data, 'base64').toString() === 'LOGO-BYTES' && p.done, 'small file in one piece');
let got = 0, off = 0, pieces = 0;
for (;;) { const q = call({ key: props.CUTLINE_KEY, response: 'R2', file: 'f2', offset: off }); got += Buffer.from(q.data, 'base64').length; off = got; pieces++; if (q.done) break; }
ok(got === 12 * 1024 * 1024 && pieces === 3, `big file in ${pieces} pieces`);
ok(call({ key: props.CUTLINE_KEY, response: 'R2', file: 'secret' }).error, 'other Drive files refused');
ok(call({ key: props.CUTLINE_KEY, response: 'R1', file: 'f1' }).error, 'file from another answer refused');
ok(call({ key: props.CUTLINE_KEY, response: 'nope', file: 'f1' }).error, 'unknown response → error, not crash');

// Saving approved videos to Drive and emailing the client (doPost).
const post = (b) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(b) } }).text);
const K = props.CUTLINE_KEY;
ok(post({ key: 'wrong', action: 'email', to: 'a@b.co' }).error && !drive.sent.length, 'POST with the wrong code refused');
const up = post({ key: K, action: 'upload', folder: 'Bean There', name: 'Bean There - Version 1.mp4', type: 'video/mp4', data: Buffer.from('MP4DATA').toString('base64') });
const f = drive.files[0];
ok(up.ok && up.shared && f.path === '/Cutline videos/Bean There' && f.name.endsWith('.mp4') && Buffer.from(f.bytes.map((x) => x & 255)).toString() === 'MP4DATA', 'video saved to Drive › Cutline videos › client');
ok(f.sharing?.[0] === 'ANYONE_WITH_LINK' && f.sharing[1] === 'VIEW' && up.url.includes(f.id), 'shared as view-only link');
post({ key: K, action: 'upload', folder: 'Bean There', name: 'v2.mp4', data: 'AA==' });
ok(Object.keys(drive.folders).length === 2, 'folders reused, not duplicated');
ok(post({ key: K, action: 'email', to: 'not an email', body: 'x' }).error && !drive.sent.length, 'bad address refused');
const em = post({ key: K, action: 'email', to: 'hello@bean.au', subject: 'Your video', senderName: 'Henry', body: 'Hi <Bean>,\n\n{links}\n\nThanks', links: [{ name: 'Version 1', url: up.url }, { name: 'Bad', url: 'javascript:alert(1)' }] });
const m = drive.sent[0];
ok(em.ok && m.to === 'hello@bean.au' && m.subject === 'Your video' && m.name === 'Henry', 'email sent with subject and sender name');
ok(m.body.includes(`Version 1: ${up.url}`) && !m.body.includes('{links}') && !m.body.includes('javascript'), 'plain text has the link; unsafe links dropped');
ok(m.htmlBody.includes(`href="${up.url}"`) && m.htmlBody.includes('&lt;Bean&gt;') && !m.htmlBody.includes('<Bean>'), 'HTML has a button and escapes text');
ok(post({ key: K, action: 'nope' }).error, 'unknown action refused');
const info = call({ key: K });
ok(info.version === 3 && info.account === 'owner@studio.test' && info.form.editUrl.includes('/edit'), 'reports version 3, Gmail account and form edit link');

// Gmail: send (idempotent), reply in the conversation, read replies.
const s1 = post({ key: K, action: 'send', ref: 'em1', to: 'maria@luna.test', subject: 'Your New Business Video Is Ready!', body: 'Hi Maria,\n\n{video_link}\n\nThanks', senderName: 'Bright Frame', links: [{ name: 'Watch your video', url: 'https://drive.google.com/file/d/D1/view' }], attachments: [{ name: 'Invoice INV-0001.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.3').toString('base64') }] });
const m1 = gmail.threads[s1.threadId]?.[0];
ok(s1.ok && m1 && m1.to === 'maria@luna.test' && m1.opts.name === 'Bright Frame' && m1.opts.htmlBody.includes('#2563eb') && m1.text.includes('Watch your video: https://drive.google.com') && !m1.text.includes('{video_link}'), 'email sent from Gmail with a watch button');
ok(m1.opts.attachments[0].name === 'Invoice INV-0001.pdf' && Buffer.from(m1.opts.attachments[0].bytes.map((x) => x & 255)).toString() === '%PDF-1.3', 'invoice PDF attached');
const again = post({ key: K, action: 'send', ref: 'em1', to: 'maria@luna.test', subject: 'x', body: 'x', links: [] });
ok(again.duplicate && again.threadId === s1.threadId && gmail.threads[s1.threadId].length === 1, 'the same email is never sent twice');
mkMsg(s1.threadId, 'Maria <maria@luna.test>', 'Can you show more pasta?', Date.now() + 1000, 'Re: Your New Business Video Is Ready!');
const s2 = post({ key: K, action: 'send', ref: 'em2', to: 'maria@luna.test', subject: 'Your updated video', body: 'Done! {video_link}', threadId: s1.threadId, links: [{ name: 'Watch', url: 'https://drive.google.com/file/d/D2/view' }] });
const reply = gmail.threads[s1.threadId].at(-1);
ok(s2.threadId === s1.threadId && reply.replyTarget === gmail.threads[s1.threadId][1].id, 'revision email replies to the client in the same conversation');
mkMsg('t-other', 'maria@luna.test', 'Also, new email: love it', Date.now() + 2000, 'Hi again');
const inbox = post({ key: K, action: 'inbox', items: [{ ref: 'cp1', threadId: s1.threadId, from: 'maria@luna.test', after: Date.now() - 5000 }] });
const texts = inbox.messages.map((m) => m.text);
ok(texts.includes('Can you show more pasta?') && texts.includes('Also, new email: love it') && !inbox.messages.some((m) => /owner@studio/.test(m.from)) && inbox.messages.every((m) => m.ref === 'cp1'), 'client replies found (in the thread and as new emails), own emails skipped');
ok(post({ key: K, action: 'inbox', items: [{ ref: 'cp1', threadId: s1.threadId, from: 'maria@luna.test', after: Date.now() + 10_000 }] }).messages.length === 0, 'only messages newer than the last check');
ok(post({ key: K, action: 'send', ref: 'em3', to: 'bad address', body: 'x' }).error, 'bad recipient refused');
console.log(out.join('\n'));
process.exit(out.some((x) => x.startsWith('FAIL')) ? 1 : 0);
