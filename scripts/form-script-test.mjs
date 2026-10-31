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
const drive = { folders: {}, files: [], sent: [] };
const folder = (path) => ({
  getFoldersByName: (n) => { const k = `${path}/${n}`; let done = !drive.folders[k]; return { hasNext: () => !done, next: () => { done = true; return folder(k); } }; },
  createFolder: (n) => { drive.folders[`${path}/${n}`] = true; return folder(`${path}/${n}`); },
  createFile: (blob) => { const f = { path, ...blob, id: `D${drive.files.length + 1}`, sharing: null }; drive.files.push(f); return { getId: () => f.id, getUrl: () => `https://drive.google.com/file/d/${f.id}/view`, setSharing: (a, p) => { f.sharing = [a, p]; } }; },
});
const ctx = {
  FormApp: { create: () => { created++; return form; }, openById: (id) => { if (id !== 'FORM1') throw new Error('bad'); return form; }, openByUrl: () => form, getActiveForm: () => null },
  MailApp: { sendEmail: (o) => drive.sent.push(o), getRemainingDailyQuota: () => 99 },
  DriveApp: { Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' }, getRootFolder: () => folder(''), getFileById: (id) => { const f = files[id]; if (!f) throw new Error('no file'); return { getName: () => f.name, getSize: () => f.bytes.length, getMimeType: () => f.type, getBlob: () => ({ getBytes: () => f.bytes }) }; } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(), base64Encode: (b) => Buffer.from(b.map((x) => x & 255)).toString('base64'),
    base64Decode: (s) => [...Buffer.from(s, 'base64')].map((x) => (x > 127 ? x - 256 : x)),
    newBlob: (bytes, type, name) => ({ bytes, type, name }),
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
ctx.setupCutline();
ok(created === 1 && props.FORM_ID === 'FORM1' && /^[a-f0-9]{64}$/.test(props.CUTLINE_KEY), 'setup makes the form and a 64-char code');
ok(logs[0].includes(props.CUTLINE_KEY) && logs[0].includes('viewform'), 'log shows code and client link');
const titles = items.map((i) => i.title).filter(Boolean);
ok(titles.length >= 26, `form has ${titles.length} titled items`);
ctx.setupCutline();
ok(created === 1, 'running setup again reuses the form and code');
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
ok(call({ key: K }).version === 2, 'reports version 2 (can email)');
console.log(out.join('\n'));
process.exit(out.some((x) => x.startsWith('FAIL')) ? 1 : 0);
