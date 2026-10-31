/**
 * Cutline ← Google Form connector.
 *
 * What it does:
 *  - setupCutline() connects your existing Google Form and creates a secret
 *    connection code. It never changes your form or its questions.
 *  - Once deployed as a web app, Cutline (on your Mac) asks this script for new
 *    form answers every couple of minutes, using that code. Nobody without the
 *    code can read anything.
 *  - When you approve a client's videos in Cutline, it sends them here: they are
 *    saved in your Google Drive ("Cutline videos" folder) and emailed to the
 *    client from your Gmail with watch/download links and the invoice.
 *    Nothing is emailed unless you click Approve & Send in Cutline.
 *  - Cutline also asks it for client replies to those emails (feedback,
 *    change requests), only within those conversations / from those clients.
 *
 * Setup (Cutline's Client Onboarding page walks you through it):
 *  1. Open your form → ⋮ menu → Apps Script → delete what's there → paste this file.
 *  2. Pick "setupCutline" in the bar at the top → Run → allow access.
 *  3. Follow the steps printed in the Execution log.
 */

// Easiest: open this script from inside your form (form ⋮ menu → Apps Script)
// and leave this empty. Or paste your form's edit link between the quotes.
const EXISTING_FORM_URL = '';

const CHUNK = 5 * 1024 * 1024; // bytes per download piece
const MAX_FILE = 50 * 1024 * 1024; // bigger uploads stay in Google Drive
const MAX_RESPONSES = 20; // per check; Cutline asks again for the rest
const SCRIPT_VERSION = 3; // 2: Drive + email; 3: Gmail conversations, invoices, replies

function setupCutline() {
  const props = PropertiesService.getScriptProperties();
  let form = null;
  if (EXISTING_FORM_URL) form = FormApp.openByUrl(EXISTING_FORM_URL);
  if (!form) {
    try { form = FormApp.getActiveForm(); } catch (err) {}
  }
  if (!form && props.getProperty('FORM_ID')) form = FormApp.openById(props.getProperty('FORM_ID'));
  if (!form) throw new Error('No form found. Open this script from your form (in the form: ⋮ menu → Apps Script), or paste your form\'s edit link into EXISTING_FORM_URL at the top, then run setupCutline again.');
  props.setProperty('FORM_ID', form.getId());
  let key = props.getProperty('CUTLINE_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('CUTLINE_KEY', key);
  }
  Logger.log([
    '',
    '===== CUTLINE SETUP =====',
    'Connected to your form: ' + form.getTitle(),
    'Link you send to clients: ' + form.getPublishedUrl(),
    'Gmail account used for client emails: ' + myEmail_(),
    '',
    'YOUR CONNECTION CODE (paste into Cutline): ' + key,
    '',
    'Next:',
    '1. Deploy → New deployment → gear icon → Web app.',
    '   Execute as: Me.   Who has access: Anyone.   Click Deploy and copy the Web app URL.',
    '   (Updating later? Deploy → Manage deployments → pencil → Version: New version → Deploy. The URL stays the same.)',
    '2. In Cutline → Client Onboarding: paste the Web app URL and the connection code, click Save, then Check now.',
    '=========================',
  ].join('\n'));
}

/** Called by Cutline. Every request must carry the connection code. */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const key = PropertiesService.getScriptProperties().getProperty('CUTLINE_KEY');
    if (!key || p.key !== key) return out_({ error: 'The connection code is wrong. Copy it again from the Apps Script log (run setupCutline).' });
    const form = form_();
    if (p.file) return out_(filePiece_(form, p.response, p.file, Number(p.offset) || 0));
    const since = Number(p.since) || 0;
    const all = since ? form.getResponses(new Date(since)) : form.getResponses();
    all.sort(function (a, b) { return a.getTimestamp().getTime() - b.getTimestamp().getTime(); });
    return out_({
      ok: true,
      version: SCRIPT_VERSION,
      form: { title: form.getTitle(), url: form.getPublishedUrl(), editUrl: form.getEditUrl() },
      account: myEmail_(),
      responses: all.slice(0, MAX_RESPONSES).map(response_),
      more: all.length > MAX_RESPONSES,
    });
  } catch (err) {
    return out_({ error: String((err && err.message) || err) });
  }
}

/** Called by Cutline after you approve videos: save to Drive, then email the client. */
function doPost(e) {
  try {
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const key = PropertiesService.getScriptProperties().getProperty('CUTLINE_KEY');
    if (!key || b.key !== key) return out_({ error: 'The connection code is wrong. Copy it again from the Apps Script log (run setupCutline).' });
    if (b.action === 'upload') return out_(upload_(b));
    if (b.action === 'email') return out_(email_(b));
    if (b.action === 'send') return out_(send_(b));
    if (b.action === 'inbox') return out_(inbox_(b));
    return out_({ error: 'Unknown action' });
  } catch (err) {
    return out_({ error: String((err && err.message) || err) });
  }
}

function folderNamed_(parent, name) {
  const found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}

function upload_(b) {
  const root = folderNamed_(DriveApp.getRootFolder(), 'Cutline videos');
  const folder = b.folder ? folderNamed_(root, String(b.folder).slice(0, 80)) : root;
  const blob = Utilities.newBlob(Utilities.base64Decode(String(b.data || '')), String(b.type || 'video/mp4'), String(b.name || 'video.mp4').slice(0, 120));
  const file = folder.createFile(blob);
  let shared = true;
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    shared = false; // some work accounts don't allow link sharing
  }
  return { ok: true, id: file.getId(), url: file.getUrl(), shared: shared };
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function email_(b) {
  const to = String(b.to || '').trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return { error: 'That email address does not look right.' };
  const links = (b.links || []).map(function (l) { return { name: String(l.name || 'Video'), url: String(l.url || '') }; })
    .filter(function (l) { return /^https:\/\//.test(l.url); });
  let body = String(b.body || '');
  if (body.indexOf('{links}') < 0) body += '\n\n{links}';
  const parts = body.split('{links}');
  const text = parts.join(links.map(function (l) { return l.name + ': ' + l.url; }).join('\n'));
  const buttons = links.map(function (l) {
    return '<p style="margin:10px 0"><a href="' + esc_(l.url) + '" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-weight:600">&#9654; ' + esc_(l.name) + '</a></p>';
  }).join('');
  const html = '<div style="font:15px/1.5 Arial,sans-serif;color:#222">' +
    parts.map(function (p) { return esc_(p).replace(/\n/g, '<br>'); }).join(buttons) + '</div>';
  const opts = { to: to, subject: String(b.subject || 'Your video is ready').slice(0, 150), body: text, htmlBody: html };
  if (b.senderName) opts.name = String(b.senderName).slice(0, 60);
  MailApp.sendEmail(opts);
  return { ok: true, remaining: MailApp.getRemainingDailyQuota() };
}

function myEmail_() {
  try { return String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (err) { return ''; }
}

/** Plain text + HTML versions of a message; {video_link} becomes the video buttons. */
function compose_(body, links) {
  let b = String(body || '').replace(/\{links\}/g, '{video_link}');
  if (b.indexOf('{video_link}') < 0) b += '\n\n{video_link}';
  const parts = b.split('{video_link}');
  const text = parts.join(links.map(function (l) { return l.name + ': ' + l.url; }).join('\n'));
  const buttons = links.map(function (l) {
    return '<p style="margin:12px 0"><a href="' + esc_(l.url) + '" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600">&#9654;&nbsp; ' + esc_(l.name) + '</a></p>';
  }).join('');
  const html = '<div style="font:15px/1.6 Arial,Helvetica,sans-serif;color:#1f2937;max-width:600px">' +
    parts.map(function (p) { return esc_(p).replace(/\n/g, '<br>'); }).join(buttons) + '</div>';
  return { text: text, html: html };
}

/**
 * Send an approved email from your Gmail. With threadId it replies in that
 * conversation. Each email has a ref, so a retry never sends it twice.
 */
function send_(b) {
  const props = PropertiesService.getScriptProperties();
  const ref = String(b.ref || '');
  if (ref) {
    const prev = props.getProperty('sent_' + ref);
    if (prev) { const r = JSON.parse(prev); r.duplicate = true; return r; }
  }
  const to = String(b.to || '').trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return { error: 'That email address does not look right.' };
  const links = (b.links || []).map(function (l) { return { name: String(l.name || 'Video'), url: String(l.url || '') }; })
    .filter(function (l) { return /^https:\/\//.test(l.url); });
  const msg = compose_(b.body, links);
  const opts = { htmlBody: msg.html, attachments: (b.attachments || []).map(function (a) {
    return Utilities.newBlob(Utilities.base64Decode(String(a.data || '')), String(a.type || 'application/pdf'), String(a.name || 'file').slice(0, 120));
  }) };
  if (b.senderName) opts.name = String(b.senderName).slice(0, 60);
  const subject = String(b.subject || 'Your video is ready').slice(0, 150);
  let sent = null;
  if (b.threadId) {
    let thread = null;
    try { thread = GmailApp.getThreadById(String(b.threadId)); } catch (err) {}
    if (thread) {
      const me = myEmail_();
      const msgs = thread.getMessages();
      for (let i = msgs.length - 1; i >= 0 && !sent; i--) {
        if (!me || msgs[i].getFrom().toLowerCase().indexOf(me) < 0) {
          opts.subject = subject;
          sent = msgs[i].createDraftReply(msg.text, opts).send();
        }
      }
    }
  }
  if (!sent) sent = GmailApp.createDraft(to, subject, msg.text, opts).send();
  const result = { ok: true, threadId: sent.getThread().getId(), messageId: sent.getId(), from: myEmail_() };
  if (ref) props.setProperty('sent_' + ref, JSON.stringify(result));
  return result;
}

/** New messages from clients in their conversations (or from their address). */
function inbox_(b) {
  const me = myEmail_();
  const out = [];
  (b.items || []).slice(0, 60).forEach(function (it) {
    const after = Number(it.after) || 0;
    const seen = {};
    const msgs = [];
    if (it.threadId) {
      try { const t = GmailApp.getThreadById(String(it.threadId)); if (t) t.getMessages().forEach(function (m) { msgs.push(m); }); } catch (err) {}
    }
    if (it.from && /^[^\s@"]+@[^\s@"]+$/.test(String(it.from))) {
      const q = 'from:' + it.from + ' after:' + Utilities.formatDate(new Date(after - 86400000), 'UTC', 'yyyy/MM/dd');
      GmailApp.search(q, 0, 10).forEach(function (t) { t.getMessages().forEach(function (m) { msgs.push(m); }); });
    }
    msgs.forEach(function (m) {
      const id = m.getId();
      if (seen[id]) return;
      seen[id] = true;
      const from = String(m.getFrom() || '');
      if (me && from.toLowerCase().indexOf(me) >= 0) return;
      const t = m.getDate().getTime();
      if (t <= after) return;
      out.push({ ref: it.ref, id: id, threadId: m.getThread().getId(), from: from, date: t, subject: m.getSubject(), text: String(m.getPlainBody() || '').slice(0, 8000) });
    });
  });
  return { ok: true, messages: out, account: me };
}

function form_() {
  const id = PropertiesService.getScriptProperties().getProperty('FORM_ID');
  if (id) return FormApp.openById(id);
  let active = null;
  try { active = FormApp.getActiveForm(); } catch (err) {}
  if (active) return active;
  throw new Error('No form is linked yet. Run setupCutline in Apps Script first.');
}

function response_(r) {
  let email = '';
  try { email = r.getRespondentEmail() || ''; } catch (err) {}
  return {
    id: r.getId(),
    time: r.getTimestamp().getTime(),
    email: email,
    answers: r.getItemResponses().map(function (ir) {
      const item = ir.getItem();
      const type = String(item.getType());
      let answer = ir.getResponse();
      if (type === 'FILE_UPLOAD') answer = (answer || []).map(fileInfo_);
      return { title: item.getTitle(), type: type, answer: answer };
    }),
  };
}

function fileInfo_(id) {
  try {
    const f = DriveApp.getFileById(id);
    return { id: id, name: f.getName(), size: f.getSize(), type: f.getMimeType() };
  } catch (err) {
    return { id: id, name: '', size: 0, type: '', error: String((err && err.message) || err) };
  }
}

/** One piece of an uploaded file, only if it belongs to that form answer. */
function filePiece_(form, responseId, fileId, offset) {
  const r = form.getResponse(String(responseId || ''));
  const ids = [];
  r.getItemResponses().forEach(function (ir) {
    if (String(ir.getItem().getType()) === 'FILE_UPLOAD') (ir.getResponse() || []).forEach(function (x) { ids.push(x); });
  });
  if (ids.indexOf(fileId) < 0) return { error: 'That file is not part of this form answer.' };
  const f = DriveApp.getFileById(fileId);
  const size = f.getSize();
  if (size > MAX_FILE) return { error: 'File is too big to fetch automatically.', size: size };
  const bytes = f.getBlob().getBytes();
  const piece = bytes.slice(offset, offset + CHUNK);
  return {
    ok: true, name: f.getName(), type: f.getMimeType(), size: size, offset: offset,
    data: Utilities.base64Encode(piece), done: offset + piece.length >= size,
  };
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
