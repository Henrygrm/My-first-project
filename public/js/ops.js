// The client workflow pages: Dashboard, Client Onboarding, Client Projects,
// Video Approval Centre, Email Management, Pending Emails, Client Revisions,
// Invoice Management and the business part of Settings.
import { $, $$, api, copyText, h, icon, timeAgo, toast } from './ui.js';

let hooks = { openProjectInEditor: async () => {}, refreshStatus: async () => {} };
let current = { nav: null, sub: null, extra: null };
let timer = null;
const drafts = {}; // unsaved text the owner is typing, by key

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const TONES = {
  submitted: 'blue', collecting: 'blue', ready_for_review: 'amber', producing: 'purple', video_review: 'amber', email_review: 'amber', sending: 'blue',
  sent: 'blue', revision_requested: 'amber', needs_attention: 'red', completed: 'green', declined: 'grey', failed: 'red', dismissed: 'grey',
};
const INV_TONES = { draft: 'grey', issued: 'blue', paid: 'green', void: 'red' };
const INV_LABELS = { draft: 'Draft', issued: 'Sent · unpaid', paid: 'Paid', void: 'Void (no charge)' };
const INTENT = { revision: ['Change request', 'amber'], declined: ['Declined', 'red'], accepted: ['Happy', 'green'], question: ['Question', 'blue'], unclear: ['Unclear', 'red'] };
const SIZE = { '9:16': 'Vertical', '4:5': 'Feed', '1:1': 'Square', '16:9': 'Landscape' };

/** replaceChildren that skips empty (null/false) parts. */
const fill = (root, ...kids) => root.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const pill = (text, tone = 'grey') => h('span', { class: `status s-${tone}` }, text);
const stagePill = (p) => pill(p.stageLabel || p.stage, TONES[p.stage] || 'grey');
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fmtDateTime = (t) => (t ? new Date(t).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const ago = (t) => (t ? timeAgo(new Date(t).toISOString()) : '');
function money(n, cur = 'AUD') {
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: cur }).format(Number(n) || 0);
  } catch {
    return `$${(Number(n) || 0).toFixed(2)}`;
  }
}
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const avatar = (p, cls = '') => h('div', { class: `avatar ${cls}`, style: p.logo ? { backgroundImage: `url("${p.logo}")`, color: 'transparent' } : {} }, initials(p.name));
const go = (hash) => {
  location.hash = hash;
};
const cardHead = (title, ...right) => h('div', { class: 'card-head' }, typeof title === 'string' ? h('h3', {}, title) : title, right.length ? h('div', { class: 'row' }, ...right) : null);
const emptyState = (ic, title, text, ...actions) => h('div', { class: 'empty-state' }, icon(ic), h('b', {}, title), text ? h('p', {}, text) : null, actions.length ? h('div', { class: 'row' }, ...actions) : null);
const btn = (label, onclick, { cls = '', ic = null, title = null, disabled = false } = {}) => h('button', { class: `btn ${cls}`, type: 'button', onclick, title, disabled }, ic ? icon(ic) : null, label);

/** Call the API with a busy button and a toast on failure. */
async function run(button, fn, okMsg) {
  if (button) button.disabled = true;
  try {
    const out = await fn();
    if (okMsg) toast(okMsg);
    return out;
  } catch (err) {
    toast(err.message, { error: true });
    return null;
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}
const post = (path, body = {}) => api(path, { method: 'POST', body });

/** A text field whose value survives re-renders (kept in drafts[key]). */
function draftField(key, el, initial = '') {
  el.value = drafts[key] ?? initial;
  el.addEventListener('input', () => (drafts[key] = el.value));
  return el;
}

/** Re-render a page every few seconds, but never while typing or watching a video. */
function schedule(fn, fast) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const busy = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.closest('.page:not([hidden])');
    const playing = [...$$('.page:not([hidden]) video')].some((v) => !v.paused);
    if (busy || playing || document.querySelector('.page:not([hidden]) details[data-keep][open]')) return schedule(fn, fast);
    fn();
  }, fast ? 3000 : 20000);
}

function videoEl(v, extra = {}) {
  return h('video', { src: v.url, poster: v.thumbUrl || null, controls: true, playsinline: true, preload: 'metadata', class: `fmt-${(v.format || '9:16').replace(':', 'x')}`, ...extra });
}

function progressSteps(p) {
  const { steps, done } = p.progress;
  return h('div', { class: `steps${p.stage === 'declined' ? ' declined' : ''}` }, steps.map((s, i) => h('div', { class: `step${i < done ? ' done' : i === done && !['completed', 'declined', 'dismissed', 'revision_requested', 'needs_attention'].includes(p.stage) ? ' current' : ''}` }, h('i'), h('span', {}, s))));
}

function resourceThumbs(res, { max = 99 } = {}) {
  const items = [];
  if (res.logo) items.push(h('a', { class: 'thumb contain', href: res.logo.url || res.logo.thumbUrl, target: '_blank', style: { backgroundImage: `url("${res.logo.thumbUrl}")` }, title: res.logo.name }, h('em', {}, res.logo.saved ? 'Saved logo' : 'Logo')));
  for (const p of res.photos) items.push(h('a', { class: 'thumb', href: p.url, target: '_blank', style: { backgroundImage: `url("${p.thumbUrl}")` }, title: p.name }));
  for (const c of res.clips) items.push(h('a', { class: 'thumb', href: c.url, target: '_blank', style: { backgroundImage: `url("${c.thumbUrl}")` }, title: c.name }, h('em', {}, `▶ ${Math.round(c.duration || 0)}s`)));
  if (!items.length) return h('p', { class: 'muted small' }, 'No files were uploaded with this submission.');
  return h('div', { class: 'thumbs' }, items.slice(0, max), items.length > max ? h('div', { class: 'thumb', style: { display: 'grid', placeItems: 'center' } }, `+${items.length - max}`) : null);
}

function requirementBadges(r) {
  const label = (list, id) => (window.cutlineStatus?.ads?.[list] || []).find((x) => x.id === id)?.label || id;
  return h('div', { class: 'badges' }, [
    r.objective && r.objective !== 'auto' ? label('objectives', r.objective) : null,
    `${r.seconds}s`,
    (r.formats || []).map((f) => SIZE[f] || f).join(' + '),
    r.direction && r.direction !== 'auto' ? label('directions', r.direction) : null,
    `${r.count} version${r.count > 1 ? 's' : ''}`,
    r.musicMood ? `${r.musicMood} music` : null,
    r.voiceover ? 'voiceover' : null,
    r.deadline ? `needed by ${fmtDate(r.deadline)}` : null,
  ].filter(Boolean).map((t) => h('span', { class: 'badge' }, t)));
}

function answersList(answers) {
  if (!answers?.length) return h('p', { class: 'muted small' }, 'No answers.');
  return h('dl', { class: 'kv' }, answers.map((a) => [h('dt', {}, a.title), h('dd', {}, a.answer || '-')]));
}

// ---------------------------------------------------------------------------
// Setup, routing, sidebar counts
// ---------------------------------------------------------------------------

export function init(h0) {
  hooks = { ...hooks, ...h0 };
  $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('#sidebar-scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
  $('#appbar-check').addEventListener('click', async (e) => {
    const r = await run(e.currentTarget, () => post('/api/intake/check'));
    if (r) toast(r.message, { error: !r.ok });
    refreshCounts();
    rerender();
  });
  refreshCounts();
}

export async function refreshCounts() {
  try {
    const [c, it] = await Promise.all([api('/api/ops/counts'), api('/api/intake')]);
    $('#nav-onboarding').textContent = c.onboarding || '';
    $('#nav-approval').textContent = c.approval || '';
    $('#nav-pending').textContent = c.pending || '';
    $('#nav-revisions').textContent = c.revisions || '';
    const gp = $('#google-pill');
    gp.className = `ai-pill ${!it.configured ? 'off' : it.lastError ? 'err' : 'on'}`;
    $('.label', gp).textContent = !it.configured ? 'Google: not connected' : it.lastError ? 'Google: problem' : it.gmailReady ? `Gmail: ${it.gmail || 'connected'}` : 'Google: update script';
    gp.title = it.lastError || (it.gmail ? `Connected as ${it.gmail}` : '');
  } catch {}
}

const PAGES = { dashboard: renderDashboard, onboarding: renderOnboarding, projects: renderProjects, approval: renderApproval, emails: renderEmails, pending: renderPending, revisions: renderRevisions, invoices: renderInvoices };

export function route(nav, sub, extra) {
  clearTimeout(timer);
  current = { nav, sub, extra };
  if (nav === 'projects' && sub === 'clients') return;
  if (PAGES[nav]) PAGES[nav]();
}

function rerender() {
  if (PAGES[current.nav] && !(current.nav === 'projects' && current.sub === 'clients')) PAGES[current.nav]();
}

/** Status of the server (for labels); app.js keeps it fresh. */
async function statusInfo() {
  if (!window.cutlineStatus) window.cutlineStatus = await api('/api/status').catch(() => null);
  return window.cutlineStatus;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const FEED_ICONS = {
  submission: ['inbox', ''], resources: ['folder', ''], production: ['sparkle', 'purple'], video_ready: ['film', 'amber'], video_approved: ['check-circle', 'green'],
  email_pending: ['clock', 'amber'], email_sent: ['send', 'green'], revision: ['refresh', 'amber'], revision_started: ['sparkle', 'purple'], needs_attention: ['alert', 'red'],
  completed: ['check', 'green'], declined: ['x', 'red'], error: ['alert', 'red'], changes: ['edit', 'purple'], regenerate: ['refresh', 'purple'], dismissed: ['archive', ''],
};

async function renderDashboard() {
  const root = $('#dashboard-root');
  let d;
  try {
    [d] = await Promise.all([api('/api/ops/dashboard'), statusInfo()]);
  } catch (err) {
    fill(root, h('div', { class: 'callout red' }, err.message));
    return;
  }
  const s = d.stats;
  const hr = new Date().getHours();
  const stat = (label, value, ic, href, sub, hot) => h('a', { class: `stat${hot && value ? ' hot' : ''}`, href }, h('span', { class: 'stat-label' }, icon(ic), label), h('span', { class: 'stat-value' }, String(value)), sub ? h('span', { class: 'stat-sub' }, sub) : null);
  const setup = [];
  if (!d.intake.configured) setup.push(['Connect your Google Form', 'New submissions then appear automatically.', '#/onboarding']);
  else if (d.intake.scriptOutdated) setup.push(['Update your Google script', 'Needed for Gmail sending and reply detection.', '#/emails']);
  if (d.setupGaps.length) setup.push([`Add ${d.setupGaps.join(', ')}`, 'Used on invoices and client emails.', '#/settings']);
  if (!window.cutlineStatus?.ai?.configured) setup.push(['Add your Claude key', 'For AI direction, revisions and reading client replies.', '#/settings']);
  const maxPipe = Math.max(1, ...d.pipeline.map((p) => p.count));
  fill(root, 
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Good ${hr < 12 ? 'morning' : hr < 18 ? 'afternoon' : 'evening'}`), h('p', { class: 'muted' }, s.total ? `${s.total} client project${s.total > 1 ? 's' : ''} · ${s.submissionsThisWeek} new this week` : 'Your client workflow at a glance.')),
      h('div', { class: 'row' },
        d.intake.formUrl ? btn('Copy form link', async () => { await copyText(d.intake.formUrl); toast('Form link copied: send it to your clients'); }, { ic: 'copy' }) : null,
        btn('Check now', async (e) => { const r = await run(e.currentTarget, () => post('/api/intake/check')); if (r) toast(r.message, { error: !r.ok }); renderDashboard(); refreshCounts(); }, { cls: 'btn-primary', ic: 'refresh' }))),
    setup.length ? h('div', { class: 'card', style: { marginBottom: '18px' } }, cardHead('Finish setting up'), h('div', { class: 'attention' }, setup.map(([t, sub, href]) => h('a', { class: 'attn', href }, h('span', { class: 'avatar' }, icon('alert')), h('div', { class: 'grow' }, h('b', {}, t), h('span', { class: 'muted small' }, sub)), icon('external'))))) : null,
    h('div', { class: 'stats' },
      stat('Total clients', s.clients, 'users', '#/projects/clients'),
      stat('New submissions', s.newSubmissions, 'inbox', '#/onboarding', 'waiting for review', true),
      stat('In production', s.inProduction, 'sparkle', '#/projects', 'AI is making videos'),
      stat('Videos to approve', s.awaitingVideoApproval, 'check-circle', '#/approval', null, true),
      stat('Emails to approve', s.awaitingEmailApproval, 'clock', '#/pending', null, true),
      stat('Emails sent', s.emailsSent, 'send', '#/emails'),
      stat('Revisions requested', s.revisionsRequested, 'refresh', '#/revisions', null, true),
      stat('Completed', s.completed, 'check', '#/projects'),
      stat('Declined', s.declined, 'x', '#/projects', 'no charge'),
      stat('Unpaid invoices', d.invoices.outstanding, 'receipt', '#/invoices', d.invoices.outstanding ? money(d.invoices.outstandingTotal, d.invoices.currency) : `${money(d.invoices.paidTotal, d.invoices.currency)} paid`)),
    h('div', { class: 'dash-grid' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, cardHead('Needs your attention', h('span', { class: 'sub' }, `${d.attention.length} item${d.attention.length === 1 ? '' : 's'}`)),
          d.attention.length ? h('div', { class: 'attention' }, d.attention.map((p) => h('a', { class: 'attn', href: nextHref(p) }, avatar(p), h('div', { class: 'grow' }, h('b', {}, p.name), h('span', { class: 'muted small' }, `${p.number} · ${ago(p.stageAt)}`)), stagePill(p))))
            : emptyState('check-circle', "You're all caught up", 'New submissions, videos to approve and client replies will show up here.')),
        h('div', { class: 'card' }, cardHead('Projects by stage'),
          d.pipeline.length ? h('div', { class: 'bars' }, d.pipeline.map((p) => h('a', { class: 'bar-row', href: '#/projects', style: { textDecoration: 'none' } }, h('span', {}, p.label), h('span', { class: 'bar-track' }, h('i', { style: { width: `${(p.count / maxPipe) * 100}%`, background: `var(--${{ amber: 'warn', green: 'ok', red: 'err', grey: 'dim', purple: 'purple', blue: 'accent' }[TONES[p.stage] || 'blue']})` } })), h('b', {}, p.count))))
            : h('p', { class: 'muted small' }, 'No client projects yet.'))),
      h('div', { class: 'card' }, cardHead('Recent activity'),
        d.activity.length ? h('ul', { class: 'feed' }, d.activity.slice(0, 18).map((a) => {
          const [ic, tone] = FEED_ICONS[a.type] || ['sparkle', ''];
          const href = a.page ? `#/${a.page}` : a.cpId ? `#/projects/${a.cpId}` : null;
          return h('li', {}, h('span', { class: `fi ${tone}` }, icon(ic)), href ? h('a', { href }, a.text) : h('span', {}, a.text), h('time', {}, ago(a.t)));
        })) : h('p', { class: 'muted small' }, 'Activity appears here as clients submit forms and projects move along.'))));
  schedule(renderDashboard, s.inProduction > 0);
}

/** Where the "next step" for a project lives. */
function nextHref(p) {
  return {
    ready_for_review: `#/projects/${p.id}`, video_review: '#/approval', email_review: '#/pending', revision_requested: '#/revisions', needs_attention: '#/revisions',
  }[p.stage] || `#/projects/${p.id}`;
}

// ---------------------------------------------------------------------------
// Client Onboarding
// ---------------------------------------------------------------------------

async function renderOnboarding() {
  const root = $('#onboarding-root');
  let it, list;
  try {
    [it, list] = await Promise.all([api('/api/intake'), api('/api/cprojects'), statusInfo()]);
  } catch (err) {
    fill(root, h('div', { class: 'callout red' }, err.message));
    return;
  }
  const filter = drafts['onb-filter'] || 'review';
  const subs = list.filter((p) => (filter === 'review' ? ['submitted', 'collecting', 'ready_for_review', 'failed'].includes(p.stage) && !p.archived : filter === 'dismissed' ? p.stage === 'dismissed' : true));
  const waiting = list.filter((p) => ['submitted', 'collecting', 'ready_for_review'].includes(p.stage)).length;

  const table = subs.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Business'), h('th', {}, 'Submitted'), h('th', {}, 'Resources'), h('th', {}, 'Status'), h('th', {}, ''))),
    h('tbody', {}, subs.map((p) => h('tr', { class: 'clickable', onclick: (e) => !e.target.closest('button') && go(`#/projects/${p.id}`) },
      h('td', {}, h('div', { class: 'who' }, avatar(p), h('div', {}, h('b', {}, p.name), h('small', {}, [p.number, p.contact?.email].filter(Boolean).join(' · '))))),
      h('td', {}, h('span', { title: fmtDateTime(p.submittedAt) }, ago(p.submittedAt))),
      h('td', { class: 'small muted' }, p.stage === 'collecting' ? (p.stageNote || 'Downloading…') : p.thumb ? h('div', { class: 'thumb', style: { width: '44px', backgroundImage: `url("${p.thumb}")` } }) : '-'),
      h('td', {}, stagePill(p)),
      h('td', { class: 'num' }, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        p.stage === 'ready_for_review' ? btn('Approve production', (e) => run(e.currentTarget, () => post(`/api/cprojects/${p.id}/approve-production`), 'Production started').then(rerender), { cls: 'btn-sm btn-primary', ic: 'sparkle' }) : null,
        p.stage === 'failed' ? btn('Retry', (e) => run(e.currentTarget, () => post(`/api/cprojects/${p.id}/retry`), 'Trying again').then(rerender), { cls: 'btn-sm' }) : null,
        p.stage === 'dismissed' ? btn('Restore', (e) => run(e.currentTarget, () => post(`/api/cprojects/${p.id}/restore`)).then(rerender), { cls: 'btn-sm' }) : null,
        btn('Review', () => go(`#/projects/${p.id}`), { cls: 'btn-sm' }))))))))
    : h('div', { class: 'card' }, emptyState('inbox', filter === 'review' ? 'No submissions waiting' : 'Nothing here', it.configured ? 'When a business completes your Google Form, it appears here with its answers and files, ready for you to review.' : 'Connect your Google Form (on the right) and new submissions will appear here automatically.'));

  fill(root, 
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Client Onboarding'), h('p', { class: 'muted' }, 'New Google Form submissions arrive here with their answers and files. Review them, then approve production.')),
      h('div', { class: 'row' }, btn('Check for submissions', async (e) => { const r = await run(e.currentTarget, () => post('/api/intake/check')); if (r) toast(r.message, { error: !r.ok }); renderOnboarding(); refreshCounts(); }, { cls: 'btn-primary', ic: 'refresh', disabled: !it.configured }))),
    h('div', { class: 'dash-grid' },
      h('div', { class: 'stack' },
        h('div', { class: 'toolbar' }, segment('onb-filter', [['review', `Waiting for review${waiting ? ` (${waiting})` : ''}`], ['all', 'All submissions'], ['dismissed', 'Dismissed']], filter, renderOnboarding)),
        table),
      connectionCard(it)));
  schedule(renderOnboarding, list.some((p) => ['collecting', 'submitted'].includes(p.stage)));
}

function segment(key, options, value, onChange) {
  return h('div', { class: 'seg', role: 'radiogroup' }, options.map(([v, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), onclick: () => { drafts[key] = v; onChange(); } }, label)));
}

function connectionCard(it) {
  const status = !it.configured ? pill('Not connected', 'amber') : it.lastError ? pill('Problem', 'red') : it.lastCheck ? pill('Connected', 'green') : pill('Not checked yet', 'amber');
  const url = draftField('onb-url', h('input', { type: 'url', placeholder: 'https://script.google.com/macros/s/…/exec', autocomplete: 'off', spellcheck: 'false', disabled: !it.editable }), it.url);
  const key = draftField('onb-key', h('input', { type: 'password', placeholder: it.key ? `Saved: ${it.key}` : 'The long code from the Apps Script log', autocomplete: 'off', disabled: !it.editable }), '');
  const save = async (e) => {
    if (!url.value.trim()) return toast('Paste the Web app URL first.', { error: true });
    if (!key.value.trim() && !it.key) return toast('Paste the connection code too.', { error: true });
    const ok = await run(e.currentTarget, () => post('/api/intake/settings', key.value.trim() ? { url: url.value.trim(), key: key.value.trim() } : { url: url.value.trim() }));
    if (!ok) return;
    delete drafts['onb-url'];
    delete drafts['onb-key'];
    const r = await run(null, () => post('/api/intake/check'));
    if (r) toast(r.message, { error: !r.ok });
    renderOnboarding();
    refreshCounts();
  };
  const opt = (body) => run(null, () => post('/api/intake/settings', body)).then(renderOnboarding);
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      cardHead(h('h3', {}, icon('inbox'), 'Google Form connection'), status),
      it.lastError ? h('div', { class: 'callout red', style: { marginBottom: '12px' } }, it.lastError) : null,
      it.configured && it.lastCheck && !it.lastError ? h('p', { class: 'muted small', style: { marginBottom: '12px' } }, `"${it.formTitle || 'Your form'}" · checked ${ago(it.lastCheck)} · every ${it.checkEveryMinutes} min while Cutline is open`) : null,
      it.formUrl ? h('div', { class: 'field', style: { marginBottom: '12px' } }, h('span', { class: 'label' }, 'Your form link (send this to clients)'),
        h('div', { class: 'copy-row' }, h('input', { value: it.formUrl, readonly: true, onclick: (e) => e.target.select() }), btn('', async () => { await copyText(it.formUrl); toast('Form link copied'); }, { cls: 'btn-sm', ic: 'copy', title: 'Copy' }), h('a', { class: 'btn btn-sm', href: it.formUrl, target: '_blank', rel: 'noopener', title: 'Open' }, icon('external'))),
        it.formEditUrl ? h('a', { class: 'small', href: it.formEditUrl, target: '_blank', rel: 'noopener' }, 'Edit your form in Google Forms ↗') : null) : null,
      h('div', { class: 'field', style: { marginBottom: '10px' } }, h('label', { class: 'label' }, 'Web app URL'), url),
      h('div', { class: 'field', style: { marginBottom: '12px' } }, h('label', { class: 'label' }, 'Connection code'), key),
      h('div', { class: 'row' }, btn('Save and connect', save, { cls: 'btn-primary', disabled: !it.editable }), it.configured ? btn('Disconnect', (e) => confirm('Disconnect your Google Form? Projects already here are kept.') && run(e.currentTarget, () => post('/api/intake/settings', { url: '', key: '' }), 'Disconnected').then(renderOnboarding), { cls: 'btn-ghost', disabled: !it.editable }) : null),
      it.scriptOutdated ? h('div', { class: 'callout amber', style: { marginTop: '12px' } }, h('b', {}, 'Update your Google script. '), 'It is an older version, so Gmail sending and reply detection are off. ', h('a', { href: '#/emails' }, 'See how →')) : null,
      h('details', { class: 'more guide', open: !it.configured, 'data-keep': '' }, h('summary', {}, 'How to connect your existing form (5 minutes)'),
        h('ol', {},
          h('li', {}, btn('Copy the Google script', copyScript, { cls: 'btn-sm', ic: 'copy' })),
          h('li', {}, 'Open ', h('b', {}, 'your form'), ' in Google Forms → click the ', h('b', {}, '⋮'), ' menu (top right) → ', h('b', {}, 'Apps Script'), '. Delete the text there and paste. Click the save icon.'),
          h('li', {}, 'At the top, choose ', h('b', {}, 'setupCutline'), ' and click ', h('b', {}, 'Run'), '. Sign in with Google and allow access. (If Google says "app isn\'t verified": ', h('i', {}, 'Advanced → Go to … (unsafe)'), '. It\'s your own script.)'),
          h('li', {}, 'The ', h('b', {}, 'Execution log'), ' shows your ', h('b', {}, 'connection code'), '.'),
          h('li', {}, h('b', {}, 'Deploy → New deployment'), ' → gear icon → ', h('b', {}, 'Web app'), '. Execute as ', h('b', {}, 'Me'), ', Who has access ', h('b', {}, 'Anyone'), '. Deploy and copy the ', h('b', {}, 'Web app URL'), '.'),
          h('li', {}, 'Paste the URL and code above and click ', h('b', {}, 'Save and connect'), '.')),
        h('p', { class: 'help' }, 'Your form and its questions are never changed. Cutline reads the answers and any uploaded files. Give upload questions clear titles like "Logo", "Photos" or "Video clips" so files are sorted correctly. Google keeps a copy of every upload in your Drive.'))),
    h('div', { class: 'card' },
      cardHead('Production settings'),
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: it.autoProduce, disabled: !it.editable, onchange: (e) => opt({ autoProduce: e.target.checked }) }), h('span'), 'Start production without my review'),
      h('p', { class: 'help', style: { marginTop: '-6px', marginBottom: '12px' } }, it.autoProduce ? 'New submissions go straight into AI production. Videos and emails still wait for your approval.' : 'Recommended: you review each submission and click Approve production.'),
      h('div', { class: 'field', style: { marginBottom: '12px' } }, h('span', { class: 'label' }, 'Video engine for client projects'), segmentRaw([['ai', `Claude AI${it.ai ? '' : ' (no key)'}`], ['auto', 'Free (no AI)']], it.mode, (v) => opt({ mode: v }))),
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: it.voiceover, disabled: !it.editable, onchange: (e) => opt({ voiceover: e.target.checked }) }), h('span'), 'Voiceover when the client asks (OpenAI, about 1–2c)'),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Most automatic starts per day'), h('input', { type: 'number', min: 0, max: 100, value: it.dailyLimit, style: { width: '100px' }, disabled: !it.editable, onchange: (e) => opt({ dailyLimit: Number(e.target.value) }) }),
        h('p', { class: 'help' }, 'Protects your AI credit if your form link is shared or spammed.'))));
}

function segmentRaw(options, value, onChange) {
  return h('div', { class: 'seg', role: 'radiogroup' }, options.map(([v, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), onclick: () => onChange(v) }, label)));
}

async function copyScript() {
  try {
    await copyText(await (await fetch('/api/intake/script')).text());
    toast('Script copied. Paste it into Apps Script (from your form\'s ⋮ menu).');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------------------------------------------------------------------------
// Client Projects (list + detail)
// ---------------------------------------------------------------------------

const FILTERS = {
  active: (p) => !p.archived && !['completed', 'declined', 'dismissed'].includes(p.stage),
  action: (p) => ['ready_for_review', 'video_review', 'email_review', 'revision_requested', 'needs_attention', 'failed'].includes(p.stage),
  completed: (p) => p.stage === 'completed',
  declined: (p) => p.stage === 'declined',
  archived: (p) => p.archived,
  all: () => true,
};

async function renderProjects() {
  if (current.sub) return renderProjectDetail(current.sub);
  const root = $('#projects-root');
  let list;
  try {
    [list] = await Promise.all([api('/api/cprojects'), statusInfo()]);
  } catch (err) {
    fill(root, h('div', { class: 'callout red' }, err.message));
    return;
  }
  const filter = drafts['proj-filter'] || 'active';
  const q = (drafts['proj-q'] || '').toLowerCase();
  const rows = list.filter(FILTERS[filter]).filter((p) => !q || `${p.name} ${p.number} ${p.contact?.email} ${p.contact?.name}`.toLowerCase().includes(q));
  const search = draftField('proj-q', h('input', { class: 'search', type: 'search', placeholder: 'Search clients…' }));
  search.addEventListener('input', () => {
    clearTimeout(search.t);
    search.t = setTimeout(() => {
      renderProjects().then(() => {
        const s = $('#projects-root .search');
        s?.focus();
        s?.setSelectionRange(s.value.length, s.value.length);
      });
    }, 250);
  });
  const n = (k) => list.filter(FILTERS[k]).length;
  fill(root, 
    h('div', { class: 'toolbar' }, search, segment('proj-filter', [['active', `Active (${n('active')})`], ['action', `Needs action (${n('action')})`], ['completed', 'Completed'], ['declined', 'Declined'], ['archived', 'Archived'], ['all', 'All']], filter, renderProjects)),
    rows.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Client'), h('th', {}, 'Stage'), h('th', {}, 'Progress'), h('th', {}, 'Video'), h('th', {}, 'Email'), h('th', {}, 'Invoice'), h('th', {}, 'Updated'))),
      h('tbody', {}, rows.map((p) => h('tr', { class: 'clickable', onclick: () => go(`#/projects/${p.id}`) },
        h('td', {}, h('div', { class: 'who' }, avatar(p), h('div', {}, h('b', {}, p.name), h('small', {}, [p.number, p.contact?.name || p.contact?.email].filter(Boolean).join(' · '))))),
        h('td', {}, stagePill(p), p.stageNote ? h('div', { class: 'small muted' }, p.stageNote) : null),
        h('td', { style: { minWidth: '120px' } }, h('div', { class: 'bar' }, h('i', { style: { width: `${(p.progress.done / p.progress.steps.length) * 100}%`, background: p.stage === 'declined' ? '#94a3b8' : null } })), h('span', { class: 'small muted' }, `${p.progress.done}/${p.progress.steps.length}`)),
        h('td', { class: 'small' }, p.versions ? `${p.versions} version${p.versions > 1 ? 's' : ''}` : h('span', { class: 'muted' }, '-')),
        h('td', {}, p.emailStatus === 'none' ? h('span', { class: 'muted small' }, '-') : pill({ sent: 'Sent', pending: 'Pending', failed: 'Failed', sending: 'Sending' }[p.emailStatus] || p.emailStatus, { sent: 'green', pending: 'amber', failed: 'red', sending: 'blue' }[p.emailStatus])),
        h('td', {}, p.invoice ? h('span', {}, pill(INV_LABELS[p.invoice.status], INV_TONES[p.invoice.status]), h('div', { class: 'small muted' }, `${p.invoice.number} · ${money(p.invoice.total, p.invoice.currency)}`)) : h('span', { class: 'muted small' }, '-')),
        h('td', { class: 'small muted' }, ago(p.updatedAt)))))))
      : h('div', { class: 'card' }, emptyState('briefcase', list.length ? 'No projects match' : 'No client projects yet', list.length ? 'Try another filter.' : 'Each Google Form submission becomes a client project automatically.', list.length ? null : h('a', { class: 'btn btn-primary', href: '#/onboarding' }, 'Go to Client Onboarding'))));
  schedule(renderProjects, list.some((p) => ['producing', 'collecting', 'sending'].includes(p.stage)));
}

async function renderProjectDetail(id) {
  const root = $('#projects-root');
  $('#projects-head').hidden = true;
  let p;
  try {
    [p] = await Promise.all([api(`/api/cprojects/${id}`), statusInfo()]);
  } catch (err) {
    fill(root, h('button', { class: 'back', onclick: () => go('#/projects') }, '← All projects'), h('div', { class: 'callout red' }, err.message));
    return;
  }
  const act = (path, body, msg) => (e) => run(e?.currentTarget, () => post(`/api/cprojects/${p.id}/${path}`, body), msg).then(() => renderProjectDetail(id));
  const primary = {
    ready_for_review: btn('Approve for production', act('approve-production', {}, 'Production started'), { cls: 'btn-primary', ic: 'sparkle' }),
    video_review: h('a', { class: 'btn btn-primary', href: '#/approval' }, icon('check-circle'), 'Review the video'),
    email_review: h('a', { class: 'btn btn-primary', href: '#/pending' }, icon('mail'), 'Review the email'),
    revision_requested: h('a', { class: 'btn btn-primary', href: '#/revisions' }, icon('refresh'), 'Write revision instructions'),
    needs_attention: h('a', { class: 'btn btn-primary', href: '#/revisions' }, icon('alert'), 'Review the client\'s reply'),
    failed: btn('Retry', act('retry', {}, 'Trying again'), { cls: 'btn-primary', ic: 'refresh' }),
    declined: btn('Undo decline', act('undo-decline', {}, 'Restored'), { ic: 'refresh' }),
    dismissed: btn('Restore submission', act('restore', {}, 'Restored'), { ic: 'refresh' }),
  }[p.stage];
  const cur = p.versions[0];
  fill(root, 
    h('button', { class: 'back', onclick: () => go('#/projects') }, '← All client projects'),
    h('div', { class: 'detail-head' },
      avatar(p),
      h('div', {}, h('div', { class: 'row' }, h('h1', {}, p.name), stagePill(p), p.archived ? pill('Archived', 'grey') : null),
        h('div', { class: 'meta' }, h('span', {}, p.number), p.contact?.name ? h('span', {}, p.contact.name) : null, p.contact?.email ? h('a', { href: `mailto:${p.contact.email}` }, p.contact.email) : null, h('span', {}, `submitted ${fmtDate(p.submittedAt)}`))),
      h('div', { class: 'detail-actions' },
        primary || null,
        p.production?.projectId ? btn('Open in editor', () => hooks.openProjectInEditor(p.production.projectId), { ic: 'film' }) : null,
        ['ready_for_review', 'submitted', 'failed'].includes(p.stage) ? btn('Dismiss', (e) => { const r = prompt('Dismiss this submission? Optional reason:', ''); if (r !== null) act('dismiss', { reason: r }, 'Dismissed')(e); }, { cls: 'btn-ghost' }) : null,
        !['declined', 'dismissed', 'completed', 'ready_for_review', 'submitted', 'collecting'].includes(p.stage) ? btn('Mark completed', act('complete', {}, 'Marked completed'), { cls: 'btn-ghost', ic: 'check' }) : null,
        !['declined', 'dismissed', 'ready_for_review', 'submitted', 'collecting'].includes(p.stage) ? btn('Client declined', (e) => { const r = prompt('Mark as declined? The invoice is voided and the client is not charged.\nReason (optional):', ''); if (r !== null) act('decline', { reason: r }, 'Declined; invoice voided')(e); }, { cls: 'btn-danger' }) : null,
        btn(p.archived ? 'Unarchive' : 'Archive', act('archive', { archived: !p.archived }), { cls: 'btn-ghost', ic: 'archive' }))),
    h('div', { class: 'card' }, cardHead('Progress', p.stageNote ? h('span', { class: 'sub' }, p.stageNote) : null, p.progress.revisions ? pill(`${p.progress.revisions} revision${p.progress.revisions > 1 ? 's' : ''}`, 'purple') : null), progressSteps(p),
      p.error ? h('div', { class: 'callout red', style: { marginTop: '12px' } }, p.error) : null,
      p.declined ? h('div', { class: 'callout', style: { marginTop: '12px' } }, `Declined ${fmtDate(p.declined.at)} (${p.declined.by})${p.declined.reason ? `: "${p.declined.reason}"` : ''}. Invoice voided, no charge.`) : null,
      p.lastNoChange ? h('div', { style: { marginTop: '12px' } }, noChangeNote(p, p.lastNoChange.kind)) : null,
      p.notes.length ? h('ul', { class: 'notes-list', style: { marginTop: '12px' } }, p.notes.map((n) => h('li', {}, n))) : null),
    h('div', { class: 'detail-grid' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, cardHead('Current video', cur ? h('span', { class: 'sub' }, `Version ${cur.n} · ${cur.reason} · ${fmtDateTime(cur.at)}`) : null, cur?.approvedAt ? pill('Approved', 'green') : cur ? pill('Not approved yet', 'amber') : null),
          cur ? h('div', { class: 'stack' }, h('div', { class: 'videos' }, cur.videos.map((v) => h('div', { class: `vtile${v.format === '16:9' ? ' wide' : ''}` }, videoEl(v), h('div', { class: 'row' }, h('b', {}, v.label), qaBadge(v))))), cur.description ? h('div', { class: 'desc' }, cur.description) : null)
            : h('p', { class: 'muted small' }, p.stage === 'producing' ? 'The AI is making the video…' : 'No video yet. Approve the submission for production to start.')),
        p.versions.length > 1 ? h('div', { class: 'card' }, cardHead('Version history', h('span', { class: 'sub' }, 'Every version is kept')), p.versions.slice(1).map((v) => versionBlock(v))) : null,
        p.feedback.length || p.revisions.length ? h('div', { class: 'card' }, cardHead('Client feedback & revisions'), feedbackList(p)) : null,
        p.emails.length ? h('div', { class: 'card' }, cardHead('Emails'), h('div', { class: 'stack' }, p.emails.map((e) => emailRow(p, e)))) : null,
        h('div', { class: 'card' }, cardHead('Form submission'), answersList(p.answers))),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, cardHead('Contact & requirements'),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Business'), h('dd', {}, p.name),
            h('dt', {}, 'Contact'), h('dd', {}, p.contact?.name || '-'),
            h('dt', {}, 'Email'), h('dd', {}, p.contact?.email || h('span', { class: 'bad' }, 'Missing: the email can\'t be sent until you add one in Pending Emails')),
            h('dt', {}, 'Phone / web'), h('dd', {}, p.contact?.phone || '-'),
            h('dt', {}, 'Industry'), h('dd', {}, (window.cutlineStatus?.businesses || []).find((b) => b.id === p.requirements.business)?.label || p.requirements.businessCustom || p.requirements.business),
            p.requirements.profile.audience ? [h('dt', {}, 'Customers'), h('dd', {}, p.requirements.profile.audience)] : null),
          h('div', { style: { marginTop: '12px' } }, requirementBadges(p.requirements)),
          p.requirements.instructions ? h('div', { class: 'desc', style: { marginTop: '10px' } }, p.requirements.instructions) : null),
        h('div', { class: 'card' }, cardHead('Resources', h('span', { class: 'sub' }, `${p.resources.photos.length} photos · ${p.resources.clips.length} clips${p.resources.logo ? ' · logo' : ''}`)), resourceThumbs(p.resources),
          p.resources.skipped.length ? h('ul', { class: 'notes-list', style: { marginTop: '10px' } }, p.resources.skipped.map((s) => h('li', {}, `${s.name}: ${s.reason}`))) : null,
          p.clientId ? h('p', { class: 'help', style: { marginTop: '10px' } }, 'Saved in this client\'s brand kit for next time. ', h('a', { href: '#/projects/clients' }, 'Clients & brand kits →')) : null),
        h('div', { class: 'card' }, cardHead('Invoice'), invoiceMini(p.invoiceFull, () => renderProjectDetail(id))),
        h('div', { class: 'card' }, cardHead('History'),
          noteForm(p, () => renderProjectDetail(id)),
          h('ul', { class: 'history' }, p.history.slice(0, 40).map((x) => h('li', {}, h('div', {}, x.text, h('time', {}, fmtDateTime(x.t))))))))));
  schedule(() => current.sub === id && renderProjectDetail(id), ['producing', 'collecting', 'sending', 'submitted'].includes(p.stage));
}

function qaBadge(v) {
  if (!v.qa) return null;
  return h('span', { class: `badge qa ${v.qa.passed ? 'good' : 'warn'}`, title: 'Automatic quality check of the finished file' }, v.qa.passed ? 'QA passed' : `QA: ${v.qa.warnings} note${v.qa.warnings === 1 ? '' : 's'}`);
}

function versionBlock(v) {
  return h('div', { class: 'version' },
    h('div', { class: 'version-head' }, h('b', {}, `Version ${v.n}`), h('span', { class: 'muted' }, `${v.reason} · ${fmtDateTime(v.at)}`), v.approvedAt ? pill('Approved', 'green') : null, v.sentAt ? pill('Sent', 'blue') : null),
    v.instructions ? h('p', { class: 'small muted', style: { marginBottom: '8px' } }, `Instructions: "${v.instructions}"`) : null,
    h('details', { class: 'more', 'data-keep': '' }, h('summary', {}, `Watch (${v.videos.length})`), h('div', { class: 'videos' }, v.videos.map((x) => h('div', { class: 'vtile' }, videoEl(x), h('span', { class: 'small' }, x.label))))));
}

function feedbackList(p) {
  const items = p.feedback.map((f) => {
    const [label, tone] = INTENT[f.intent] || [f.intent, 'grey'];
    return h('div', { class: 'stack', style: { gap: '6px' } },
      h('div', { class: 'row small' }, pill(label, tone), h('span', { class: 'muted' }, `${f.from} · ${fmtDateTime(f.at)}`), f.decision ? h('span', { class: 'muted' }, `→ ${{ revision: 'revision', declined: 'declined', completed: 'completed', ignore: 'no action' }[f.decision]}`) : null),
      h('div', { class: `quote${f.intent === 'unclear' ? ' amber' : ''}` }, f.text),
      f.summary ? h('p', { class: 'small muted' }, `${f.by === 'ai' ? 'AI' : 'Cutline'}: ${f.summary}`) : null);
  });
  const revs = p.revisions.map((r, i) => h('p', { class: 'small' }, h('b', {}, `Revision ${i + 1}`), ` · ${fmtDateTime(r.at)}${r.instructions ? ` · your instructions: "${r.instructions}"` : ''}`));
  return h('div', { class: 'stack' }, ...items, ...revs);
}

function emailRow(p, e) {
  const tone = { sent: 'green', pending: 'amber', failed: 'red', sending: 'blue' }[e.status] || 'grey';
  return h('div', { class: 'version' },
    h('div', { class: 'version-head' }, pill({ sent: 'Sent', pending: 'Waiting for approval', failed: 'Not sent', sending: 'Sending' }[e.status] || e.status, tone), h('b', {}, e.subject), h('span', { class: 'muted' }, `to ${e.to || '(no address)'} · ${e.sentAt ? fmtDateTime(e.sentAt) : fmtDateTime(e.createdAt)}`)),
    e.error ? h('p', { class: 'small bad' }, e.error) : null,
    e.links?.length ? h('div', { class: 'row small' }, e.links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener' }, `${l.name} ↗`))) : null,
    ['pending', 'failed'].includes(e.status) ? h('a', { class: 'small', href: '#/pending' }, 'Review in Pending Emails →') : null);
}

function noteForm(p, done) {
  const ta = draftField(`note-${p.id}`, h('textarea', { rows: 2, placeholder: 'Add a private note to this project…', maxlength: 1000 }));
  return h('div', { class: 'stack', style: { gap: '6px', marginBottom: '12px' } }, ta, h('div', {}, btn('Add note', async (e) => { if (await run(e.currentTarget, () => post(`/api/cprojects/${p.id}/notes`, { text: ta.value }))) { delete drafts[`note-${p.id}`]; done(); } }, { cls: 'btn-sm' })));
}

function invoiceMini(inv, done) {
  if (!inv) return h('p', { class: 'muted small' }, 'An invoice is prepared automatically when you approve the video.');
  return h('div', { class: 'stack', style: { gap: '10px' } },
    h('div', { class: 'row' }, h('b', {}, inv.number), pill(INV_LABELS[inv.status], INV_TONES[inv.status]), h('span', { class: 'spacer' }), h('b', { style: { fontSize: '18px' } }, money(inv.total, inv.currency))),
    h('p', { class: 'small muted' }, `${inv.items.map((i) => i.description).join(', ')} · dated ${fmtDate(inv.date)} · due ${fmtDate(inv.dueDate)}`),
    inv.voidReason ? h('p', { class: 'small' }, `Void: ${inv.voidReason}`) : null,
    h('div', { class: 'row' },
      h('a', { class: 'attach', href: `/api/invoices/${inv.id}/pdf`, target: '_blank', rel: 'noopener' }, icon('receipt'), `Invoice ${inv.number}.pdf`),
      inv.status === 'issued' ? btn('Mark paid', (e) => run(e.currentTarget, () => post(`/api/invoices/${inv.id}/paid`), 'Marked as paid').then(done), { cls: 'btn-sm' }) : null,
      h('a', { class: 'btn btn-sm btn-ghost', href: '#/invoices' }, 'All invoices')));
}

// ---------------------------------------------------------------------------
// Video Approval Centre
// ---------------------------------------------------------------------------

async function renderApproval() {
  const root = $('#approval-root');
  let list;
  try {
    [list] = await Promise.all([api('/api/approvals'), statusInfo()]);
  } catch (err) {
    fill(root, h('div', { class: 'callout red' }, err.message));
    return;
  }
  const ready = list.filter((p) => p.stage === 'video_review');
  const making = list.filter((p) => p.stage === 'producing');
  fill(root, 
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Video Approval Centre'), h('p', { class: 'muted' }, 'Every finished video waits here for you. Nothing goes to a client until you approve the video and then the email.'))),
    making.length ? h('div', { class: 'card', style: { marginBottom: '16px' } }, cardHead('In production', h('span', { class: 'sub' }, 'These will appear below when ready')),
      h('div', { class: 'attention' }, making.map((p) => h('a', { class: 'attn', href: `#/projects/${p.id}` }, avatar(p), h('div', { class: 'grow' }, h('b', {}, p.name), h('span', { class: 'muted small' }, p.stageNote || 'Starting…')), h('div', { style: { width: '160px' } }, h('div', { class: `bar${p.progressPct == null ? ' indeterminate' : ''}` }, h('i', { style: { width: `${Math.round((p.progressPct || 0) * 100)}%` } }))))))) : null,
    ready.length ? h('div', { class: 'stack' }, ready.map(approvalCard))
      : h('div', { class: 'card' }, emptyState('check-circle', 'No videos waiting for approval', making.length ? 'The videos above are still being made.' : 'When the AI finishes a client\'s video, it appears here for you to review.')));
  schedule(renderApproval, making.length > 0);
}

function noChangeNote(p, kind) {
  const n = p.lastNoChange;
  if (!n || n.kind !== kind) return null;
  return h('div', { class: 'callout amber' }, h('b', {}, 'Your last request did not change the video. '), n.reply,
    !window.cutlineStatus?.ai?.configured ? ' Free mode can only make simple changes (music, opening line, call to action, length, style). Add a Claude key in Settings for detailed changes.' : '');
}

function approvalCard(p) {
  const v = p.current;
  const key = `appr-${p.id}-${v.n}`;
  const picked = (drafts[`${key}-pick`] ||= v.videos.map((x) => x.key));
  const show = drafts[`${key}-show`] || v.videos[0]?.key;
  const shown = v.videos.find((x) => x.key === show) || v.videos[0];
  const player = h('div', { class: 'player' }, videoEl(shown),
    v.videos.length > 1 ? h('div', { class: 'player-tabs' }, v.videos.map((x) => h('button', { type: 'button', class: x.key === shown.key ? 'on' : '', onclick: () => { drafts[`${key}-show`] = x.key; renderApproval(); } }, x.label))) : null);
  const changesOpen = drafts[`${key}-mode`] === 'changes';
  const changes = changesOpen ? h('div', { class: 'inline-form' },
    h('label', { class: 'label' }, 'What should be improved before the client sees it?'),
    draftField(`${key}-text`, h('textarea', { rows: 4, placeholder: 'e.g. Open with the cooking footage, make the logo bigger at the end and use a calmer song.', maxlength: 2000 })),
    (p.versions[0]?.videos || []).filter((x) => !x.format || x.format === v.videos[0].format).length > 1 ? h('p', { class: 'help' }, 'The changes apply to every version and size.') : null,
    h('div', { class: 'row' },
      btn('Send to the AI', async (e) => {
        const text = drafts[`${key}-text`] || '';
        if (text.trim().length < 3) return toast('Describe what you want changed.', { error: true });
        if (await run(e.currentTarget, () => post(`/api/cprojects/${p.id}/changes`, { instructions: text }), 'The AI is making your changes')) {
          delete drafts[`${key}-text`];
          delete drafts[`${key}-mode`];
          renderApproval();
          refreshCounts();
        }
      }, { cls: 'btn-primary', ic: 'sparkle' }),
      btn('Cancel', () => { delete drafts[`${key}-mode`]; renderApproval(); }, { cls: 'btn-ghost' }))) : null;
  return h('div', { class: 'card' },
    h('div', { class: 'big-card' },
      player,
      h('div', { class: 'stack', style: { gap: '14px' } },
        h('div', { class: 'row' }, avatar(p), h('div', {}, h('h2', { style: { fontSize: '18px' } }, h('a', { href: `#/projects/${p.id}`, style: { color: 'inherit' } }, p.name)), h('span', { class: 'muted small' }, `${p.number} · version ${v.n} (${v.reason.toLowerCase()}) · generated ${fmtDateTime(v.at)}`)), h('span', { class: 'spacer' }), pill('Awaiting your approval', 'amber')),
        noChangeNote(p, 'internal'),
        v.instructions ? h('div', { class: 'callout blue' }, `Made from: "${v.instructions}"`) : null,
        h('div', {}, h('span', { class: 'label' }, 'Client\'s requirements'), requirementBadges(p.requirements), p.requirements.instructions ? h('div', { class: 'desc', style: { marginTop: '8px' } }, p.requirements.instructions) : null),
        v.description ? h('div', {}, h('span', { class: 'label' }, 'What the AI made'), h('div', { class: 'desc' }, v.description)) : null,
        h('div', {}, h('span', { class: 'label' }, 'Their resources'), resourceThumbs(p.resources, { max: 8 })),
        h('div', {}, h('span', { class: 'label' }, 'Videos to approve'),
          h('div', { class: 'row' }, v.videos.map((x) => h('label', { class: 'vpick' }, h('input', { type: 'checkbox', checked: picked.includes(x.key), onchange: (e) => { drafts[`${key}-pick`] = e.target.checked ? [...new Set([...picked, x.key])] : picked.filter((k) => k !== x.key); } }), x.label, qaBadge(x))))),
        p.previous.length ? h('details', { class: 'more', 'data-keep': '' }, h('summary', {}, `Compare with earlier versions (${p.previous.length})`), p.previous.map(versionBlock)) : null,
        h('div', { class: 'action-bar', style: { marginTop: 0 } },
          btn('Approve video', async (e) => {
            const chosen = drafts[`${key}-pick`] || [];
            if (!chosen.length) return toast('Tick at least one video to approve.', { error: true });
            if (await run(e.currentTarget, () => post(`/api/cprojects/${p.id}/approve-video`, { videos: chosen }), 'Approved. The email and invoice are ready for you in Pending Emails')) {
              refreshCounts();
              renderApproval();
            }
          }, { cls: 'btn-success', ic: 'check' }),
          btn('Request internal changes', () => { drafts[`${key}-mode`] = 'changes'; renderApproval(); }, { ic: 'edit' }),
          btn('Regenerate video', (e) => confirm('Make a completely new version with the same brief? The current version stays in the history.') && run(e.currentTarget, () => post(`/api/cprojects/${p.id}/regenerate`), 'Regenerating').then(renderApproval), { ic: 'refresh' }),
          h('span', { class: 'spacer' }),
          btn('Open in editor', () => hooks.openProjectInEditor(p.production.projectId), { cls: 'btn-ghost', ic: 'film', title: 'Fine-tune it yourself in the editor' }),
          btn('Use my editor changes', (e) => run(e.currentTarget, () => post(`/api/cprojects/${p.id}/use-editor`), 'Your edited version is now the one to approve').then(renderApproval), { cls: 'btn-ghost', title: 'After saving changes in the editor, make them the version to approve' })),
        changes)));
}

// ---------------------------------------------------------------------------
// Email Management
// ---------------------------------------------------------------------------

async function renderEmails() {
  const root = $('#emails-root');
  let it, data, biz, pending;
  try {
    [it, data, biz, pending] = await Promise.all([api('/api/intake'), api('/api/emails/sent'), api('/api/business'), api('/api/emails/pending')]);
  } catch (err) {
    fill(root, h('div', { class: 'callout red' }, err.message));
    return;
  }
  const status = !it.configured ? pill('Not connected', 'amber') : it.scriptOutdated ? pill('Update needed', 'amber') : it.gmailReady ? pill('Connected', 'green') : pill('Not checked yet', 'amber');
  const t = biz.templates;
  const tf = (k, rows) => draftField(`tpl-${k}`, rows ? h('textarea', { rows, disabled: !biz.editable }) : h('input', { disabled: !biz.editable }), t[k]);
  const fields = { deliverySubject: tf('deliverySubject'), deliveryBody: tf('deliveryBody', 14), revisionSubject: tf('revisionSubject'), revisionBody: tf('revisionBody', 10) };
  fill(root, 
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Email Management'), h('p', { class: 'muted' }, 'Client emails go from your own Gmail, only after you click Approve & Send. Client replies are read and filed under the right project.')),
      h('div', { class: 'row' }, pending.length ? h('a', { class: 'btn btn-primary', href: '#/pending' }, icon('clock'), `${pending.length} pending email${pending.length > 1 ? 's' : ''}`) : null)),
    h('div', { class: 'dash-grid' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, cardHead(h('h3', {}, icon('mail'), 'Sent emails'), h('span', { class: 'sub' }, `${data.sent.length} sent`)),
          data.sent.length ? h('div', { class: 'tbl-wrap', style: { boxShadow: 'none' } }, h('table', { class: 'tbl' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Sent'), h('th', {}, 'Client'), h('th', {}, 'Subject'), h('th', {}, 'Type'))),
            h('tbody', {}, data.sent.map((x) => h('tr', { class: 'clickable', onclick: () => go(`#/projects/${x.cpId}`) },
              h('td', { class: 'small muted' }, fmtDateTime(x.email.sentAt)), h('td', {}, h('b', {}, x.name), h('div', { class: 'small muted' }, x.email.to)), h('td', {}, x.email.subject), h('td', {}, pill(x.email.kind === 'revision' ? 'Revision' : 'Delivery', x.email.kind === 'revision' ? 'purple' : 'blue')))))))
            : h('p', { class: 'muted small' }, 'No emails sent yet.')),
        h('div', { class: 'card' }, cardHead(h('h3', {}, icon('chat'), 'Client replies'), btn('Check inbox now', async (e) => { const r = await run(e.currentTarget, () => post('/api/emails/check-inbox')); if (r) toast(r.ok ? `${r.added} new repl${r.added === 1 ? 'y' : 'ies'}` : r.message, { error: !r.ok }); renderEmails(); refreshCounts(); }, { cls: 'btn-sm', ic: 'refresh', disabled: !it.gmailReady })),
          data.replies.length ? h('div', { class: 'stack' }, data.replies.slice(0, 30).map((x) => {
            const [label, tone] = INTENT[x.feedback.intent] || [x.feedback.intent, 'grey'];
            return h('a', { class: 'attn', href: `#/projects/${x.cpId}` }, pill(label, tone), h('div', { class: 'grow' }, h('b', {}, x.name), h('span', { class: 'muted small' }, x.feedback.text.slice(0, 140))), h('time', { class: 'small muted' }, ago(x.feedback.at)));
          })) : h('p', { class: 'muted small' }, 'When clients reply to your emails, their messages appear here and in their project.'))),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, cardHead(h('h3', {}, icon('shield'), 'Gmail connection'), status),
          it.gmail ? h('p', { class: 'small' }, 'Sending as ', h('b', {}, it.gmail)) : null,
          it.inboxError ? h('div', { class: 'callout red', style: { marginTop: '8px' } }, `Reply check failed: ${it.inboxError}`) : null,
          it.lastInboxCheck ? h('p', { class: 'small muted', style: { marginTop: '6px' } }, `Replies checked ${ago(it.lastInboxCheck)}`) : null,
          h('p', { class: 'help', style: { marginTop: '10px' } }, 'Gmail is reached through your own Google Apps Script, authorised with Google\'s secure sign-in. Cutline never sees your password, and only you hold the connection code. Replies are read only from the conversations Cutline started, or from your clients\' addresses.'),
          !it.configured ? h('a', { class: 'btn btn-primary', href: '#/onboarding', style: { marginTop: '12px' } }, 'Connect Google first') : null,
          it.scriptOutdated ? h('div', { class: 'callout amber guide', style: { marginTop: '12px' } }, h('b', {}, 'Update your Google script (2 minutes)'),
            h('ol', {}, h('li', {}, btn('Copy the new script', copyScript, { cls: 'btn-sm', ic: 'copy' })),
              h('li', {}, 'Open your form → ⋮ → Apps Script. Select all, paste over it, save.'),
              h('li', {}, 'Choose ', h('b', {}, 'setupCutline'), ' → Run, and allow the new Gmail permission.'),
              h('li', {}, h('b', {}, 'Deploy → Manage deployments'), ' → pencil → Version: ', h('b', {}, 'New version'), ' → Deploy. The URL stays the same.'),
              h('li', {}, 'Click "Check for new activity" at the top.'))) : null),
        h('div', { class: 'card' }, cardHead('Email templates', h('span', { class: 'sub' }, 'Used for every new email')),
          h('p', { class: 'help', style: { marginBottom: '12px' } }, 'Placeholders: {client_name}, {business_name}, {my_business}, {video_link} (the watch buttons). You can still edit each email before it is sent.'),
          h('div', { class: 'field' }, h('label', { class: 'label' }, 'Delivery email: subject'), fields.deliverySubject),
          h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', { class: 'label' }, 'Delivery email: message'), fields.deliveryBody),
          h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', { class: 'label' }, 'Revision email: subject'), fields.revisionSubject),
          h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', { class: 'label' }, 'Revision email: message'), fields.revisionBody),
          h('div', { class: 'row', style: { marginTop: '12px' } }, btn('Save templates', async (e) => {
            const templates = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
            if (await run(e.currentTarget, () => post('/api/business', { templates }), 'Templates saved')) {
              for (const k of Object.keys(fields)) delete drafts[`tpl-${k}`];
              renderEmails();
            }
          }, { cls: 'btn-primary', disabled: !biz.editable }), btn('Reset to the defaults', () => { if (!confirm('Replace your templates with the defaults?')) return; post('/api/business', { templates: { deliverySubject: '', deliveryBody: '', revisionSubject: '', revisionBody: '' } }).then(() => { for (const k of Object.keys(fields)) delete drafts[`tpl-${k}`]; renderEmails(); }); }, { cls: 'btn-ghost' }))))));
}

// ---------------------------------------------------------------------------
// Pending Emails (Approve & Send is the only way anything is sent)
// ---------------------------------------------------------------------------

async function renderPending() {
  const root = $('#pending-root');
  let list, it, biz;
  try {
    [list, it, biz] = await Promise.all([api('/api/emails/pending'), api('/api/intake'), api('/api/business')]);
  } catch (err) {
    fill(root, h('div', { class: 'callout red' }, err.message));
    return;
  }
  fill(root, 
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Pending Emails'), h('p', { class: 'muted' }, 'Prepared for you after each video approval. Read, edit and check everything. Nothing is sent until you click Approve & Send.'))),
    !it.gmailReady && list.length ? h('div', { class: 'callout amber', style: { marginBottom: '16px' } }, it.configured ? 'Your Google script needs updating before emails can be sent. ' : 'Connect your Google account before emails can be sent. ', h('a', { href: it.configured ? '#/emails' : '#/onboarding' }, 'Fix this →')) : null,
    biz.gaps.length && list.length ? h('div', { class: 'callout amber', style: { marginBottom: '16px' } }, `Your invoices are missing ${biz.gaps.join(', ')}. `, h('a', { href: '#/settings' }, 'Add them in Settings →')) : null,
    list.length ? h('div', { class: 'stack' }, list.map((x) => pendingCard(x, it))) : h('div', { class: 'card' }, emptyState('clock', 'No emails waiting', 'When you approve a video, its email and invoice are prepared and wait here for your review.', h('a', { class: 'btn', href: '#/approval' }, 'Video Approval Centre'))));
  schedule(renderPending, list.some((x) => x.email.status === 'sending'));
}

function renderEmailBody(body, videos) {
  const parts = String(body).replace(/\{links\}/g, '{video_link}').split('{video_link}');
  const buttons = h('div', {}, videos.filter((v) => v.included).map((v) => h('div', {}, h('a', { class: 'ep-button', href: v.url, target: '_blank' }, `▶  ${videos.filter((y) => y.included).length > 1 ? `Watch ${v.label}` : 'Watch your video'}`))));
  const out = [];
  parts.forEach((p, i) => {
    out.push(p);
    if (i < parts.length - 1) out.push(buttons.cloneNode(true));
  });
  if (parts.length === 1) out.push('\n', buttons);
  return out;
}

function pendingCard(x, it) {
  const e = x.email;
  const key = `pend-${e.id}`;
  const editing = drafts[`${key}-edit`];
  const sending = e.status === 'sending';
  const to = draftField(`${key}-to`, h('input', { type: 'email' }), e.to);
  const subject = draftField(`${key}-subject`, h('input', { maxlength: 200 }), e.subject);
  const body = draftField(`${key}-body`, h('textarea', { rows: 16, maxlength: 10000 }), e.body);
  const saveEdits = async (button) => {
    const ok = await run(button, () => api(`/api/cprojects/${x.cpId}/emails/${e.id}`, { method: 'PATCH', body: { to: to.value, subject: subject.value, body: body.value } }));
    if (ok) for (const k of ['to', 'subject', 'body', 'edit']) delete drafts[`${key}-${k}`];
    return ok;
  };
  const inv = x.invoice;
  const send = async (ev) => {
    const b = ev.currentTarget;
    if (editing && !(await saveEdits(b))) return;
    const target = editing ? to.value : e.to;
    if (!confirm(`Send this email to ${target} now?\n\nIt goes from your Gmail with ${x.videos.filter((v) => v.included).length} video link(s)${e.attachInvoice && inv && inv.status !== 'void' ? ` and invoice ${inv.number} (${money(inv.total, inv.currency)})` : ''}.`)) return renderPending();
    if (await run(b, () => post(`/api/cprojects/${x.cpId}/emails/${e.id}/send`, { approved: true }), 'Sending…')) {
      refreshCounts();
      renderPending();
    }
  };
  const preview = h('div', { class: 'email-preview' },
    h('div', { class: 'ep-head' }, h('div', {}, h('span', {}, 'To'), h('b', {}, e.to || h('span', { class: 'bad' }, 'No email address. Click Edit email to add one'))), h('div', {}, h('span', {}, 'Subject'), h('b', {}, e.subject)), e.threadId ? h('div', {}, h('span', {}, ''), h('span', { class: 'small muted' }, 'Replies in the existing conversation with this client')) : null),
    h('div', { class: 'ep-body' }, ...renderEmailBody(e.body, x.videos)),
    e.attachInvoice && inv ? h('div', { style: { padding: '0 18px 16px' } }, h('a', { class: 'attach', href: `/api/invoices/${inv.id}/pdf`, target: '_blank' }, icon('receipt'), `Invoice ${inv.number}.pdf`)) : null);
  const editor = h('div', { class: 'stack', style: { gap: '10px' } },
    h('div', { class: 'field' }, h('label', { class: 'label' }, 'To (client\'s email)'), to),
    h('div', { class: 'field' }, h('label', { class: 'label' }, 'Subject'), subject),
    h('div', { class: 'field' }, h('label', { class: 'label' }, 'Message'), body, h('p', { class: 'help' }, '{video_link} is where the watch buttons go.')),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: e.attachInvoice, onchange: (ev) => api(`/api/cprojects/${x.cpId}/emails/${e.id}`, { method: 'PATCH', body: { attachInvoice: ev.target.checked } }).then(renderPending) }), h('span'), 'Attach the invoice PDF'),
    h('div', { class: 'row' }, btn('Save changes', async (ev) => { if (await saveEdits(ev.currentTarget)) { toast('Email saved'); renderPending(); } }, { cls: 'btn-primary' }), btn('Cancel', () => { for (const k of ['to', 'subject', 'body', 'edit']) delete drafts[`${key}-${k}`]; renderPending(); }, { cls: 'btn-ghost' })));

  return h('div', { class: 'card' },
    cardHead(h('div', { class: 'row' }, h('h3', {}, h('a', { href: `#/projects/${x.cpId}`, style: { color: 'inherit' } }, x.name)), h('span', { class: 'muted small' }, `${x.number} · ${e.kind === 'revision' ? 'revision email' : 'delivery email'} · version ${x.version} · prepared ${ago(e.createdAt)}`)),
      e.status === 'failed' ? pill('Not sent', 'red') : sending ? pill('Sending…', 'blue') : pill('Waiting for your approval', 'amber')),
    e.status === 'failed' ? h('div', { class: 'callout red', style: { marginBottom: '12px' } }, `Not sent: ${e.error}`) : null,
    sending ? h('div', { class: 'job', style: { marginBottom: '12px' } }, h('div', { class: 'job-top' }, h('span', {}, x.stageNote || 'Sending…')), h('div', { class: 'bar indeterminate' }, h('i'))) : null,
    h('div', { class: 'detail-grid', style: { marginTop: 0 } },
      h('div', {}, editing ? editor : preview,
        h('div', { class: 'action-bar' },
          btn('Approve & Send', send, { cls: 'btn-primary btn-lg', ic: 'send', disabled: sending || !it.gmailReady, title: it.gmailReady ? null : 'Connect / update your Google script first' }),
          !editing ? btn('Edit email', () => { drafts[`${key}-edit`] = true; renderPending(); }, { cls: 'btn-lg', ic: 'edit', disabled: sending }) : null,
          h('span', { class: 'spacer' }),
          btn('Back to video review', (ev) => confirm('Discard this email and return the video to the approval centre?') && run(ev.currentTarget, () => post(`/api/cprojects/${x.cpId}/emails/${e.id}/discard`)).then(() => { refreshCounts(); go('#/approval'); }), { cls: 'btn-ghost', disabled: sending }))),
      h('div', { class: 'stack' },
        h('div', {}, h('span', { class: 'label' }, 'Videos in this email'),
          h('div', { class: 'videos' }, x.videos.map((v) => h('div', { class: 'vtile', style: { width: '150px' } }, videoEl(v),
            h('label', { class: 'vpick small' }, h('input', { type: 'checkbox', checked: v.included, disabled: sending, onchange: async (ev) => {
              const keys = x.videos.filter((y) => (y.key === v.key ? ev.target.checked : y.included)).map((y) => y.key);
              await run(null, () => api(`/api/cprojects/${x.cpId}/emails/${e.id}`, { method: 'PATCH', body: { videoKeys: keys } }));
              renderPending();
            } }), v.label))))),
        inv ? h('div', {}, h('span', { class: 'label' }, 'Invoice'), invoiceEditor(inv, renderPending)) : null,
        h('details', { class: 'more', 'data-keep': '' }, h('summary', {}, 'Client\'s original requirements'), requirementBadges(x.requirements), x.requirements.instructions ? h('div', { class: 'desc', style: { marginTop: '8px' } }, x.requirements.instructions) : null, h('div', { style: { marginTop: '10px' } }, answersList(x.answers))))));
}

function invoiceEditor(inv, done) {
  const box = h('div', { class: 'stack', style: { gap: '8px', padding: '12px', border: '1px solid var(--line)', borderRadius: '10px' } },
    h('div', { class: 'row' }, h('b', {}, inv.number), pill(INV_LABELS[inv.status], INV_TONES[inv.status]), h('span', { class: 'spacer' }), h('b', { style: { fontSize: '17px' } }, money(inv.total, inv.currency))),
    inv.items.map((it) => h('div', { class: 'row small' }, h('span', { class: 'grow', style: { flex: 1 } }, `${it.qty > 1 ? `${it.qty} × ` : ''}${it.description}`), h('span', {}, money(it.qty * it.unitPrice, inv.currency)))),
    inv.total === 0 ? h('div', { class: 'callout amber' }, 'This invoice is $0. Set your price in Settings, or edit it here.') : null,
    h('div', { class: 'row' },
      h('a', { class: 'attach', href: `/api/invoices/${inv.id}/pdf`, target: '_blank' }, icon('receipt'), 'Open PDF'),
      inv.status === 'draft' ? btn('Edit price', () => editInvoiceDialog(inv, done), { cls: 'btn-sm' }) : null));
  return box;
}

function editInvoiceDialog(inv, done) {
  const rows = inv.items.map((it) => ({ ...it }));
  const list = h('div', { class: 'stack', style: { gap: '8px' } });
  const draw = () => list.replaceChildren(...rows.map((r, i) => h('div', { class: 'row' },
    h('input', { value: r.description, style: { flex: 3 }, oninput: (e) => (r.description = e.target.value) }),
    h('input', { type: 'number', min: 0, value: r.qty, style: { width: '70px' }, oninput: (e) => (r.qty = Number(e.target.value)) }),
    h('input', { type: 'number', min: 0, step: '0.01', value: r.unitPrice, style: { width: '110px' }, oninput: (e) => (r.unitPrice = Number(e.target.value)) }),
    rows.length > 1 ? h('button', { class: 'icon-btn', type: 'button', onclick: () => { rows.splice(i, 1); draw(); } }, icon('x')) : null)));
  draw();
  const dlg = h('dialog', { class: 'dialog' },
    h('div', { class: 'dialog-head' }, h('h3', {}, `Edit ${inv.number}`), h('button', { class: 'icon-btn', type: 'button', onclick: () => dlg.close() }, icon('x'))),
    h('div', { class: 'dialog-body stack' },
      h('p', { class: 'muted small' }, 'Description · quantity · unit price'),
      list,
      h('div', {}, btn('Add a line', () => { rows.push({ description: 'Extra', qty: 1, unitPrice: 0 }); draw(); }, { cls: 'btn-sm', ic: 'plus' })),
      h('div', { class: 'row' }, btn('Save', async (e) => { if (await run(e.currentTarget, () => api(`/api/invoices/${inv.id}`, { method: 'PATCH', body: { items: rows } }), 'Invoice updated')) { dlg.close(); done(); } }, { cls: 'btn-primary' }), btn('Cancel', () => dlg.close(), { cls: 'btn-ghost' }))));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// ---------------------------------------------------------------------------
// Client Revisions
// ---------------------------------------------------------------------------

async function renderRevisions() {
  const root = $('#revisions-root');
  let list;
  try {
    [list] = await Promise.all([api('/api/revisions'), statusInfo()]);
  } catch (err) {
    fill(root, h('div', { class: 'callout red' }, err.message));
    return;
  }
  const open = list.filter((p) => ['needs_attention', 'revision_requested'].includes(p.stage));
  const rest = list.filter((p) => !open.includes(p));
  fill(root, 
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Client Revisions'), h('p', { class: 'muted' }, 'Client replies are matched to their project automatically. Tell the AI what to change, and the new version comes back to you for approval.')),
      btn('Check for replies', async (e) => { const r = await run(e.currentTarget, () => post('/api/emails/check-inbox')); if (r) toast(r.ok ? `${r.added} new repl${r.added === 1 ? 'y' : 'ies'}` : r.message, { error: !r.ok }); renderRevisions(); refreshCounts(); }, { ic: 'refresh' })),
    open.length ? h('div', { class: 'stack' }, open.map(revisionCard)) : h('div', { class: 'card' }, emptyState('refresh', 'No revisions requested', 'When a client replies to a delivery email asking for changes, it appears here with their feedback.')),
    rest.length ? h('div', { class: 'card', style: { marginTop: '16px' } }, cardHead('Recent feedback'),
      h('div', { class: 'attention' }, rest.slice(0, 20).map((p) => h('a', { class: 'attn', href: `#/projects/${p.id}` }, avatar(p), h('div', { class: 'grow' }, h('b', {}, p.name), h('span', { class: 'muted small' }, p.feedback[0] ? `"${p.feedback[0].text.slice(0, 110)}"` : `${p.revisions.length} revision(s)`)), stagePill(p))))) : null);
  schedule(renderRevisions, false);
}

function revisionCard(p) {
  const open = p.feedback.filter((f) => !f.handled);
  const key = `rev-${p.id}`;
  const sent = p.versions.find((v) => v.sentAt) || p.versions[0];
  const decide = (f, decision, msg) => (e) => run(e.currentTarget, () => post(`/api/cprojects/${p.id}/feedback/${encodeURIComponent(f.id)}`, { decision }), msg).then(() => { refreshCounts(); renderRevisions(); });
  const unclear = p.stage === 'needs_attention';
  return h('div', { class: 'card' },
    cardHead(h('div', { class: 'row' }, avatar(p), h('div', {}, h('h3', {}, h('a', { href: `#/projects/${p.id}`, style: { color: 'inherit' } }, p.name)), h('span', { class: 'muted small' }, `${p.number} · ${p.contact?.email || ''}`))), stagePill(p)),
    h('div', { class: 'detail-grid', style: { marginTop: 0 } },
      h('div', { class: 'stack' },
        h('div', {}, h('span', { class: 'label' }, unclear ? 'The client\'s reply (needs your decision)' : 'What the client said'),
          h('div', { class: 'stack', style: { gap: '10px' } }, (open.length ? open : p.feedback.slice(0, 1)).map((f) => h('div', { class: 'stack', style: { gap: '6px' } },
            h('div', { class: 'row small' }, pill((INTENT[f.intent] || [f.intent])[0], (INTENT[f.intent] || [0, 'grey'])[1]), h('span', { class: 'muted' }, `${f.from} · ${fmtDateTime(f.at)}`)),
            h('div', { class: `quote${f.intent === 'unclear' ? ' amber' : ''}` }, f.text),
            f.summary ? h('p', { class: 'small muted' }, `${f.by === 'ai' ? 'AI' : 'Cutline'}: ${f.summary}${f.changes?.length ? ` (${f.changes.join('; ')})` : ''}`) : null,
            unclear || f.intent === 'unclear' ? h('div', { class: 'row' },
              btn('It\'s a change request', decide(f, 'revision', 'Marked as a change request'), { cls: 'btn-sm btn-primary' }),
              btn('Client is happy', decide(f, 'completed', 'Project completed'), { cls: 'btn-sm' }),
              btn('Client declined', (e) => confirm('Mark the project as declined and void the invoice (no charge)?') && decide(f, 'declined', 'Declined; invoice voided')(e), { cls: 'btn-sm btn-danger' }),
              btn('No action needed', decide(f, 'ignore'), { cls: 'btn-sm btn-ghost' })) : null)))),
        noChangeNote(p, 'client'),
        !unclear ? h('div', { class: 'inline-form' },
          h('label', { class: 'label' }, 'My revision instructions for the AI'),
          draftField(`${key}-text`, h('textarea', { rows: 5, maxlength: 2000, placeholder: 'e.g. The client likes the overall video but wants more focus on the food preparation. Replace the opening shot with their cooking footage, make the product shots more prominent and end on their logo.' })),
          h('p', { class: 'help' }, 'The AI also receives the original brief, the client\'s uploads and their email. The new version replaces the active video; older versions stay in the history.'),
          h('div', { class: 'row' }, btn('Generate revised video', async (e) => {
            if (await run(e.currentTarget, () => post(`/api/cprojects/${p.id}/revise`, { instructions: drafts[`${key}-text`] || '' }), 'The AI is making the revision. It will appear in the Video Approval Centre')) {
              delete drafts[`${key}-text`];
              refreshCounts();
              renderRevisions();
            }
          }, { cls: 'btn-primary', ic: 'sparkle' }), btn('Open project', () => go(`#/projects/${p.id}`), { cls: 'btn-ghost' }))) : null),
      h('div', { class: 'stack' },
        sent ? h('div', {}, h('span', { class: 'label' }, `Video they saw (version ${sent.n})`), h('div', { class: 'videos' }, sent.videos.slice(0, 2).map((v) => h('div', { class: 'vtile', style: { width: '170px' } }, videoEl(v), h('span', { class: 'small' }, v.label))))) : null,
        p.versions.length > 1 ? h('details', { class: 'more', 'data-keep': '' }, h('summary', {}, `All versions (${p.versions.length})`), p.versions.map(versionBlock)) : null,
        h('details', { class: 'more', 'data-keep': '' }, h('summary', {}, 'Original submission'), requirementBadges(p.requirements), h('div', { style: { marginTop: '10px' } }, answersList(p.answers))),
        h('details', { class: 'more', 'data-keep': '' }, h('summary', {}, 'Their uploaded resources'), resourceThumbs(p.resources)))));
}

// ---------------------------------------------------------------------------
// Invoice Management
// ---------------------------------------------------------------------------

async function renderInvoices() {
  const root = $('#invoices-root');
  let list, biz;
  try {
    [list, biz] = await Promise.all([api('/api/invoices'), api('/api/business')]);
  } catch (err) {
    fill(root, h('div', { class: 'callout red' }, err.message));
    return;
  }
  const cur = biz.currency;
  const sum = (st) => list.filter((i) => i.status === st).reduce((s, i) => s + i.total, 0);
  const filter = drafts['inv-filter'] || 'all';
  const rows = list.filter((i) => filter === 'all' || i.status === filter);
  const act = (inv, path, body, msg) => (e) => run(e.currentTarget, () => post(`/api/invoices/${inv.id}/${path}`, body), msg).then(renderInvoices);
  fill(root, 
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Invoice Management'), h('p', { class: 'muted' }, 'Invoices are prepared when you approve a video and sent with the delivery email. You mark them paid; nothing is charged automatically, and declined projects are voided.')),
      h('a', { class: 'btn', href: '#/settings' }, icon('gear'), 'Pricing & business details')),
    biz.gaps.length ? h('div', { class: 'callout amber', style: { marginBottom: '16px' } }, `Add ${biz.gaps.join(', ')} so your invoices are complete. `, h('a', { href: '#/settings' }, 'Settings →')) : null,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, icon('clock'), 'Outstanding'), h('span', { class: 'stat-value' }, money(sum('issued'), cur)), h('span', { class: 'stat-sub' }, `${list.filter((i) => i.status === 'issued').length} sent, unpaid`)),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, icon('check'), 'Paid'), h('span', { class: 'stat-value' }, money(sum('paid'), cur)), h('span', { class: 'stat-sub' }, `${list.filter((i) => i.status === 'paid').length} invoices`)),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, icon('edit'), 'Drafts'), h('span', { class: 'stat-value' }, String(list.filter((i) => i.status === 'draft').length)), h('span', { class: 'stat-sub' }, 'waiting to be emailed')),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, icon('x'), 'Void'), h('span', { class: 'stat-value' }, String(list.filter((i) => i.status === 'void').length)), h('span', { class: 'stat-sub' }, 'declined, no charge'))),
    h('div', { class: 'toolbar' }, segment('inv-filter', [['all', 'All'], ['draft', 'Drafts'], ['issued', 'Unpaid'], ['paid', 'Paid'], ['void', 'Void']], filter, renderInvoices)),
    rows.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Invoice'), h('th', {}, 'Client'), h('th', {}, 'Date'), h('th', {}, 'Due'), h('th', { class: 'num' }, 'Total'), h('th', {}, 'Status'), h('th', {}, ''))),
      h('tbody', {}, rows.map((inv) => h('tr', {},
        h('td', {}, h('b', {}, inv.number), inv.cpNumber ? h('div', { class: 'small' }, h('a', { href: `#/projects/${inv.cpId}` }, inv.cpNumber)) : null),
        h('td', {}, h('b', {}, inv.client.business), h('div', { class: 'small muted' }, inv.client.email)),
        h('td', { class: 'small' }, fmtDate(inv.date)),
        h('td', { class: `small${inv.status === 'issued' && inv.dueDate < Date.now() ? ' bad' : ''}` }, inv.status === 'issued' || inv.status === 'draft' ? fmtDate(inv.dueDate) : '-'),
        h('td', { class: 'num' }, h('b', {}, money(inv.total, inv.currency))),
        h('td', {}, pill(INV_LABELS[inv.status], INV_TONES[inv.status]), inv.voidReason ? h('div', { class: 'small muted' }, inv.voidReason) : null),
        h('td', { class: 'num' }, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          h('a', { class: 'btn btn-sm', href: `/api/invoices/${inv.id}/pdf`, target: '_blank', title: 'Open PDF' }, icon('eye')),
          h('a', { class: 'btn btn-sm', href: `/api/invoices/${inv.id}/pdf?download=1`, title: 'Download PDF' }, icon('download')),
          inv.status === 'draft' ? btn('Edit', () => editInvoiceDialog(inv, renderInvoices), { cls: 'btn-sm' }) : null,
          inv.status === 'issued' ? btn('Mark paid', act(inv, 'paid', {}, 'Marked as paid'), { cls: 'btn-sm btn-primary' }) : null,
          inv.status === 'paid' ? btn('Mark unpaid', act(inv, 'unpaid', {}, 'Marked as not paid'), { cls: 'btn-sm btn-ghost' }) : null,
          ['draft', 'issued'].includes(inv.status) ? btn('Void', (e) => { const r = prompt('Void this invoice? The client will not be charged.\nReason:', 'Client declined'); if (r !== null) act(inv, 'void', { reason: r }, 'Invoice voided')(e); }, { cls: 'btn-sm btn-danger' }) : null,
          inv.status === 'void' ? btn('Restore', act(inv, 'unvoid', {}, 'Invoice restored'), { cls: 'btn-sm btn-ghost' }) : null)))))))
      : h('div', { class: 'card' }, emptyState('receipt', 'No invoices yet', 'An invoice is prepared automatically each time you approve a client\'s video.')));
}

// ---------------------------------------------------------------------------
// Settings: business details, pricing, invoices
// ---------------------------------------------------------------------------

export async function renderBusinessSettings() {
  const root = $('#biz-settings');
  let b;
  try {
    b = await api('/api/business');
  } catch {
    return;
  }
  const f = {};
  const inp = (k, label, attrs = {}, full = false, help = null) => {
    f[k] = draftField(`biz-${k}`, attrs.rows ? h('textarea', { ...attrs, disabled: !b.editable }) : h('input', { ...attrs, disabled: !b.editable }), b[k] ?? '');
    return h('div', { class: `field${full ? ' full' : ''}` }, h('label', { class: 'label' }, label), f[k], help ? h('p', { class: 'help' }, help) : null);
  };
  const sel = (k, label, options) => {
    f[k] = h('select', { disabled: !b.editable }, options.map(([v, l]) => h('option', { value: v, selected: String(b[k]) === String(v) }, l)));
    return h('div', { class: 'field' }, h('label', { class: 'label' }, label), f[k]);
  };
  const save = async (e) => {
    const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'number' ? Number(el.value) : el.value]));
    if (await run(e.currentTarget, () => post('/api/business', body), 'Business details saved')) {
      for (const k of Object.keys(f)) delete drafts[`biz-${k}`];
      renderBusinessSettings();
    }
  };
  const logoInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('logo', file);
    const res = await fetch('/api/business/logo', { method: 'POST', body: fd });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return toast(out.error || 'Upload failed', { error: true });
    toast('Logo saved');
    renderBusinessSettings();
  } });
  fill(root, 
    b.gaps.length ? h('div', { class: 'callout amber settings', style: { marginBottom: '16px' } }, `Add ${b.gaps.join(', ')}. They appear on invoices and client emails.`) : null,
    h('div', { class: 'panel settings' },
      h('h2', {}, 'Your business'),
      h('div', { class: 'form-grid' },
        inp('name', 'Business name', { maxlength: 80, placeholder: 'e.g. Bright Frame Studio' }),
        inp('contactName', 'Your name', { maxlength: 80 }),
        inp('email', 'Email', { type: 'email', maxlength: 120 }),
        inp('phone', 'Phone', { maxlength: 40 }),
        inp('website', 'Website', { maxlength: 120 }),
        inp('abn', 'ABN (optional)', { maxlength: 40 }),
        inp('address', 'Address (optional)', { rows: 2, maxlength: 300 }, true),
        h('div', { class: 'field full' }, h('span', { class: 'label' }, 'Logo (shown on invoices)'),
          h('div', { class: 'logo-box' }, h('div', { class: 'lb', style: b.logoUrl ? { backgroundImage: `url("${b.logoUrl}&t=${Date.now()}")` } : {} }, b.logoUrl ? '' : 'No logo'),
            h('label', { class: 'btn btn-sm' }, logoInput, 'Upload logo'),
            b.logoUrl ? btn('Remove', () => fetch('/api/business/logo', { method: 'DELETE' }).then(renderBusinessSettings), { cls: 'btn-sm btn-ghost' }) : null)))),
    h('div', { class: 'panel settings' },
      h('h2', {}, 'Pricing & invoices'),
      h('div', { class: 'form-grid' },
        inp('price', 'Price per video', { type: 'number', min: 0, step: '0.01' }, false, 'Used for every new invoice. You can change it per invoice before sending.'),
        inp('extraFormatPrice', 'Price per extra size (optional)', { type: 'number', min: 0, step: '0.01' }, false, 'When a client wants e.g. vertical + feed. 0 = included.'),
        sel('currency', 'Currency', [['AUD', 'AUD'], ['NZD', 'NZD'], ['USD', 'USD'], ['GBP', 'GBP'], ['EUR', 'EUR'], ['CAD', 'CAD']]),
        sel('taxMode', 'GST / tax', [['none', 'No GST (not registered)'], ['inclusive', 'Prices include GST'], ['exclusive', 'Add GST on top']]),
        inp('taxRate', 'Tax rate %', { type: 'number', min: 0, max: 50, step: '0.1' }),
        inp('paymentTerms', 'Payment due (days)', { type: 'number', min: 0, max: 120 }),
        inp('serviceDescription', 'Invoice line description', { maxlength: 200 }, true, '{business_name} becomes the client\'s business.'),
        inp('paymentDetails', 'How clients pay you', { rows: 3, maxlength: 600, placeholder: 'e.g. Bank: Commonwealth · BSB 062-000 · Account 1234 5678 · or PayID 0400 000 000' }, true),
        inp('invoicePrefix', 'Invoice number prefix', { maxlength: 12 }),
        inp('nextInvoice', 'Next invoice number', { type: 'number', min: 1 }),
        inp('invoiceNotes', 'Note at the bottom of invoices', { maxlength: 300 }, true)),
      h('div', { class: 'row', style: { marginTop: '16px' } }, btn('Save business details', save, { cls: 'btn-primary', disabled: !b.editable }), h('a', { class: 'btn btn-ghost', href: '#/emails' }, 'Email templates →'))));
}
