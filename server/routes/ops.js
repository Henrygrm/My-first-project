// Routes for the client workflow: onboarding, client projects, approval
// centre, emails, revisions, invoices, business settings and the dashboard.
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { DATA_DIR } from '../lib/store.js';
import { saveSettings } from '../lib/settings.js';
import { intakeStatus, saveIntakeOptions, SCRIPT_FILE, validFormUrl } from '../lib/intake.js';
import * as cp from '../lib/cprojects.js';
import { editInvoice, getInvoice, invoicePdf, listInvoices, markPaid, markUnpaid, unvoidInvoice, voidInvoice } from '../lib/invoices.js';
import { businessGaps, getBusiness, LOGO_FILE, saveBusiness, setLogo } from '../lib/business.js';
import { listActivity } from '../lib/activity.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const localOnly = (what) => (req, res, next) => (isLocal(req) ? next() : next(Object.assign(new Error(`${what} can only be done on the computer running Cutline.`), { status: 403 })));

export function registerOps(app) {
  // Client resources and video versions (never the project records themselves).
  const files = express.static(cp.CP_DIR, { dotfiles: 'deny', index: false, fallthrough: false });
  app.use('/cp-files', (req, res, next) => (/^\/[a-z0-9-]{4,40}\/(resources|versions\/v\d+)\/[\w.-]+$/.test(req.path) ? files(req, res, next) : res.status(404).end()));

  // --- dashboard + activity ---------------------------------------------------
  app.get('/api/ops/dashboard', wrap(async (req, res) => {
    const [d, activity, intake, invoices, b] = await Promise.all([cp.dashboard(), listActivity({ limit: 30 }), intakeStatus(), listInvoices(), getBusiness()]);
    const open = invoices.filter((i) => i.status === 'issued');
    res.json({
      ...d, activity, intake: { configured: intake.configured, lastCheck: intake.lastCheck, lastError: intake.lastError, gmailReady: intake.gmailReady, scriptOutdated: intake.scriptOutdated, formUrl: intake.formUrl },
      invoices: { outstanding: open.length, outstandingTotal: open.reduce((s, i) => s + i.total, 0), paid: invoices.filter((i) => i.status === 'paid').length, paidTotal: invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + i.total, 0), currency: b.currency },
      setupGaps: businessGaps(b),
    });
  }));
  app.get('/api/activity', wrap(async (req, res) => res.json(await listActivity({ limit: Math.min(200, Number(req.query.limit) || 50), cpId: req.query.cp || null }))));
  app.get('/api/ops/counts', wrap(async (req, res) => {
    const all = cp.allCps();
    const n = (fn) => all.filter(fn).length;
    res.json({
      onboarding: n((c) => ['submitted', 'collecting', 'ready_for_review'].includes(c.stage)),
      approval: n((c) => c.stage === 'video_review'),
      pending: n((c) => ['email_review'].includes(c.stage)),
      revisions: n((c) => ['revision_requested', 'needs_attention'].includes(c.stage)),
      failed: n((c) => c.stage === 'failed'),
    });
  }));

  // --- Google connection (onboarding) -----------------------------------------
  app.get('/api/intake', wrap(async (req, res) => res.json({ ...(await intakeStatus()), editable: isLocal(req) })));
  app.post('/api/intake/settings', localOnly('Changing the Google connection'), wrap(async (req, res) => {
    const b = req.body || {};
    const updates = {};
    if (typeof b.url === 'string') {
      const url = b.url.trim();
      if (url && !validFormUrl(url)) throw Object.assign(new Error('That is not an Apps Script Web app URL. It should start with https://script.google.com/macros/s/ and end with /exec.'), { status: 400 });
      updates.GOOGLE_FORM_URL = url;
    }
    if (typeof b.key === 'string') {
      const key = b.key.trim();
      if (key && !/^[a-f0-9]{32,80}$/i.test(key)) throw Object.assign(new Error('That connection code does not look right. Copy the long code from the Apps Script log.'), { status: 400 });
      updates.GOOGLE_FORM_KEY = key;
    }
    const prevUrl = process.env.GOOGLE_FORM_URL || '';
    if (Object.keys(updates).length) await saveSettings(updates);
    // A different script (or disconnecting) starts the connection afresh; submissions already here stay.
    await saveIntakeOptions({ ...b, resetConnection: updates.GOOGLE_FORM_URL !== undefined && updates.GOOGLE_FORM_URL !== prevUrl });
    res.json(await intakeStatus());
  }));
  app.post('/api/intake/check', wrap(async (req, res) => res.json(await cp.checkNow())));
  app.get('/api/intake/script', wrap(async (req, res) => {
    res.type('text/plain').set('Content-Disposition', req.query.download ? 'attachment; filename="Cutline-Google.gs"' : 'inline').send(await fs.readFile(SCRIPT_FILE, 'utf8'));
  }));

  // --- client projects ----------------------------------------------------------
  app.get('/api/cprojects', wrap(async (req, res) => res.json(await cp.listView())));
  app.get('/api/cprojects/:id', wrap(async (req, res) => res.json({ ...(await cp.detail(req.params.id)), activity: await listActivity({ limit: 100, cpId: req.params.id }) })));
  const act = (name, fn) => app.post(`/api/cprojects/:id/${name}`, wrap(async (req, res) => {
    await fn(req.params.id, req.body || {}, req);
    res.json(await cp.detail(req.params.id));
  }));
  act('approve-production', (id) => cp.approveProduction(id));
  act('dismiss', (id, b) => cp.dismissSubmission(id, String(b.reason || '').slice(0, 200)));
  act('restore', (id) => cp.restoreSubmission(id));
  act('retry', (id) => cp.retry(id));
  act('approve-video', (id, b) => cp.approveVideo(id, { videos: b.videos }));
  act('changes', (id, b) => cp.requestInternalChanges(id, { instructions: b.instructions, adIndex: Number.isInteger(b.adIndex) ? b.adIndex : null }));
  act('regenerate', (id) => cp.regenerateVideo(id));
  act('use-editor', (id) => cp.useEditorVersion(id));
  act('revise', (id, b) => cp.startRevision(id, { instructions: b.instructions }));
  act('decline', (id, b) => cp.declineProject(id, { reason: String(b.reason || '') }));
  act('undo-decline', (id) => cp.undoDecline(id));
  act('complete', (id) => cp.completeProject(id));
  act('archive', (id, b) => cp.setArchived(id, b.archived !== false));
  act('notes', (id, b) => cp.addNote(id, b.text));
  app.post('/api/cprojects/:id/feedback/:fid', wrap(async (req, res) => {
    await cp.resolveFeedback(req.params.id, req.params.fid, String(req.body?.decision || ''));
    res.json(await cp.detail(req.params.id));
  }));

  // --- emails (sending needs an explicit Approve & Send) -------------------------
  app.patch('/api/cprojects/:id/emails/:eid', wrap(async (req, res) => {
    await cp.editEmail(req.params.id, req.params.eid, req.body || {});
    res.json({ ok: true });
  }));
  app.post('/api/cprojects/:id/emails/:eid/send', localOnly('Sending email'), wrap(async (req, res) => {
    if (req.body?.approved !== true) throw Object.assign(new Error('Sending needs your approval (Approve & Send).'), { status: 400 });
    await cp.approveAndSend(req.params.id, req.params.eid);
    res.json({ ok: true });
  }));
  app.post('/api/cprojects/:id/emails/:eid/discard', wrap(async (req, res) => {
    await cp.discardEmail(req.params.id, req.params.eid);
    res.json({ ok: true });
  }));
  app.get('/api/approvals', wrap(async (req, res) => res.json(await cp.approvalQueue())));
  app.get('/api/emails/pending', wrap(async (req, res) => res.json(await cp.pendingEmails())));
  app.get('/api/emails/sent', wrap(async (req, res) => res.json(await cp.sentEmails())));
  app.post('/api/emails/check-inbox', wrap(async (req, res) => res.json(await cp.checkInbox())));
  app.get('/api/revisions', wrap(async (req, res) => res.json(await cp.revisionsView())));

  // --- invoices -------------------------------------------------------------------
  app.get('/api/invoices', wrap(async (req, res) => res.json(await listInvoices())));
  app.get('/api/invoices/:id', wrap(async (req, res) => {
    const inv = await getInvoice(req.params.id);
    if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
    res.json(inv);
  }));
  app.get('/api/invoices/:id/pdf', wrap(async (req, res) => {
    const inv = await getInvoice(req.params.id);
    if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
    res.type('application/pdf').set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="Invoice ${inv.number}.pdf"`).send(await invoicePdf(inv.id));
  }));
  const invAct = (name, fn, text) => app.post(`/api/invoices/:id/${name}`, wrap(async (req, res) => {
    const inv = await fn(req.params.id, req.body || {});
    if (inv.cpId && cp.getCp(inv.cpId)) await cp.updateCp(inv.cpId, (c) => c.history.push({ t: Date.now(), type: 'invoice', text: `Invoice ${inv.number} ${text(inv, req.body || {})}` }));
    res.json(inv);
  }));
  invAct('paid', (id) => markPaid(id), () => 'marked as paid');
  invAct('unpaid', (id) => markUnpaid(id), () => 'marked as not paid');
  invAct('void', (id, b) => voidInvoice(id, String(b.reason || 'Cancelled')), (i, b) => `voided${b.reason ? `: ${b.reason}` : ''} (no charge)`);
  invAct('unvoid', (id) => unvoidInvoice(id), () => 'restored');
  app.patch('/api/invoices/:id', wrap(async (req, res) => res.json(await editInvoice(req.params.id, req.body || {}))));

  // --- business details, pricing, templates ------------------------------------------
  app.get('/api/business', wrap(async (req, res) => {
    const b = await getBusiness();
    res.json({ ...b, logoUrl: b.hasLogo ? `/api/business/logo?v=${b.logoRev || 0}` : null, gaps: businessGaps(b), editable: isLocal(req) });
  }));
  app.post('/api/business', localOnly('Changing business settings'), wrap(async (req, res) => {
    await saveBusiness(req.body || {});
    const b = await getBusiness();
    res.json({ ...b, logoUrl: b.hasLogo ? '/api/business/logo' : null, gaps: businessGaps(b) });
  }));
  const logoUpload = multer({ dest: path.join(DATA_DIR, 'tmp'), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  app.post('/api/business/logo', localOnly('Changing business settings'), logoUpload.single('logo'), wrap(async (req, res) => {
    if (!req.file) throw Object.assign(new Error('Choose an image.'), { status: 400 });
    try {
      // Normalise to PNG (any image format the canvas can read), max 800px.
      const img = await loadImage(await fs.readFile(req.file.path));
      const k = Math.min(1, 800 / Math.max(img.width, img.height));
      const c = createCanvas(Math.round(img.width * k), Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      await fs.writeFile(LOGO_FILE, await c.encode('png'));
    } catch {
      throw Object.assign(new Error('That file could not be read as an image. Use a PNG or JPG.'), { status: 400 });
    } finally {
      await fs.rm(req.file.path, { force: true });
    }
    await setLogo(true);
    res.json({ ok: true, logoUrl: `/api/business/logo?v=${Date.now()}` });
  }));
  app.delete('/api/business/logo', localOnly('Changing business settings'), wrap(async (req, res) => {
    await fs.rm(LOGO_FILE, { force: true });
    await setLogo(false);
    res.json({ ok: true });
  }));
  app.get('/api/business/logo', (req, res) => res.sendFile(LOGO_FILE, (err) => err && res.status(404).end()));
}
