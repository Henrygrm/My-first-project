import { $, $$, api, copyText, fmtDuration, fmtSec, h, icon, slug, store, timeAgo, toast, upload } from './ui.js';
import { loadAssets as loadPreviewAssets, loadFonts, Player } from './preview.js';
import { RECIPES } from '/engine/recipes.js';
import * as ops from './ops.js';

// Must match package.json. If the server reports a different version, an
// old copy of Cutline is still running and new features won't work.
const APP_VERSION = '4.0.0';

const ROLE_COLORS = { hook: '#2563eb', setup: '#60a5fa', process: '#60a5fa', reveal: '#14b8a6', payoff: '#14b8a6', cta: '#7c3aed' };
const DEFAULTS = {
  business: 'restaurant', businessCustom: '', platform: 'tiktok', clipCount: 2, targetSeconds: 30,
  style: 'mix', music: 'auto', musicLevel: 'normal', mode: 'ai', reframe: 'auto', audio: 'original',
  onScreenText: true, speechSubtitles: false, instructions: '',
  adFormat: '9:16', adSeconds: 15, adCount: 2, adDirection: 'auto', adObjective: 'auto', adMusic: 'auto', adVoice: false, adVoiceName: 'coral', adReview: true, adInstructions: '',
};

const state = {
  status: null,
  server: null, // GET /api/settings
  project: null,
  tracks: [],
  settings: { ...DEFAULTS, ...store.get('settings', {}) },
  profile: store.get('profile', {}),
  job: null,
  drafts: {},
  openEditors: new Set(),
  clients: [],
  client: null, // the current project's client (brand kit), if any
  clientSel: null, // client selected on the Clients page
  studio: null,
  reopenStudio: null,
};

const saveSettings = () => store.set('settings', state.settings);
const aiKey = () => Boolean(state.status?.ai?.configured);
const aiOn = () => aiKey() && state.settings.mode === 'ai';
const ffmpegOk = () => Boolean(state.status?.ffmpeg?.available);
const versionOk = () => state.status?.version === APP_VERSION;
const styleLabel = (id) => state.status?.styles?.find((s) => s.id === id)?.label || 'Clip';

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function seg(container, options, value, onChange) {
  container.replaceChildren(...options.map(([val, label]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(val === value),
    onclick: () => {
      onChange(val);
      $$('button', container).forEach((b, i) => b.setAttribute('aria-checked', String(options[i][0] === val)));
    },
  }, label)));
}

const setSetting = (key, after) => (val) => {
  state.settings[key] = val;
  saveSettings();
  after?.(val);
};

async function refreshStatus() {
  try {
    state.status = await api('/api/status');
  } catch {
    state.status = null;
  }
  renderTopbar();
  renderAlerts();
}

function renderTopbar() {
  const pill = $('#ai-pill');
  pill.className = 'ai-pill';
  let label;
  if (!state.status) [label] = ['Offline', pill.classList.add('err')];
  else if (aiOn()) [label] = ['AI on', pill.classList.add('on')];
  else if (aiKey()) [label] = ['AI off (free mode)', pill.classList.add('off')];
  else [label] = ['AI off: add key', pill.classList.add('off')];
  $('.label', pill).textContent = label;
}

function renderAlerts() {
  const box = $('#alerts');
  const alerts = [];
  const alert = (kind, title, text) => h('div', { class: `alert ${kind}` }, icon('alert'), h('div', {}, h('b', {}, title), text ? h('span', { class: 'muted' }, text) : null));
  if (!state.status) {
    alerts.push(alert('err', "Cutline isn't running.", 'Double-click "Start Cutline" in the My-first-project folder, then reload this page.'));
  } else {
    if (!versionOk()) {
      alerts.push(alert('err', 'An old copy of Cutline is still running, so music and other new features won\'t work.', 'Close every Terminal window, then double-click "Start Cutline" in the My-first-project folder and reload this page.'));
    }
    if (!ffmpegOk()) {
      alerts.push(alert('err', 'FFmpeg is missing, so videos can\'t be made.', 'In Terminal run: brew install ffmpeg, then restart Cutline.'));
    }
  }
  box.replaceChildren(...alerts);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Old links (#/ads, #/clients, …) still work.
const ALIASES = { '': 'dashboard', home: 'production/clips', ads: 'production', clients: 'projects/clients', music: 'production/music', requests: 'onboarding' };
const SECTION_NAMES = {
  dashboard: 'Dashboard', onboarding: 'Client Onboarding', projects: 'Client Projects', production: 'AI Video Production', approval: 'Video Approval Centre',
  emails: 'Email Management', pending: 'Pending Emails', revisions: 'Client Revisions', invoices: 'Invoice Management', settings: 'Settings',
};

function route() {
  let name = location.hash.replace(/^#\/?/, '');
  if (name in ALIASES) name = ALIASES[name];
  const [top, sub, extra] = name.split('/');
  const nav = SECTION_NAMES[top] ? top : 'dashboard';
  // Which <section> shows.
  let page = nav;
  if (nav === 'production') page = sub === 'clips' ? 'home' : sub === 'music' ? 'music' : 'ads';
  if (nav === 'projects' && sub === 'clients') page = 'clients';
  $$('.page').forEach((p) => (p.hidden = p.id !== `page-${page}`));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === nav));
  $('#appbar-section').textContent = SECTION_NAMES[nav];
  document.title = `${SECTION_NAMES[nav]} · Cutline`;
  $('#production-head').hidden = nav !== 'production';
  $('#projects-head').hidden = !(nav === 'projects' && (!sub || sub === 'clients'));
  $$('#production-head .tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === page));
  $$('#projects-head .tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (page === 'clients' ? 'clients' : 'projects')));
  document.body.classList.remove('nav-open');
  window.scrollTo(0, 0);
  if (page === 'music') renderMusicPage();
  if (page === 'settings') {
    renderSettings();
    ops.renderBusinessSettings();
  }
  if (page === 'home') renderHome();
  if (page === 'ads') renderAds();
  if (page === 'clients') renderClients();
  ops.route(nav, sub, extra);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function ensureProject() {
  if (state.project) return state.project;
  const p = await api('/api/projects', { method: 'POST', body: { name: $('#project-name').value.trim() || 'New project' } });
  setProject(p);
  await patchProject({ business: state.settings.business, businessCustom: state.settings.businessCustom, platform: state.settings.platform, profile: state.profile });
  return state.project;
}

function setProject(p) {
  state.project = p;
  state.drafts = {};
  state.openEditors.clear();
  if (p) store.set('project', p.id);
  else store.remove('project');
  $('#project-name').value = p ? p.name : 'New project';
}

async function patchProject(fields) {
  if (!state.project) return;
  try {
    const p = await api(`/api/projects/${state.project.id}`, { method: 'PATCH', body: fields });
    state.project = { ...state.project, ...p };
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function reloadProject() {
  if (state.project) state.project = await api(`/api/projects/${state.project.id}`);
}

async function openProject(id) {
  const p = await api(`/api/projects/${id}`);
  setProject(p);
  Object.assign(state.settings, {
    business: p.business || state.settings.business,
    businessCustom: p.businessCustom || '',
    platform: p.platform || state.settings.platform,
    instructions: p.instructions ?? state.settings.instructions,
  });
  for (const k of ['clipCount', 'targetSeconds', 'style', 'music', 'musicLevel']) {
    if (p.settings?.[k] !== undefined) state.settings[k] = p.settings[k];
  }
  const as = p.adSettings;
  if (as) Object.assign(state.settings, { adFormat: as.format, adSeconds: as.seconds, adCount: as.count, adDirection: as.direction || 'auto', adObjective: as.objective || 'auto', adMusic: as.music, adVoice: Boolean(as.voiceover), adVoiceName: as.voice || 'coral', adReview: as.review !== false });
  if (p.profile && Object.values(p.profile).some(Boolean)) state.profile = { ...p.profile };
  saveSettings();
  await loadCurrentClient();
  route();
  if (p.activeJob) pollJob(p.activeJob);
  else if (p.lastJob && ['error', 'interrupted'].includes(p.lastJob.status)) showJobError(p.lastJob.error, p.lastJob.id);
  else setJobUi({ hidden: true });
}

async function newProject() {
  if (state.job) return toast('Wait for the current job to finish first.', { error: true });
  setProject(null);
  await ensureProject();
  route();
  $('#project-name').select();
}

async function showProjects() {
  const dlg = $('#projects-dialog');
  const list = $('#project-list');
  list.replaceChildren(h('li', { class: 'muted small' }, 'Loading…'));
  dlg.showModal();
  const projects = await api('/api/projects').catch(() => []);
  const bizLabel = (id, custom) => custom || state.status?.businesses.find((b) => b.id === id)?.label || id;
  if (!projects.length) return list.replaceChildren(h('li', { class: 'muted small' }, 'No projects yet.'));
  list.replaceChildren(...projects.map((p) => h('li', { class: `project-item${p.id === state.project?.id ? ' current' : ''}` },
    h('div', { class: 'pthumb', style: p.thumb ? { backgroundImage: `url("${p.thumb}")` } : {} }),
    h('div', { class: 'pmeta', role: 'button', tabindex: '0', onclick: () => { dlg.close(); openProject(p.id); } },
      h('b', {}, p.name),
      h('small', {}, `${bizLabel(p.business, p.businessCustom)} · ${p.videoCount} video${p.videoCount === 1 ? '' : 's'} · ${p.clipCount} clip${p.clipCount === 1 ? '' : 's'} · ${timeAgo(p.updatedAt)}`)),
    h('button', { class: 'icon-btn', title: 'Delete', 'aria-label': `Delete ${p.name}`, onclick: async () => {
      if (!confirm(`Delete "${p.name}" and its footage and clips?`)) return;
      try {
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        if (p.id === state.project?.id) {
          setProject(null);
          route();
        }
        showProjects();
      } catch (err) {
        toast(err.message, { error: true });
      }
    } }, icon('trash')),
  )));
}

// ---------------------------------------------------------------------------
// Home: controls
// ---------------------------------------------------------------------------

function renderHome() {
  renderControls();
  renderVideos();
  renderResults();
}

function renderControls() {
  const s = state.settings;
  const st = state.status;
  const bizSel = $('#biz-type');
  bizSel.replaceChildren(...(st?.businesses || []).map((b) => h('option', { value: b.id, selected: b.id === s.business }, b.label)));
  $('#biz-custom').hidden = s.business !== 'other';
  $('#biz-custom').value = s.businessCustom || '';

  for (const input of $$('[data-profile]')) input.value = state.profile[input.dataset.profile] || '';
  renderProfileSummary();

  seg($('#platform-seg'), (st?.platforms || []).map((p) => [p.id, p.label.replace('Instagram ', '').replace('YouTube ', '')]), s.platform, setSetting('platform', (v) => patchProject({ platform: v })));
  seg($('#length-seg'), [[15, '15s'], [30, '30s'], [45, '45s'], [60, '60s']], s.targetSeconds, setSetting('targetSeconds'));
  seg($('#clips-seg'), [[1, '1'], [2, '2'], [3, '3'], [4, '4']], s.clipCount, setSetting('clipCount'));

  $('#style-select').replaceChildren(
    h('option', { value: 'mix', selected: s.style === 'mix' }, aiOn() ? 'AI picks the best style per clip' : 'Mix of styles'),
    ...(st?.styles || []).map((x) => h('option', { value: x.id, selected: x.id === s.style }, x.label)),
  );
  renderMusicSelect();

  $('#notes-block').hidden = !aiOn();
  $('#instructions').value = s.instructions || '';
  updateGenerateState();
}

function renderProfileSummary() {
  const p = state.profile;
  $('#profile-summary').textContent = p.name ? `· ${p.name}` : '· helps the AI';
  $('#ad-profile-summary').textContent = p.name ? `· ${p.name}` : '';
  if (!p.name && !state.project?.plan) $('#profile-box').open = true;
}

function renderMusicSelect() {
  const s = state.settings;
  if (s.music !== 'auto' && s.music !== 'none' && !state.tracks.some((t) => t.id === s.music)) s.music = 'auto';
  $('#music-select').replaceChildren(
    h('option', { value: 'auto', selected: s.music === 'auto' }, state.tracks.length ? 'Auto (matches each clip)' : 'Auto (add songs first)'),
    h('option', { value: 'none', selected: s.music === 'none' }, 'No music'),
    ...state.tracks.map((t) => h('option', { value: t.id, selected: s.music === t.id }, t.name)),
  );
}

function updateGenerateState() {
  const videos = state.project?.videos?.length || 0;
  let reason = '';
  if (!state.status) reason = "Cutline isn't running.";
  else if (!versionOk()) reason = 'Restart Cutline first (see the red message at the top).';
  else if (!ffmpegOk()) reason = 'Install FFmpeg first.';
  else if (!videos) reason = 'Add footage to start.';
  else if (state.job) reason = 'Working…';
  $('#btn-generate').disabled = Boolean(reason);
  $('#btn-generate-label').textContent = aiOn() ? 'Generate with AI' : 'Generate (free mode)';
  $('#gen-hint').textContent = reason || (aiOn() ? '' : aiKey() ? 'Free mode is on in Settings: no AI planning.' : 'No AI yet: add your Claude key in Settings for AI-planned clips.');
  const ask = $('#ask-input');
  const canAsk = Boolean(state.project?.plan) && !state.job && versionOk();
  ask.disabled = !canAsk;
  $('#ask-send').disabled = !canAsk;
  $('#ask-clip').disabled = !canAsk;
  ask.placeholder = !state.project?.plan
    ? 'Generate clips first, then tell the AI what to change here'
    : aiOn()
      ? 'Tell the AI what to change, e.g. "make clip 2 punchier and open on the reveal"'
      : 'e.g. "make clip 2 15 seconds", "no music", "hook: Wait for it", "redo clip 1"';
}

// ---------------------------------------------------------------------------
// Home: footage
// ---------------------------------------------------------------------------

function renderVideos() {
  const videos = state.project?.videos || [];
  const total = videos.reduce((s, v) => s + v.meta.duration, 0);
  $('#footage-total').textContent = videos.length ? `${videos.length} · ${fmtDuration(total)}` : '';
  $('#video-list').replaceChildren(...videos.map((v, i) => h('li', { class: 'video-item' },
    h('button', { class: 'video-thumb', title: 'Preview', onclick: () => previewVideo(`/media/${state.project.id}/videos/${v.file}`, v.name) },
      h('img', { src: `/media/${state.project.id}/videos/${v.thumb}`, alt: '' }), h('span', { class: 'vnum' }, i + 1)),
    h('div', { class: 'video-meta' }, h('b', { title: v.name }, v.name),
      h('small', {}, `${fmtDuration(v.meta.duration)} · ${v.meta.orientation}${v.meta.hasAudio ? '' : ' · no sound'}`)),
    h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${v.name}`, onclick: () => removeVideo(v) }, icon('trash')),
  )));
  updateGenerateState();
}

function previewVideo(src, title) {
  $('#video-dialog-title').textContent = title;
  const player = $('#video-dialog-player');
  $('#video-dialog-note').hidden = true;
  player.hidden = false;
  player.onerror = () => {
    player.hidden = true;
    $('#video-dialog-note').hidden = false;
  };
  player.src = src;
  $('#video-dialog').showModal();
  player.play().catch(() => {});
}

async function removeVideo(v) {
  if (state.job) return toast('Wait for the current job to finish first.', { error: true });
  if (state.project.plan && !confirm(`Remove "${v.name}"? You'll need to generate again.`)) return;
  try {
    state.project = await api(`/api/projects/${state.project.id}/videos/${v.id}`, { method: 'DELETE' });
    renderVideos();
    renderResults();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function showUploadProgress(zone, text, pct) {
  const prog = $('.dz-progress', zone);
  if (text === null) {
    prog.hidden = true;
    return;
  }
  prog.hidden = false;
  $('em', prog).textContent = text;
  $('i', prog).style.width = `${Math.round((pct || 0) * 100)}%`;
}

async function handleVideoFiles(files) {
  files = [...files].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts)$/i.test(f.name));
  if (!files.length) return toast('Those files are not videos.', { error: true });
  if (state.job) return toast('Wait for the current job to finish first.', { error: true });
  const zone = $('#dropzone');
  showUploadProgress(zone, `Uploading ${files.length} video${files.length > 1 ? 's' : ''}…`, 0);
  try {
    await ensureProject();
    const res = await upload(`/api/projects/${state.project.id}/videos`, 'videos', files, (p) => showUploadProgress(zone, p >= 1 ? 'Reading videos…' : `Uploading… ${Math.round(p * 100)}%`, p));
    state.project.videos = res.videos;
    renderVideos();
    for (const f of res.failed) toast(`${f.name}: ${f.error}`, { error: true });
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    showUploadProgress(zone, null);
    $('#file-input').value = '';
  }
}

// ---------------------------------------------------------------------------
// Home: generate, ask, jobs
// ---------------------------------------------------------------------------

async function generate() {
  const s = state.settings;
  s.instructions = $('#instructions').value;
  saveSettings();
  try {
    await ensureProject();
    await patchProject({ profile: state.profile });
    const { jobId } = await api(`/api/projects/${state.project.id}/generate`, {
      method: 'POST',
      body: {
        business: s.business, businessCustom: s.businessCustom, profile: state.profile, platform: s.platform,
        instructions: aiOn() ? s.instructions : '', clipCount: s.clipCount, targetSeconds: s.targetSeconds,
        mode: aiOn() ? 'ai' : 'auto', style: s.style, music: s.music, musicLevel: s.musicLevel,
        reframe: s.reframe, audio: s.audio, onScreenText: s.onScreenText, speechSubtitles: s.speechSubtitles,
      },
    });
    pollJob(jobId);
  } catch (err) {
    showJobError(err.message);
  }
}

async function ask(e) {
  e.preventDefault();
  const input = $('#ask-input');
  const request = input.value.trim();
  if (!request || !state.project?.plan) return;
  const which = $('#ask-clip').value;
  try {
    const { jobId } = await api(`/api/projects/${state.project.id}/revise`, {
      method: 'POST',
      body: { request, clipIndex: which === 'all' ? null : Number(which), mode: aiOn() ? 'ai' : 'auto' },
    });
    input.value = '';
    state.project.chat = [...(state.project.chat || []), { who: 'you', text: which === 'all' ? request : `Clip ${Number(which) + 1}: ${request}` }];
    pollJob(jobId, 'revise');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function renderOne(index) {
  const draft = state.drafts[index];
  const clip = draft ? { ...draft, segments: draft.segments.filter((sg) => !sg.removed) } : undefined;
  if (clip && !clip.segments.length) return toast('Keep at least one shot.', { error: true });
  try {
    const { jobId } = await api(`/api/projects/${state.project.id}/clips/${index}/render`, { method: 'POST', body: { clip, options: { musicLevel: state.settings.musicLevel } } });
    state.drafts[index] = null;
    pollJob(jobId);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// The same progress shows on the Home and Ads pages.
function setJobUi({ hidden, error, stage, pct, retry }) {
  for (const pre of ['', 'ad-']) {
    const box = $(`#${pre}job`);
    if (hidden !== undefined) box.hidden = hidden;
    if (error !== undefined) box.classList.toggle('error', error);
    if (retry !== undefined) $('.job-retry', box).hidden = !retry;
    if (stage !== undefined) $(`#${pre}job-stage`).textContent = stage;
    if (pct !== undefined) {
      $(`#${pre}job-pct`).textContent = pct === null ? '' : `${Math.round(pct * 100)}%`;
      $(`#${pre}job-bar`).style.width = `${Math.round((pct || 0) * 100)}%`;
    }
  }
}

// A failed or interrupted job can be run again with the same settings.
let retryJobId = null;
function showJobError(message, jobId = null) {
  retryJobId = jobId;
  setJobUi({ hidden: false, error: true, stage: message, pct: null, retry: Boolean(jobId) });
}

async function retryJob() {
  if (!retryJobId || state.job) return;
  try {
    const { jobId, kind } = await api(`/api/jobs/${retryJobId}/retry`, { method: 'POST' });
    retryJobId = null;
    pollJob(jobId, kind);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function refreshViews() {
  renderResults();
  renderAdResults();
}

async function pollJob(jobId, kind = null) {
  state.job = { id: jobId, kind };
  retryJobId = null;
  setJobUi({ hidden: false, error: false, stage: 'Starting…', pct: 0, retry: false });
  refreshViews();
  let misses = 0;
  let finished = null;
  while (state.job?.id === jobId) {
    let job;
    try {
      job = await api(`/api/jobs/${jobId}`);
      misses = 0;
    } catch (err) {
      if (err.status === 404) {
        state.job = null;
        setJobUi({ hidden: true });
        toast('Cutline restarted. Anything unfinished has a Render button.', { error: true });
        break;
      }
      if (!err.status && ++misses <= 15) {
        setJobUi({ stage: 'Lost connection to Cutline, retrying…' });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      state.job = null;
      showJobError(err.status ? err.message : 'Cutline stopped. Double-click "Start Cutline", then reload this page.');
      break;
    }
    if (state.job && !state.job.kind) state.job.kind = job.kind;
    setJobUi({ stage: job.stage, pct: job.progress });
    if (job.status === 'interrupted') job.status = 'error';
    if (job.status === 'done' || job.status === 'error') {
      state.job = null;
      finished = job;
      if (job.status === 'error') {
        showJobError(job.error, job.id);
        if (job.kind === 'revise' || job.kind === 'ads-revise') toast(job.error, { error: true });
      } else {
        setTimeout(() => { if (!state.job) setJobUi({ hidden: true }); }, 2000);
        const done = { generate: 'Clips ready', render: 'Clip updated', ads: 'Ads ready', 'ad-render': 'Ad updated' }[job.kind];
        if (done) toast(done);
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  try {
    await reloadProject();
  } catch {}
  refreshViews();
  if (finished?.status === 'done' && state.reopenStudio?.jobId === jobId) {
    const { i } = state.reopenStudio;
    state.reopenStudio = null;
    openStudio(i);
  }
}

// ---------------------------------------------------------------------------
// Home: results
// ---------------------------------------------------------------------------

function renderChat() {
  const chat = state.project?.chat || [];
  const box = $('#chat');
  const msgs = chat.slice(-12).map((m) => h('div', { class: `msg ${m.who}${m.error ? ' error' : ''}` }, m.text));
  if (state.job?.kind === 'revise') msgs.push(h('div', { class: 'msg cutline pending' }, aiOn() ? 'The AI is working on it…' : 'Working on it…'));
  box.replaceChildren(...msgs);
  box.scrollTop = box.scrollHeight;
}

function renderResults() {
  const plan = state.project?.plan;
  const clips = state.project?.clips || [];
  const askClip = $('#ask-clip');
  const prev = askClip.value;
  askClip.replaceChildren(h('option', { value: 'all' }, 'All clips'), ...(plan?.clips || []).map((_, i) => h('option', { value: String(i) }, `Clip ${i + 1}`)));
  if ([...askClip.options].some((o) => o.value === prev)) askClip.value = prev;
  renderChat();
  updateGenerateState();

  const strategy = $('#strategy');
  strategy.replaceChildren();
  if (plan) {
    if (plan.source === 'ai' && plan.strategy) strategy.append(h('div', { class: 'strategy' }, h('b', {}, 'AI plan'), plan.strategy));
    if (plan.source === 'auto') strategy.append(h('div', { class: 'strategy muted' }, h('b', {}, 'Free mode'), 'Shots picked by movement and sound, text from templates. Add your Claude key in Settings for clips planned around this business.'));
    if (plan.musicNote) strategy.append(h('div', { class: 'notice' }, plan.musicNote));
    const noMusic = plan.clips.filter((c) => !c.music).length;
    if (state.tracks.length && noMusic && state.settings.music !== 'none') {
      strategy.append(h('div', { class: 'notice' }, `${noMusic === plan.clips.length ? 'These clips have' : `${noMusic} clip${noMusic > 1 ? 's have' : ' has'}`} no music. Generate again, or type "add music" in the box above.`));
    }
  }

  const box = $('#clips');
  if (!plan) {
    box.replaceChildren(h('div', { class: 'empty' },
      h('b', {}, state.job ? 'Making your clips…' : 'No clips yet'),
      h('span', {}, state.job ? 'This can take a few minutes.' : 'Pick the business, add footage and press Generate.')));
    return;
  }
  box.replaceChildren(h('div', { class: 'clips-grid' }, plan.clips.map((clip, i) => clipCard(clip, clips[i], i))));
}

function clipCard(clip, rendered, i) {
  const pid = state.project.id;
  const base = `${slug(state.project.name)}-clip-${i + 1}`;
  const busy = Boolean(state.job);
  const postText = [clip.post_caption, (clip.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  const editing = state.openEditors.has(i);

  const media = rendered
    ? h('div', { class: 'clip-video' },
      h('video', { src: `/media/${pid}/output/${rendered.file}`, poster: `/media/${pid}/output/${rendered.thumb}`, controls: true, playsinline: true, preload: 'metadata' }),
      h('span', { class: 'dur' }, fmtDuration(rendered.duration)))
    : h('div', { class: 'clip-video' }, h('div', { class: 'clip-pending' }, busy ? 'Rendering…' : h('div', {},
      h('p', {}, 'Not rendered yet.'), h('br'),
      h('button', { class: 'btn btn-sm', onclick: () => renderOne(i), disabled: busy || !ffmpegOk() }, icon('play'), 'Render'))));

  return h('article', { class: 'clip' }, media,
    h('div', { class: 'clip-body' },
      h('div', { class: 'clip-title' }, `${i + 1}. ${clip.title}`),
      h('div', { class: 'badges' },
        h('span', { class: 'badge style' }, styleLabel(clip.style)),
        clip.angle ? h('span', { class: 'badge' }, clip.angle) : null,
        h('span', { class: 'badge' }, clip.music ? `♪ ${clip.music.name}` : 'No music')),
      clip.why_it_works ? h('div', { class: 'clip-why' }, h('b', {}, 'Why: '), clip.why_it_works) : null,
      clip.lengthNote ? h('div', { class: 'clip-note' }, clip.lengthNote) : null,
      h('div', { class: 'clip-actions' },
        rendered ? h('a', { class: 'btn btn-sm btn-primary', href: `/media/${pid}/output/${rendered.file}`, download: `${base}.mp4` }, icon('download'), 'MP4') : null,
        postText ? h('button', { class: 'btn btn-sm', onclick: () => copyText(postText), title: 'Copy post caption + hashtags' }, icon('copy'), 'Caption') : null,
        h('button', { class: 'btn btn-sm', 'aria-expanded': String(editing), onclick: () => {
          editing ? state.openEditors.delete(i) : state.openEditors.add(i);
          renderResults();
        } }, icon('edit'), 'Edit')),
      editing ? clipEditor(clip, rendered, i, busy) : null));
}

function clipEditor(clip, rendered, i, busy) {
  const draft = (state.drafts[i] ??= structuredClone({ hook_text: clip.hook_text, cta_text: clip.cta_text, segments: clip.segments, style: clip.style, music: clip.music?.id || 'none' }));
  const bind = (obj, key) => (e) => { obj[key] = e.target.value; };
  return h('div', { class: 'clip-edit' },
    h('label', {}, 'Hook'),
    h('input', { value: draft.hook_text || '', maxlength: '80', oninput: bind(draft, 'hook_text') }),
    h('label', {}, 'Shots and captions'),
    h('div', { class: 'seg-edit-list' }, draft.segments.map((sg) => {
      const row = h('div', { class: `seg-edit${sg.removed ? ' removed' : ''}` },
        h('span', { class: 'role', style: { background: ROLE_COLORS[sg.role] || '#6aa8ff' } }, sg.role || 'shot'),
        h('input', { value: sg.caption || '', placeholder: 'No caption', maxlength: '60', oninput: bind(sg, 'caption') }),
        h('button', { class: 'icon-btn', title: sg.removed ? 'Put back' : 'Remove shot', onclick: () => {
          sg.removed = !sg.removed;
          row.classList.toggle('removed', sg.removed);
          row.querySelector('.icon-btn').replaceChildren(icon(sg.removed ? 'refresh' : 'trash'));
        } }, icon(sg.removed ? 'refresh' : 'trash')),
        h('span', { class: 'src' }, `Video ${sg.video + 1} · ${fmtSec(sg.start)}–${fmtSec(sg.end)}${sg.speed !== 1 ? ` · ${sg.speed}×` : ''}${sg.layout === 'split' ? ' · split screen' : ''}`));
      return row;
    })),
    h('label', {}, 'Style'),
    h('select', { onchange: (e) => (draft.style = e.target.value) }, (state.status?.styles || []).map((st) => h('option', { value: st.id, selected: st.id === draft.style }, st.label))),
    h('label', {}, 'Music'),
    h('select', { onchange: (e) => (draft.music = e.target.value) },
      h('option', { value: 'none', selected: draft.music === 'none' }, 'No music'),
      state.tracks.map((t) => h('option', { value: t.id, selected: t.id === draft.music }, t.name))),
    h('label', {}, 'Call to action'),
    h('input', { value: draft.cta_text || '', maxlength: '60', oninput: bind(draft, 'cta_text') }),
    rendered ? h('a', { class: 'muted small', href: `/media/${state.project.id}/output/${rendered.srt}`, download: `${slug(state.project.name)}-clip-${i + 1}.srt` }, 'Download captions file (.srt)') : null,
    h('button', { class: 'btn btn-sm btn-primary', disabled: busy || !ffmpegOk(), onclick: () => renderOne(i) }, icon('refresh'), 'Save and re-render'));
}


// ---------------------------------------------------------------------------
// Ads page
// ---------------------------------------------------------------------------

const directionLabel = (id) => (id === 'auto' ? 'Auto' : state.status?.ads?.directions.find((d) => d.id === id)?.label || id);
const RECIPE_COLORS = { product_hero: '#2563eb', photo_full: '#3b82f6', gallery: '#0ea5e9', compare: '#6366f1', kinetic: '#8b5cf6', features: '#14b8a6', offer: '#ec4899', review: '#f59e0b', stat: '#7c3aed', process: '#10b981', footage: '#60a5fa', location: '#f97316', cta: '#64748b' };

function renderAds() {
  renderAdClient();
  renderAdControls();
  renderAdAssets();
  renderAdResults();
}

function renderAdClient() {
  const card = $('#ad-client-card');
  const c = state.client;
  $('#ad-biz-block').hidden = Boolean(c);
  if (!c) {
    card.replaceChildren(h('div', { class: 'client-empty' },
      h('div', {}, h('b', {}, 'No client selected'), h('span', { class: 'muted small' }, 'Pick a client to use their saved logo, colours and details.')),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => chooseClient() }, icon('users'), 'Choose client')));
    return;
  }
  const biz = state.status?.businesses.find((b) => b.id === c.business);
  card.replaceChildren(
    h('div', { class: 'client-row' },
      c.logo ? h('div', { class: 'client-logo', style: { backgroundImage: `url("/client-files/${c.id}/${c.logo.thumb}")` } }) : h('div', { class: 'client-logo empty' }, (c.name || '?')[0]),
      h('div', { class: 'client-meta' }, h('b', {}, c.name), h('span', { class: 'muted small' }, c.businessCustom || biz?.label || '')),
      h('div', { class: 'swatches' }, (c.brand?.colors || []).map((col) => h('i', { style: { background: col }, title: col })))),
    h('div', { class: 'client-actions' },
      h('a', { class: 'muted small', href: `#/clients`, onclick: () => (state.clientSel = c.id) }, 'Edit brand kit'),
      h('button', { class: 'link-btn small', type: 'button', onclick: () => chooseClient() }, 'Switch client')),
  );
}

function renderAdControls() {
  const s = state.settings;
  const st = state.status;
  $('#ad-biz-type').replaceChildren(...(st?.businesses || []).map((b) => h('option', { value: b.id, selected: b.id === s.business }, b.id === 'other' && s.businessCustom ? s.businessCustom : b.label)));
  for (const input of $$('[data-profile]')) input.value = state.profile[input.dataset.profile] || '';
  renderProfileSummary();
  const ads = st?.ads || { formats: [], lengths: [], directions: [], objectives: [] };
  $('#ad-objective').replaceChildren(...ads.objectives.map((o) => h('option', { value: o.id, selected: o.id === s.adObjective }, o.id === 'auto' ? (aiOn() ? 'AI decides' : 'Automatic') : o.label)));
  $('#ad-direction').replaceChildren(
    h('option', { value: 'auto', selected: s.adDirection === 'auto' }, state.client?.brand?.direction && state.client.brand.direction !== 'auto' ? `Client's look (${directionLabel(state.client.brand.direction)})` : aiOn() ? 'AI picks per ad' : 'Varied'),
    ...ads.directions.map((d) => h('option', { value: d.id, selected: d.id === s.adDirection, title: d.brief }, d.label)),
  );
  seg($('#ad-format-seg'), ads.formats.map((f) => [f.id, f.id]), s.adFormat, setSetting('adFormat'));
  seg($('#ad-length-seg'), ads.lengths.map((l) => [l, `${l}s`]), s.adSeconds, setSetting('adSeconds'));
  seg($('#ad-count-seg'), [[1, '1'], [2, '2'], [3, '3']], s.adCount, setSetting('adCount'));
  if (s.adMusic !== 'auto' && s.adMusic !== 'none' && !state.tracks.some((t) => t.id === s.adMusic)) s.adMusic = 'auto';
  $('#ad-music-select').replaceChildren(
    h('option', { value: 'auto', selected: s.adMusic === 'auto' }, state.tracks.length ? (aiOn() ? 'AI picks the best song' : 'Auto (matches the look)') : 'Auto (add songs first)'),
    h('option', { value: 'none', selected: s.adMusic === 'none' }, 'No music'),
    ...state.tracks.map((t) => h('option', { value: t.id, selected: s.adMusic === t.id }, t.name)),
  );
  const voice = st?.providers?.voice;
  $('#ad-voice').replaceChildren(...Object.entries(voice?.voices || {}).map(([id, label]) => h('option', { value: id, selected: id === s.adVoiceName }, label)));
  $('#ad-voice-on').checked = Boolean(s.adVoice) && Boolean(voice?.configured);
  $('#ad-voice-on').disabled = !voice?.configured;
  $('#ad-voice').disabled = !voice?.configured || !s.adVoice;
  $('#ad-voice-note').textContent = !voice?.configured ? 'Add an OpenAI key in Settings to turn on voiceovers (about 1–2 cents per ad).' : s.adVoice ? (aiOn() ? 'The AI writes the script; edit it in the Studio.' : 'Needs the Claude key to write the script.') : '';
  $('#ad-review-row').hidden = !aiOn();
  $('#ad-review-on').checked = s.adReview !== false;
  $('#ad-notes-block').hidden = !aiOn();
  $('#ad-instructions').value = s.adInstructions || '';
  updateAdState();
}

function updateAdState() {
  const p = state.client?.profile || state.profile;
  let reason = '';
  if (!state.status) reason = "Cutline isn't running.";
  else if (!versionOk()) reason = 'Restart Cutline first (see the red message at the top).';
  else if (!ffmpegOk()) reason = 'Install FFmpeg first.';
  else if (!p.name && !p.services) reason = 'Fill in the business name and what they sell.';
  else if (state.job) reason = 'Working…';
  $('#ad-generate').disabled = Boolean(reason);
  $('#ad-generate-label').textContent = aiOn() ? 'Make ads with AI' : 'Make ads (free mode)';
  const photos = (state.project?.adAssets || []).filter((a) => a.kind === 'photo').length;
  $('#ad-hint').textContent = reason || (!photos ? 'Tip: add product photos. Ads are built around them.' : aiOn() ? '' : 'Free mode: no AI. Add a Claude key in Settings for AI-directed ads.');
  const can = Boolean(state.project?.adPlan) && !state.job && versionOk();
  for (const id of ['ad-ask-input', 'ad-ask-send', 'ad-ask-which']) $(`#${id}`).disabled = !can;
  $('#ad-ask-input').placeholder = !state.project?.adPlan
    ? 'Make ads first, then tell the AI what to change here'
    : aiOn() ? 'Tell the AI what to change, e.g. "ad 1: open on the coffee and make it luxury"' : 'e.g. "make it 20 seconds", "make it luxury", "light background", "hook: Your text"';
}

function photoWarning(a) {
  const an = a.analysis;
  if (!an) return '';
  if (Math.max(an.w, an.h) < 900) return `Small photo (${an.w}×${an.h}): looks soft full screen`;
  if (an.sharpness < 60) return 'Looks blurry';
  if (an.brightness < 45) return 'Very dark';
  return '';
}

function renderAdAssets() {
  const pid = state.project?.id;
  const assets = state.project?.adAssets || [];
  const photos = assets.filter((a) => a.kind === 'photo');
  const logo = assets.find((a) => a.kind === 'logo');
  $('#ad-asset-count').textContent = assets.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}${logo ? ' + logo' : ''}` : '';
  $('#ad-logo-label').textContent = logo ? 'Replace logo' : 'Add logo';
  $('#ad-stills').disabled = !state.project?.videos?.length || Boolean(state.job);
  $('#ad-stills').title = state.project?.videos?.length ? 'Take sharp stills from the videos on the Home page' : 'Add videos on the Home page first';
  const tile = (a, label) => {
    const warn = a.kind === 'photo' ? photoWarning(a) : '';
    return h('div', { class: `asset${a.kind === 'logo' ? ' logo' : ''}`, style: { backgroundImage: `url("/media/${pid}/ad-assets/${a.thumb}?v=${a.rev || 0}")` }, title: [a.name, a.notes, warn].filter(Boolean).join('\n') },
      h('span', { class: 'num' }, label),
      a.cut?.usable ? h('span', { class: 'badge-cut', title: 'Cut-out ready: can float as a product shot' }, '✂') : null,
      warn ? h('span', { class: 'badge-warn', title: warn }, '!') : null,
      h('div', { class: 'tools' },
        a.kind === 'photo' ? h('button', { type: 'button', title: 'Rotate', 'aria-label': 'Rotate', onclick: () => assetAction(a, 'rotate') }, icon('rotate')) : null,
        h('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove', onclick: () => assetAction(a, 'delete') }, icon('trash'))));
  };
  $('#ad-assets').replaceChildren(...(logo ? [tile(logo, 'Logo')] : []), ...photos.map((a, i) => tile(a, String(i + 1))));
}

async function assetAction(a, action) {
  if (state.job) return toast('Wait for the current job to finish first.', { error: true });
  try {
    const p = await api(`/api/projects/${state.project.id}/ad-assets/${a.id}${action === 'rotate' ? '/rotate' : ''}`, { method: action === 'rotate' ? 'POST' : 'DELETE' });
    state.project = { ...state.project, ...p };
    renderAdAssets();
    updateAdState();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function handleAdImages(files, kind = 'photo') {
  files = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f.name));
  if (!files.length) return toast('Those files are not images.', { error: true });
  if (!versionOk()) return toast('Restart Cutline first: an old copy is still running (see the red message).', { error: true });
  if (state.job) return toast('Wait for the current job to finish first.', { error: true });
  const zone = $('#ad-dropzone');
  try {
    await ensureProject();
    showUploadProgress(zone, `Adding ${files.length} image${files.length > 1 ? 's' : ''}…`, 0);
    const res = await upload(`/api/projects/${state.project.id}/ad-assets${kind === 'logo' ? '?kind=logo' : ''}`, 'images', files, (p) => showUploadProgress(zone, p >= 1 ? 'Analysing…' : `Uploading… ${Math.round(p * 100)}%`, p));
    state.project.adAssets = res.adAssets;
    for (const f of res.failed) toast(`${f.name}: ${f.error}`, { error: true });
    if (res.added.length) toast(kind === 'logo' ? 'Logo added: its colours will style the ads' : `Added ${res.added.length} photo${res.added.length > 1 ? 's' : ''}`);
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    showUploadProgress(zone, null);
    $('#ad-file-input').value = '';
    $('#ad-logo-input').value = '';
    renderAdAssets();
    updateAdState();
  }
}

async function addStills() {
  const btn = $('#ad-stills');
  btn.disabled = true;
  btn.textContent = 'Taking stills…';
  try {
    const p = await api(`/api/projects/${state.project.id}/ad-assets/stills`, { method: 'POST', body: { count: 6 } });
    state.project = { ...state.project, ...p };
    toast('Added stills from your videos');
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    btn.textContent = 'Use stills from my videos';
    renderAdAssets();
    updateAdState();
  }
}

async function generateAds() {
  const s = state.settings;
  s.adInstructions = $('#ad-instructions').value;
  saveSettings();
  try {
    await ensureProject();
    if (!state.client) await patchProject({ profile: state.profile });
    const c = state.client;
    const { jobId } = await api(`/api/projects/${state.project.id}/ads/generate`, {
      method: 'POST',
      body: {
        business: c ? c.business : s.business, businessCustom: c ? c.businessCustom : s.businessCustom, profile: c ? c.profile : state.profile,
        count: s.adCount, seconds: s.adSeconds, format: s.adFormat, direction: s.adDirection, objective: s.adObjective,
        music: s.adMusic, musicLevel: s.musicLevel, mode: aiOn() ? 'ai' : 'auto', instructions: aiOn() ? s.adInstructions : '',
        voiceover: Boolean(s.adVoice) && Boolean(state.status?.providers?.voice?.configured), voice: s.adVoiceName, review: s.adReview !== false,
      },
    });
    pollJob(jobId, 'ads');
  } catch (err) {
    showJobError(err.message);
  }
}

async function askAds(e) {
  e.preventDefault();
  const input = $('#ad-ask-input');
  const request = input.value.trim();
  if (!request || !state.project?.adPlan) return;
  const which = $('#ad-ask-which').value;
  try {
    const { jobId } = await api(`/api/projects/${state.project.id}/ads/revise`, {
      method: 'POST',
      body: { request, adIndex: which === 'all' ? null : Number(which), mode: aiOn() ? 'ai' : 'auto' },
    });
    input.value = '';
    state.project.adChat = [...(state.project.adChat || []), { who: 'you', text: which === 'all' ? request : `Ad ${Number(which) + 1}: ${request}` }];
    pollJob(jobId, 'ads-revise');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderAdResults() {
  const plan = state.project?.adPlan;
  const renders = state.project?.adRenders || [];
  const which = $('#ad-ask-which');
  const prev = which.value;
  which.replaceChildren(h('option', { value: 'all' }, 'All ads'), ...(plan?.ads || []).map((_, i) => h('option', { value: String(i) }, `Ad ${i + 1}`)));
  if ([...which.options].some((o) => o.value === prev)) which.value = prev;

  const chat = state.project?.adChat || [];
  const msgs = chat.slice(-12).map((m) => h('div', { class: `msg ${m.who}${m.error ? ' error' : ''}` }, m.text));
  if (state.job?.kind === 'ads-revise') msgs.push(h('div', { class: 'msg cutline pending' }, aiOn() ? 'The AI is working on it…' : 'Working on it…'));
  const chatBox = $('#ad-chat');
  chatBox.replaceChildren(...msgs);
  chatBox.scrollTop = chatBox.scrollHeight;
  updateAdState();

  const strategy = $('#ad-strategy');
  strategy.replaceChildren();
  if (plan?.source === 'ai' && plan.strategy) strategy.append(h('div', { class: 'strategy' }, h('b', {}, 'Creative strategy'), plan.strategy));
  if (plan?.source === 'auto') strategy.append(h('div', { class: 'strategy muted' }, h('b', {}, 'Free mode'), 'Concepts built from your business details and photos, without AI. Add your Claude key in Settings for ads directed around this business.'));
  if (plan?.musicNote) strategy.append(h('div', { class: 'notice' }, plan.musicNote));

  const box = $('#ads');
  if (!plan) {
    box.replaceChildren(h('div', { class: 'empty' },
      h('b', {}, state.job?.kind === 'ads' ? 'Making your ads…' : 'No ads yet'),
      h('span', {}, state.job?.kind === 'ads' ? 'Cutting out photos, directing and animating. This takes a minute or two.' : 'Add the business details and some product photos, then press Make ads.')));
    return;
  }
  box.replaceChildren(h('div', { class: 'clips-grid' }, plan.ads.map((ad, i) => adCard(ad, renders[i], i, plan.format))));
}

function qaChip(qa) {
  if (!qa) return null;
  const warns = qa.checks.filter((c) => c.level === 'warn' || c.level === 'error');
  return h('span', { class: `badge qa ${qa.errors ? 'bad' : warns.length ? 'warn' : 'good'}`, title: 'Automatic quality check' }, icon('shield'), warns.length ? `${warns.length} to check` : 'Checked');
}

function qaDetails(qa, review) {
  if (!qa) return null;
  const rows = qa.checks.filter((c) => c.level !== 'ok');
  const okCount = qa.checks.filter((c) => c.level === 'ok').length;
  return h('details', { class: 'qa-details' },
    h('summary', {}, `Quality report: ${okCount} checks passed${rows.length ? `, ${rows.length} note${rows.length > 1 ? 's' : ''}` : ''}`),
    review?.fixes?.length ? h('p', { class: 'small' }, h('b', {}, 'AI review fixed: '), review.fixes.join('; ')) : null,
    rows.length ? h('ul', {}, rows.map((c) => h('li', { class: c.level }, h('b', {}, c.text), c.fix ? h('span', { class: 'muted' }, ` ${c.fix}`) : null))) : h('p', { class: 'muted small' }, 'Everything checked out.'),
    h('ul', { class: 'qa-ok' }, qa.checks.filter((c) => c.level === 'ok').map((c) => h('li', {}, c.text))));
}

function adCard(ad, rendered, i, format) {
  const pid = state.project.id;
  const busy = Boolean(state.job);
  const postText = [ad.postCaption, (ad.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  const ratio = { '9:16': '9 / 16', '1:1': '1 / 1', '4:5': '4 / 5', '16:9': '16 / 9' }[format] || '9 / 16';
  const media = h('div', { class: 'clip-video', style: { aspectRatio: ratio } }, rendered
    ? [h('video', { src: `/media/${pid}/ad-output/${rendered.file}`, poster: `/media/${pid}/ad-output/${rendered.thumb}`, controls: true, playsinline: true, preload: 'metadata' }),
      h('span', { class: 'dur' }, fmtDuration(rendered.duration))]
    : h('div', { class: 'clip-pending' }, busy ? 'Animating…' : 'Not rendered yet.'));
  return h('article', { class: 'clip' }, media,
    h('div', { class: 'clip-body' },
      h('div', { class: 'clip-title' }, `${i + 1}. ${ad.title}`),
      h('div', { class: 'badges' },
        h('span', { class: 'badge style' }, directionLabel(ad.direction)),
        ad.angle ? h('span', { class: 'badge' }, ad.angle) : null,
        h('span', { class: 'badge' }, ad.music ? `♪ ${ad.music.name}` : 'No music'),
        qaChip(rendered?.qa)),
      ad.why ? h('div', { class: 'clip-why' }, h('b', {}, 'Why: '), ad.why) : null,
      qaDetails(rendered?.qa, ad.review),
      h('div', { class: 'clip-actions' },
        rendered ? h('a', { class: 'btn btn-sm btn-primary', href: `/media/${pid}/ad-output/${rendered.file}`, download: `${slug(state.project.name)}-ad-${i + 1}.mp4` }, icon('download'), 'MP4') : null,
        rendered ? h('a', { class: 'btn btn-sm', href: `/media/${pid}/ad-output/${rendered.thumb}`, download: `${slug(state.project.name)}-ad-${i + 1}-cover.jpg`, title: 'Cover image for the post' }, icon('image'), 'Cover') : null,
        postText ? h('button', { class: 'btn btn-sm', onclick: () => copyText(postText), title: 'Copy post caption + hashtags' }, icon('copy'), 'Caption') : null,
        h('button', { class: 'btn btn-sm', disabled: busy, onclick: () => openStudio(i) }, icon('film'), 'Studio'))));
}

// ---------------------------------------------------------------------------
// Studio: live preview, timeline and scene inspector
// ---------------------------------------------------------------------------

const CAMERAS = [['', 'Default'], ['push', 'Push in'], ['pull', 'Pull out'], ['pan', 'Pan'], ['rise', 'Rise'], ['orbit', 'Orbit'], ['punch', 'Punch in'], ['still', 'Still']];
const ENTRANCES = [['', 'Default'], ['rise', 'Rise'], ['drop', 'Drop'], ['pop', 'Pop'], ['zoom', 'Zoom'], ['scaleDown', 'Scale down'], ['blur', 'Blur in'], ['tilt', '3D tilt'], ['spin', 'Spin'], ['slideL', 'Slide from left'], ['slideR', 'Slide from right'], ['whip', 'Whip'], ['fade', 'Fade']];
const TEXT_ANIMS = [['', 'Default'], ['words', 'Word by word'], ['pop', 'Pop'], ['blurWords', 'Blur in'], ['slideWords', 'Slide'], ['lines', 'Line by line'], ['chars', 'Typewriter']];
const TRANSITIONS = [['', 'Default'], ['push', 'Push'], ['whip', 'Whip pan'], ['zoom', 'Zoom through'], ['blur', 'Blur'], ['fade', 'Fade'], ['wipe', 'Wipe'], ['iris', 'Iris'], ['brand', 'Brand colour wipe'], ['flash', 'Flash'], ['split', 'Split'], ['cut', 'Cut']];

async function openStudio(i) {
  try {
    const [kit] = await Promise.all([api(`/api/projects/${state.project.id}/ads/${i}/kit`), loadFonts()]);
    const assets = await loadPreviewAssets(kit.urls);
    const draft = structuredClone(kit.board);
    state.studio?.player?.destroy();
    const player = new Player($('#studio-canvas'), { onTime: studioTime });
    state.studio = { i, kit, assets, draft, sel: 0, tab: 'scene', mode: 'live', dirty: false, player };
    player.setMusic(state.tracks.find((t) => t.id === draft.music?.id));
    player.setBoard(draft, kit, assets);
    player.seekScene(0);
    const dlg = $('#studio');
    if (!dlg.open) dlg.showModal();
    renderStudio();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function studioChanged({ timeline = true, keepTime = true } = {}) {
  const st = state.studio;
  st.dirty = true;
  const t = st.player.t;
  st.player.setBoard(st.draft, st.kit, st.assets);
  if (keepTime) st.player.seek(t);
  if (timeline) renderTimeline();
  $('#studio-sub').textContent = `· ${directionLabel(st.draft.direction)} · ${st.player.comp.duration.toFixed(1)}s · unsaved changes`;
}

function studioTime(t, d) {
  $('#studio-time').textContent = `${t.toFixed(1)}s / ${d.toFixed(1)}s`;
  $('#studio-scrub').value = String(Math.round((t / Math.max(0.01, d)) * 1000));
  const st = state.studio;
  if (!st?.player?.comp) return;
  const idx = st.player.comp.scenes.findIndex((s) => t < s.start + s.duration);
  $$('.tl-scene', $('#studio-timeline')).forEach((el, k) => el.classList.toggle('playing', k === idx));
}

function renderStudio() {
  const st = state.studio;
  $('#studio-title').textContent = `Ad ${st.i + 1}: ${st.draft.title}`;
  $('#studio-sub').textContent = `· ${directionLabel(st.draft.direction)} · ${st.player.comp.duration.toFixed(1)}s${st.dirty ? ' · unsaved changes' : ''}`;
  const versions = state.project.adVersions?.[st.i] || [];
  $('#studio-versions').replaceChildren(
    h('option', { value: '' }, versions.length ? `Versions (${versions.length})` : 'No earlier versions'),
    ...versions.map((v, k) => h('option', { value: v.file }, `${k === 0 ? 'Current' : `Version ${versions.length - k}`} · ${timeAgo(v.createdAt)}${v.qa ? ` · QA ${v.qa.score}` : ''}`)),
  );
  seg($('#studio-mode'), [['live', 'Live preview'], ['video', 'Rendered video']], st.mode, (m) => {
    st.mode = m;
    showStudioMode();
  });
  showStudioMode();
  renderTimeline();
  renderInspector();
}

function showStudioMode() {
  const st = state.studio;
  const rendered = state.project.adRenders?.[st.i];
  const video = $('#studio-video');
  const live = st.mode === 'live' || !rendered;
  $('#studio-canvas').hidden = !live;
  video.hidden = live;
  $('.stage-controls #studio-play').hidden = !live;
  $('#studio-scrub').hidden = !live;
  if (!live) {
    st.player.pause();
    const src = `/media/${state.project.id}/ad-output/${rendered.file}`;
    if (!video.src.endsWith(src)) video.src = src;
  } else video.pause();
}

function renderTimeline() {
  const st = state.studio;
  const comp = st.player.comp;
  const box = $('#studio-timeline');
  box.replaceChildren(...st.draft.scenes.map((s, k) => {
    const c = comp.scenes[k];
    return h('button', {
      type: 'button', class: `tl-scene${k === st.sel ? ' sel' : ''}`, style: { flexGrow: String(c?.duration || s.duration), borderTopColor: RECIPE_COLORS[c?.recipe || s.recipe] || '#888' },
      title: `${s.purpose || ''}`,
      onclick: () => {
        st.sel = k;
        st.tab = 'scene';
        st.player.pause();
        st.player.seekScene(k);
        renderTimeline();
        renderInspector();
      },
    }, h('small', {}, `${k + 1} · ${(c?.duration || s.duration).toFixed(1)}s`), h('b', {}, recipeLabel(c?.recipe || s.recipe)), h('span', {}, String(s.headline || '').replace(/\*/g, '') || '—'));
  }));
}

const recipeLabel = (id) => RECIPES[id]?.label || id;

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
}

function select(options, value, onchange) {
  return h('select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === (value ?? '') }, l)));
}

function renderInspector() {
  const st = state.studio;
  const box = $('#studio-inspector');
  const tabs = h('div', { class: 'seg seg-sm insp-tabs' },
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(st.tab === 'scene'), onclick: () => { st.tab = 'scene'; renderInspector(); } }, `Scene ${st.sel + 1}`),
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(st.tab === 'ad'), onclick: () => { st.tab = 'ad'; renderInspector(); } }, 'Whole ad'));
  box.replaceChildren(tabs, st.tab === 'ad' ? adInspector() : sceneInspector());
}

function sceneInspector() {
  const st = state.studio;
  const s = st.draft.scenes[st.sel];
  if (!s) return h('p', { class: 'muted' }, 'No scene selected.');
  const photos = (state.project.adAssets || []).filter((a) => a.kind === 'photo');
  const videos = state.project.videos || [];
  const set = (k, timeline = true) => (v) => {
    s[k] = v === '' ? undefined : v;
    studioChanged({ timeline });
  };
  const isLast = st.sel === st.draft.scenes.length - 1;
  const recipes = Object.entries(RECIPES).filter(([id]) => (isLast ? true : id !== 'cta')).map(([id, r]) => [id, r.label]);
  const multi = ['gallery', 'process', 'compare'].includes(s.recipe);
  const needsItems = ['features', 'process', 'compare', 'cta'].includes(s.recipe);
  const thumb = (a) => `/media/${state.project.id}/ad-assets/${a.thumb}?v=${a.rev || 0}`;
  const comp = st.player.comp.scenes[st.sel];
  return h('div', { class: 'insp' },
    s.purpose ? h('p', { class: 'purpose' }, h('b', {}, 'Purpose: '), s.purpose) : null,
    comp && comp.recipe !== s.recipe ? h('p', { class: 'notice small' }, `Shown as "${recipeLabel(comp.recipe)}" because this design needs ${RECIPES[s.recipe]?.needs}.`) : null,
    field('Design', select(recipes, s.recipe, set('recipe'))),
    field('Headline', h('input', { value: s.headline || '', maxlength: '90', oninput: (e) => set('headline', true)(e.target.value) }), 'Wrap a word in *asterisks* to highlight it.'),
    field('Small line', h('input', { value: s.subline || '', maxlength: '100', oninput: (e) => set('subline', false)(e.target.value) })),
    needsItems ? field(s.recipe === 'cta' ? 'Button text' : s.recipe === 'compare' ? 'Labels (before, after)' : 'Points (one per line)', h('textarea', { rows: s.recipe === 'cta' ? 1 : 3, value: (s.items || []).join('\n'), oninput: (e) => { s.items = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4); studioChanged({ timeline: false }); } })) : null,
    s.recipe === 'footage'
      ? h('div', { class: 'row2' },
        field('Video', select([['', 'None'], ...videos.map((v) => [v.id, v.name])], s.video, set('video'))),
        field('Start at (s)', h('input', { type: 'number', min: '0', step: '0.5', value: String(s.from || 0), onchange: (e) => set('from', false)(Number(e.target.value) || 0) })))
      : h('div', { class: 'field' }, h('span', { class: 'label' }, multi ? 'Photos (first is main)' : 'Photo'),
        h('div', { class: 'photo-pick' },
          h('button', { type: 'button', class: `pp none${!s.main ? ' on' : ''}`, onclick: () => { s.main = null; s.alt = []; studioChanged(); renderInspector(); } }, 'None'),
          photos.map((a) => {
            const isMain = s.main === a.id;
            const isAlt = (s.alt || []).includes(a.id);
            return h('button', {
              type: 'button', class: `pp${isMain ? ' on' : isAlt ? ' alt' : ''}`, style: { backgroundImage: `url("${thumb(a)}")` }, title: a.notes || a.name,
              onclick: () => {
                if (!multi) s.main = a.id;
                else if (!s.main || isMain) s.main = isMain ? (s.alt || [])[0] || null : a.id;
                else s.alt = isAlt ? s.alt.filter((x) => x !== a.id) : [...(s.alt || []), a.id].slice(0, 3);
                if (isMain && multi) s.alt = (s.alt || []).filter((x) => x !== s.main);
                studioChanged();
                renderInspector();
              },
            }, a.cut?.usable ? h('i', {}, '✂') : null);
          }))),
    h('div', { class: 'row2' },
      field('Seconds', h('input', { type: 'number', min: '1.2', max: '8', step: '0.1', value: String(s.duration), onchange: (e) => { s.duration = Math.max(1.2, Math.min(8, Number(e.target.value) || s.duration)); studioChanged(); } })),
      field('Layout', select([['', 'Auto'], ['0', 'Layout 1'], ['1', 'Layout 2'], ['2', 'Layout 3']], s.layout === undefined ? '' : String(s.layout), (v) => set('layout')(v === '' ? '' : Number(v))))),
    h('div', { class: 'row2' },
      field('Camera', select(CAMERAS, s.camera, set('camera', false))),
      field('Subject entrance', select(ENTRANCES, s.entrance, set('entrance', false)))),
    h('div', { class: 'row2' },
      field('Text animation', select(TEXT_ANIMS, s.textAnim, set('textAnim', false))),
      st.sel > 0 ? field('Transition in', select(TRANSITIONS, s.transition, set('transition', false))) : h('span')),
    h('div', { class: 'insp-actions' },
      h('button', { class: 'btn btn-sm', type: 'button', disabled: st.sel === 0 || isLast, onclick: () => moveScene(-1), title: 'Move earlier' }, icon('up')),
      h('button', { class: 'btn btn-sm', type: 'button', disabled: st.sel >= st.draft.scenes.length - 2, onclick: () => moveScene(1), title: 'Move later' }, icon('down')),
      h('button', { class: 'btn btn-sm', type: 'button', disabled: isLast, onclick: duplicateScene, title: 'Duplicate scene' }, icon('dup')),
      h('button', { class: 'btn btn-sm', type: 'button', disabled: isLast || st.draft.scenes.length <= 2, onclick: deleteScene, title: 'Delete scene' }, icon('trash')),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { s.seed = Math.floor(Math.random() * 1e6); studioChanged(); }, title: 'Shuffle the details of this design' }, icon('refresh'), 'Shuffle'),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: regenerateStudioScene, title: aiOn() ? 'The AI makes a new version of this scene' : 'Try a different design and photo' }, icon('sparkle'), 'New take')));
}

function adInspector() {
  const st = state.studio;
  const d = st.draft;
  const dirs = (state.status?.ads?.directions || []).map((x) => [x.id, `${x.label} (${x.font})`]);
  return h('div', { class: 'insp' },
    field('Title', h('input', { value: d.title || '', maxlength: '60', oninput: (e) => { d.title = e.target.value; st.dirty = true; } })),
    field('Look', select(dirs, d.direction, (v) => { d.direction = v; studioChanged(); renderInspector(); })),
    field('Background', select([['', 'Look default'], ['dark', 'Dark'], ['light', 'Light'], ['bright', 'Bright brand colour']], d.tone, (v) => { d.tone = v || undefined; studioChanged(); })),
    h('div', { class: 'accent-row' },
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: Boolean(d.accent), onchange: (e) => { d.accent = e.target.checked ? (d.accent || st.kit.palette.accent) : undefined; studioChanged({ timeline: false }); renderInspector(); } }), h('span'), 'Custom accent colour'),
      h('input', { type: 'color', value: d.accent || st.kit.palette.accent, oninput: (e) => { d.accent = e.target.value; studioChanged({ timeline: false }); }, 'aria-label': 'Accent colour' })),
    field('Music', select([['none', 'No music'], ...state.tracks.map((t) => [t.id, t.name])], d.music?.id || 'none', (v) => {
      const t = state.tracks.find((x) => x.id === v);
      d.music = t ? { id: t.id, name: t.name, bpm: t.bpm } : null;
      st.player.setMusic(t);
      studioChanged();
    })),
    field('Voiceover script', h('textarea', { rows: 3, value: d.voiceover || '', maxlength: '600', placeholder: 'Leave empty for no voiceover', oninput: (e) => { d.voiceover = e.target.value; st.dirty = true; } }), state.status?.providers?.voice?.configured ? 'Read out when the Voiceover option is on (about 1–2 cents).' : 'Needs an OpenAI key in Settings.'),
    field('Post caption', h('textarea', { rows: 3, value: d.postCaption || '', maxlength: '2200', oninput: (e) => { d.postCaption = e.target.value; st.dirty = true; } })),
    h('div', { class: 'insp-actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { d.seed = Math.floor(Math.random() * 1e6); d.scenes.forEach((s) => (s.seed = undefined)); studioChanged(); }, title: 'New random details for every scene (same plan)' }, icon('refresh'), 'Shuffle all designs')),
    d.why ? h('p', { class: 'muted small' }, h('b', {}, 'Why it works: '), d.why) : null);
}

function moveScene(dir) {
  const st = state.studio;
  const k = st.sel;
  const j = k + dir;
  const sc = st.draft.scenes;
  if (j < 0 || j >= sc.length - 1) return;
  [sc[k], sc[j]] = [sc[j], sc[k]];
  st.sel = j;
  studioChanged();
  renderInspector();
}

function duplicateScene() {
  const st = state.studio;
  const copy = structuredClone(st.draft.scenes[st.sel]);
  copy.seed = Math.floor(Math.random() * 1e6);
  st.draft.scenes.splice(st.sel + 1, 0, copy);
  st.sel += 1;
  studioChanged();
  renderInspector();
}

function deleteScene() {
  const st = state.studio;
  st.draft.scenes.splice(st.sel, 1);
  st.sel = Math.min(st.sel, st.draft.scenes.length - 1);
  studioChanged();
  renderInspector();
}

async function saveStudio() {
  const st = state.studio;
  try {
    const board = { ...st.draft, music: st.draft.music?.id || 'none', keepDurations: true };
    const { jobId } = await api(`/api/projects/${state.project.id}/ads/${st.i}/render`, { method: 'POST', body: { board } });
    closeStudio(true);
    pollJob(jobId, 'ad-render');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function regenerateStudioScene() {
  const st = state.studio;
  if (st.dirty && !confirm('Save your other changes first? Unsaved changes in this ad will be lost when the new take is made.')) return;
  try {
    const { jobId } = await api(`/api/projects/${state.project.id}/ads/${st.i}/scenes/${st.sel}/regenerate`, { method: 'POST', body: { mode: aiOn() ? 'ai' : 'auto' } });
    const i = st.i;
    closeStudio(true);
    state.reopenStudio = { jobId, i };
    pollJob(jobId, 'ad-scene');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function restoreStudioVersion(file) {
  const st = state.studio;
  if (!file) return;
  if (!confirm('Restore this version? It becomes the current ad (later versions are kept).')) return renderStudio();
  try {
    const p = await api(`/api/projects/${state.project.id}/ads/${st.i}/restore`, { method: 'POST', body: { file } });
    state.project = { ...state.project, ...p };
    renderAdResults();
    openStudio(st.i);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function closeStudio(force = false) {
  const st = state.studio;
  if (st?.dirty && !force && !confirm('Close without saving your changes?')) return;
  st?.player?.destroy();
  $('#studio-video').pause();
  state.studio = null;
  if ($('#studio').open) $('#studio').close();
}

// ---------------------------------------------------------------------------
// Clients and brand kits
// ---------------------------------------------------------------------------

async function loadClients() {
  try {
    state.clients = await api('/api/clients');
  } catch {
    state.clients = [];
  }
}

async function loadCurrentClient() {
  const id = state.project?.clientId;
  state.client = id ? await api(`/api/clients/${id}`).catch(() => null) : null;
}

function chooseClient() {
  const dlg = h('dialog', { class: 'dialog' },
    h('div', { class: 'dialog-head' }, h('h3', {}, 'Choose a client'), h('button', { class: 'icon-btn', type: 'button', onclick: () => dlg.close(), 'aria-label': 'Close' }, icon('x'))),
    h('div', { class: 'dialog-body' },
      h('p', { class: 'muted small' }, 'Starts a new project for the client with their logo, colours, details and photos.'),
      h('ul', { class: 'project-list' }, (state.clients || []).map((c) => h('li', { class: 'project-item' },
        h('div', { class: 'pthumb', style: c.logo ? { backgroundImage: `url("${c.logo}")`, backgroundSize: 'contain' } : {} }),
        h('div', { class: 'pmeta', role: 'button', tabindex: '0', onclick: async () => { dlg.close(); await startClientProject(c.id); } }, h('b', {}, c.name), h('small', {}, `${c.photos} photo${c.photos === 1 ? '' : 's'}`))))),
      !(state.clients || []).length ? h('p', { class: 'muted' }, 'No clients yet.') : null,
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => { dlg.close(); await createClientFromDetails(); } }, icon('plus'), 'New client from these details')));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

async function startClientProject(id) {
  if (state.job) return toast('Wait for the current job to finish first.', { error: true });
  try {
    const p = await api(`/api/clients/${id}/projects`, { method: 'POST', body: {} });
    await openProject(p.id);
    toast('New project ready with the client\'s brand kit');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function createClientFromDetails() {
  const name = state.profile.name || prompt('Client name?');
  if (!name) return;
  try {
    const c = await api('/api/clients', { method: 'POST', body: { name, business: state.settings.business, businessCustom: state.settings.businessCustom, profile: { ...state.profile, name } } });
    await loadClients();
    state.clientSel = c.id;
    location.hash = '#/clients';
    toast('Client created: add their logo and photos here');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function renderClients() {
  await loadClients();
  const list = $('#client-list');
  $('#clients-count').textContent = state.clients.length ? `${state.clients.length}` : '';
  if (!state.clientSel && state.clients[0]) state.clientSel = state.clients[0].id;
  list.replaceChildren(...state.clients.map((c) => h('li', { class: `client-li${c.id === state.clientSel ? ' sel' : ''}`, onclick: () => { state.clientSel = c.id; renderClients(); } },
    c.logo ? h('div', { class: 'client-logo', style: { backgroundImage: `url("${c.logo}")` } }) : h('div', { class: 'client-logo empty' }, c.name[0]),
    h('div', { class: 'client-meta' }, h('b', {}, c.name), h('span', { class: 'muted small' }, `${c.photos} photo${c.photos === 1 ? '' : 's'} · ${timeAgo(c.updatedAt)}`)),
    h('div', { class: 'swatches' }, (c.colors || []).map((col) => h('i', { style: { background: col } })))),
  ));
  if (!state.clients.length) list.replaceChildren(h('li', { class: 'muted small client-li' }, 'No clients yet. Create one to save a business\'s logo, colours and details.'));
  const detail = $('#client-detail');
  if (!state.clientSel) {
    detail.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'Brand kits'), h('span', {}, 'Each client keeps their logo, brand colours, preferred look, business details and photo library, so repeat work is fast and consistent.')));
    return;
  }
  const c = await api(`/api/clients/${state.clientSel}`).catch(() => null);
  if (!c) return;
  renderClientDetail(c);
}

function renderClientDetail(c) {
  const detail = $('#client-detail');
  let timer;
  const save = (fields) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await api(`/api/clients/${c.id}`, { method: 'PATCH', body: fields });
        if (state.client?.id === c.id) await loadCurrentClient();
      } catch (err) {
        toast(err.message, { error: true });
      }
    }, 450);
  };
  const profile = { ...c.profile };
  const brand = { ...c.brand, colors: [...(c.brand.colors || [])] };
  const pf = (key, placeholder, max = 120) => h('input', { value: profile[key] || '', placeholder, maxlength: String(max), oninput: (e) => { profile[key] = e.target.value; save({ profile }); } });
  const dirs = [['auto', 'Choose per ad'], ...(state.status?.ads?.directions || []).map((x) => [x.id, x.label])];
  const upl = (kind) => h('input', { type: 'file', accept: 'image/*,.heic,.heif', multiple: kind !== 'logo', hidden: true, onchange: async (e) => {
    try {
      const res = await upload(`/api/clients/${c.id}/media${kind === 'logo' ? '?kind=logo' : ''}`, 'images', [...e.target.files], () => {});
      for (const f of res.failed) toast(`${f.name}: ${f.error}`, { error: true });
      renderClients();
    } catch (err) {
      toast(err.message, { error: true });
    }
  } });
  detail.replaceChildren(
    h('div', { class: 'cd-head' },
      h('label', { class: 'client-logo big', style: c.logo ? { backgroundImage: `url("/client-files/${c.id}/${c.logo.thumb}")` } : {}, title: 'Upload logo' }, c.logo ? null : 'Logo', upl('logo')),
      h('div', { class: 'cd-title' },
        h('input', { class: 'cd-name', value: c.name, maxlength: '80', onchange: (e) => save({ name: e.target.value }) }),
        h('select', { onchange: (e) => save({ business: e.target.value }) }, (state.status?.businesses || []).map((b) => h('option', { value: b.id, selected: b.id === c.business }, b.label)))),
      h('div', { class: 'cd-actions' },
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => startClientProject(c.id) }, icon('plus'), 'New project'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => { if (!confirm(`Delete ${c.name} and their brand kit? Projects are kept.`)) return; await api(`/api/clients/${c.id}`, { method: 'DELETE' }); state.clientSel = null; renderClients(); } }, icon('trash')))),
    h('div', { class: 'cd-grid' },
      h('div', { class: 'cd-col' },
        h('h3', {}, 'Business details'),
        h('div', { class: 'profile-fields' },
          pf('name', 'Business name', 80), pf('services', 'What they sell (comma separated)', 300), pf('location', 'Suburb / city', 80),
          pf('offer', 'Current offer (optional)'), pf('audience', 'Their customers (optional)'), pf('contact', 'Phone, website or @handle', 80), pf('review', 'A real customer review (optional)', 200)),
        h('h3', {}, 'Brand'),
        h('div', { class: 'brand-colors' },
          brand.colors.map((col, k) => h('span', { class: 'bc' },
            h('input', { type: 'color', value: col, onchange: (e) => { brand.colors[k] = e.target.value; save({ brand }); } }),
            h('button', { type: 'button', class: 'link-btn', 'aria-label': 'Remove colour', onclick: () => { brand.colors.splice(k, 1); save({ brand }); setTimeout(renderClients, 500); } }, '×'))),
          brand.colors.length < 4 ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { brand.colors.push('#888888'); save({ brand }); setTimeout(renderClients, 500); } }, icon('plus'), 'Colour') : null),
        h('small', { class: 'muted' }, c.logo ? 'Colours start from the logo; adjust them to the exact brand colours.' : 'Upload the logo and its colours are picked up automatically.'),
        h('div', { class: 'row2' },
          field('Preferred look', select(dirs, brand.direction, (v) => { brand.direction = v; save({ brand }); })),
          field('Background', select([['auto', 'Look default'], ['dark', 'Dark'], ['light', 'Light']], brand.tone, (v) => { brand.tone = v; save({ brand }); })))),
      h('div', { class: 'cd-col' },
        h('div', { class: 'label-row' }, h('h3', {}, `Photo library (${c.media.length})`), h('label', { class: 'btn btn-sm' }, icon('plus'), 'Add photos', upl('photo'))),
        h('div', { class: 'asset-grid lib' }, c.media.map((m) => h('div', { class: 'asset', style: { backgroundImage: `url("/client-files/${c.id}/${m.thumb}")` }, title: m.name },
          photoWarning(m) ? h('span', { class: 'badge-warn', title: photoWarning(m) }, '!') : null,
          h('div', { class: 'tools' }, h('button', { type: 'button', title: 'Remove', onclick: async () => { await api(`/api/clients/${c.id}/media/${m.id}`, { method: 'DELETE' }); renderClients(); } }, icon('trash')))))),
        !c.media.length ? h('p', { class: 'muted small' }, 'Add the business\'s best product and work photos. Every new project starts with them.') : null,
        h('h3', {}, `Projects (${c.projects.length})`),
        h('ul', { class: 'cd-projects' }, c.projects.map((p) => h('li', {},
          h('button', { type: 'button', class: 'link-btn', onclick: async () => { await openProject(p.id); location.hash = '#/ads'; } }, p.name),
          h('span', { class: 'muted small' }, ` · ${p.adCount} ad${p.adCount === 1 ? '' : 's'}, ${p.clipCount} clip${p.clipCount === 1 ? '' : 's'} · ${timeAgo(p.updatedAt)}`),
          h('button', { type: 'button', class: 'icon-btn', title: 'Duplicate', onclick: async () => { await api(`/api/projects/${p.id}/duplicate`, { method: 'POST' }); renderClients(); } }, icon('dup'))))),
        !c.projects.length ? h('p', { class: 'muted small' }, 'No projects yet.') : null)),
  );
}

// ---------------------------------------------------------------------------
// Music page
// ---------------------------------------------------------------------------

const preview = new Audio();
let previewId = null;
preview.addEventListener('ended', () => {
  previewId = null;
  renderMusicPage();
});

async function loadTracks() {
  try {
    state.tracks = await api('/api/music');
  } catch {
    state.tracks = [];
  }
  renderTopbar();
}

function renderMusicPage() {
  $('#music-count').textContent = state.tracks.length ? `${state.tracks.length} song${state.tracks.length > 1 ? 's' : ''}` : '';
  seg($('#music-level-seg'), [['soft', 'Soft'], ['normal', 'Normal'], ['loud', 'Loud']], state.settings.musicLevel, setSetting('musicLevel'));
  const moods = state.status?.moods || ['energetic', 'chill', 'build'];
  const list = $('#track-list');
  if (!state.tracks.length) {
    list.replaceChildren(h('li', { class: 'track-empty' }, 'No songs yet. Add some MP3s and every clip gets music, cut to the beat.'));
    return;
  }
  list.replaceChildren(...state.tracks.map((t) => h('li', { class: 'track' },
    h('button', { class: `icon-btn${previewId === t.id ? ' on' : ''}`, title: previewId === t.id ? 'Stop' : 'Play', onclick: () => togglePreview(t) }, icon(previewId === t.id ? 'stop' : 'play')),
    h('b', { title: t.name }, t.name),
    h('span', { class: 'num' }, String(Math.round(t.bpm))),
    h('span', { class: 'num' }, fmtDuration(t.duration)),
    h('select', { title: 'Which clips use this song', onchange: async (e) => {
      try {
        Object.assign(t, await api(`/api/music/${t.id}`, { method: 'PATCH', body: { mood: e.target.value } }));
        toast(`"${t.name}" is now ${t.mood}`);
      } catch (err) {
        toast(err.message, { error: true });
        renderMusicPage();
      }
    } }, moods.map((m) => h('option', { value: m, selected: m === t.mood }, m === 'build' ? 'Build-up' : m[0].toUpperCase() + m.slice(1)))),
    h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${t.name}`, onclick: async () => {
      if (!confirm(`Remove "${t.name}"?`)) return;
      try {
        if (previewId === t.id) preview.pause();
        state.tracks = (await api(`/api/music/${t.id}`, { method: 'DELETE' })).tracks;
        renderMusicPage();
        renderTopbar();
        renderMusicSelect();
      } catch (err) {
        toast(err.message, { error: true });
      }
    } }, icon('trash')))));
}

function togglePreview(t) {
  if (previewId === t.id) {
    preview.pause();
    previewId = null;
  } else {
    preview.src = `/music-files/${t.file}`;
    preview.play().catch(() => toast("Couldn't play that file.", { error: true }));
    previewId = t.id;
  }
  renderMusicPage();
}

async function handleMusicFiles(files) {
  files = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name));
  if (!files.length) return toast('Those files are not audio files.', { error: true });
  if (!versionOk()) return toast('Restart Cutline first: an old copy is still running (see the red message).', { error: true });
  const zone = $('#music-drop');
  $('#music-add-label').textContent = 'Adding…';
  showUploadProgress(zone, `Adding ${files.length} song${files.length > 1 ? 's' : ''}…`, 0);
  try {
    const res = await upload('/api/music', 'tracks', files, (p) => showUploadProgress(zone, p >= 1 ? 'Finding the beat…' : `Uploading… ${Math.round(p * 100)}%`, p));
    state.tracks = res.tracks;
    for (const t of res.added) toast(`Added "${t.name}" (${Math.round(t.bpm)} BPM)`);
    for (const f of res.failed) toast(`${f.name}: ${f.error}`, { error: true });
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    showUploadProgress(zone, null);
    $('#music-add-label').textContent = 'Add music';
    $('#music-input').value = '';
    renderMusicPage();
    renderTopbar();
    renderMusicSelect();
  }
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

async function loadServerSettings() {
  try {
    state.server = await api('/api/settings');
  } catch {
    state.server = null;
  }
}

function renderSettings() {
  const s = state.settings;
  const srv = state.server;
  const tag = $('#ai-tag');
  tag.className = `tag ${aiOn() ? 'on' : 'off'}`;
  tag.textContent = aiOn() ? 'On' : aiKey() ? 'Off (free mode selected)' : 'Off: no key';
  const editable = srv?.editable !== false;
  for (const id of ['key-input', 'key-save', 'key-remove', 'openai-input', 'openai-save', 'openai-remove', 'model-select']) $(`#${id}`).disabled = !editable || !versionOk();
  const ks = $('#key-status');
  ks.className = 'muted small';
  ks.textContent = !versionOk() ? 'Restart Cutline first (see the red message at the top).'
    : !editable ? 'Keys can only be changed on the computer running Cutline.'
      : srv?.anthropicKey ? `Saved key: ${srv.anthropicKey}` : 'No key saved.';
  $('#key-check').disabled = !aiKey();
  $('#key-remove').disabled = !editable || !versionOk() || !srv?.anthropicKey;
  $('#openai-remove').disabled = !editable || !versionOk() || !srv?.openaiKey;

  const models = state.status?.ai?.models || {};
  $('#model-select').replaceChildren(...Object.entries(models).map(([id, label]) => h('option', { value: id, selected: id === state.status.ai.model }, label)));
  seg($('#engine-seg'), [['ai', 'Claude AI'], ['auto', 'Free auto-edit (no AI)']], s.mode, setSetting('mode', () => {
    renderSettings();
    renderTopbar();
    renderControls();
  }));
  seg($('#reframe-seg'), [['auto', 'Auto'], ['fill', 'Crop to fill'], ['fit', 'Fit + blur']], s.reframe, setSetting('reframe'));
  seg($('#audio-seg'), [['original', 'Keep'], ['mute', 'Mute']], s.audio, setSetting('audio'));
  $('#opt-text').checked = s.onScreenText;
  const speechOk = Boolean(state.status?.transcription?.configured);
  $('#opt-speech').disabled = !speechOk;
  $('#opt-speech').checked = speechOk && s.speechSubtitles;
  $('#openai-status').textContent = srv?.openaiKey ? `Saved key: ${srv.openaiKey}` : 'No key saved.';
  const prov = state.status?.providers || {};
  $('#services').replaceChildren(...Object.values(prov).map((p) => h('li', {},
    h('span', { class: `dot ${p.configured ? 'on' : p.approved ? 'off' : 'na'}` }),
    h('b', {}, p.name),
    h('span', { class: 'muted small' }, ` · ${p.configured ? 'on' : p.approved ? 'not set up' : 'not enabled'} · ${p.cost}`))));
  $('#about').textContent = `Cutline ${APP_VERSION}${state.status ? ` · server ${state.status.version || 'old'} · FFmpeg ${state.status.ffmpeg.version || 'missing'}` : ''}${srv?.logFile ? ` · Log file: ${srv.logFile}` : ''}`;
}

async function saveKey(field, value, label) {
  try {
    state.server = { ...(await api('/api/settings', { method: 'POST', body: { [field]: value } })), editable: true };
    await refreshStatus();
    renderSettings();
    renderControls();
    toast(value ? `${label} saved` : `${label} removed`);
    return true;
  } catch (err) {
    toast(err.message, { error: true });
    const status = $(field === 'openaiKey' ? '#openai-status' : '#key-status');
    status.className = 'small bad';
    status.textContent = err.message;
    return false;
  }
}

async function checkKey() {
  const ks = $('#key-status');
  ks.textContent = 'Checking…';
  try {
    const r = await api('/api/settings/check', { method: 'POST' });
    ks.className = `small ${r.ok ? 'good' : 'bad'}`;
    ks.textContent = r.message;
  } catch (err) {
    ks.className = 'small bad';
    ks.textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  window.addEventListener('hashchange', route);

  $('#biz-type').addEventListener('change', (e) => {
    state.settings.business = e.target.value;
    saveSettings();
    $('#biz-custom').hidden = e.target.value !== 'other';
    patchProject({ business: e.target.value });
  });
  $('#biz-custom').addEventListener('change', (e) => {
    state.settings.businessCustom = e.target.value.trim();
    saveSettings();
    patchProject({ businessCustom: state.settings.businessCustom });
  });
  let profileTimer;
  for (const input of $$('[data-profile]')) {
    input.addEventListener('input', () => {
      state.profile[input.dataset.profile] = input.value;
      store.set('profile', state.profile);
      renderProfileSummary();
      updateAdState();
      clearTimeout(profileTimer);
      profileTimer = setTimeout(() => patchProject({ profile: state.profile }), 600);
    });
  }
  $('#style-select').addEventListener('change', (e) => setSetting('style')(e.target.value));
  $('#music-select').addEventListener('change', (e) => setSetting('music')(e.target.value));
  $('#instructions').addEventListener('change', (e) => setSetting('instructions')(e.target.value));

  const dz = $('#dropzone');
  $('#file-input').addEventListener('change', (e) => handleVideoFiles(e.target.files));
  for (const [zone, handler] of [[dz, handleVideoFiles], [$('#music-drop'), handleMusicFiles], [$('#ad-dropzone'), handleAdImages]]) {
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', (e) => handler(e.dataTransfer.files));
  }
  $('#music-drop').addEventListener('click', (e) => {
    e.preventDefault();
    $('#music-input').click();
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('#music-input').addEventListener('change', (e) => handleMusicFiles(e.target.files));

  $$('.job-retry').forEach((b) => b.addEventListener('click', retryJob));
  $('#btn-generate').addEventListener('click', generate);
  $('#ask-form').addEventListener('submit', ask);

  // Ads page
  $('#ad-biz-type').addEventListener('change', (e) => {
    state.settings.business = e.target.value;
    saveSettings();
    patchProject({ business: e.target.value });
  });
  $('#ad-file-input').addEventListener('change', (e) => handleAdImages(e.target.files));
  $('#ad-logo-input').addEventListener('change', (e) => handleAdImages(e.target.files, 'logo'));
  $('#ad-stills').addEventListener('click', addStills);
  $('#ad-objective').addEventListener('change', (e) => setSetting('adObjective')(e.target.value));
  $('#ad-direction').addEventListener('change', (e) => setSetting('adDirection')(e.target.value));
  $('#ad-music-select').addEventListener('change', (e) => setSetting('adMusic')(e.target.value));
  $('#ad-voice-on').addEventListener('change', (e) => { setSetting('adVoice')(e.target.checked); renderAdControls(); });
  $('#ad-voice').addEventListener('change', (e) => setSetting('adVoiceName')(e.target.value));
  $('#ad-review-on').addEventListener('change', (e) => setSetting('adReview')(e.target.checked));
  $('#ad-instructions').addEventListener('change', (e) => setSetting('adInstructions')(e.target.value));
  $('#ad-generate').addEventListener('click', generateAds);
  $('#ad-ask-form').addEventListener('submit', askAds);

  // Studio
  $('#studio-play').addEventListener('click', () => {
    const p = state.studio?.player;
    if (!p) return;
    p.playing ? p.pause() : p.play();
    $('#studio-play').replaceChildren(icon(p.playing ? 'pause' : 'play'));
  });
  $('#studio-scrub').addEventListener('input', (e) => {
    const p = state.studio?.player;
    if (!p?.comp) return;
    p.pause();
    $('#studio-play').replaceChildren(icon('play'));
    p.seek((Number(e.target.value) / 1000) * p.comp.duration);
  });
  $('#studio-close').addEventListener('click', () => closeStudio());
  $('#studio').addEventListener('cancel', (e) => { e.preventDefault(); closeStudio(); });
  $('#studio-save').addEventListener('click', saveStudio);
  $('#studio-versions').addEventListener('change', (e) => restoreStudioVersion(e.target.value));
  $('#client-new').addEventListener('click', async () => {
    const name = prompt('Client (business) name?');
    if (!name) return;
    const c = await api('/api/clients', { method: 'POST', body: { name, business: state.settings.business, profile: { name } } });
    state.clientSel = c.id;
    renderClients();
  });

  const nameInput = $('#project-name');
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && nameInput.blur());
  nameInput.addEventListener('change', async () => {
    if (!nameInput.value.trim()) nameInput.value = state.project?.name || 'New project';
    if (state.project) await patchProject({ name: nameInput.value.trim() });
  });
  $('#btn-projects').addEventListener('click', showProjects);
  $('#btn-new-project').addEventListener('click', newProject);
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => e.target === d && d.close()));
  $('#video-dialog').addEventListener('close', () => {
    const p = $('#video-dialog-player');
    p.pause();
    p.removeAttribute('src');
    p.load();
  });

  // Settings
  $('#key-save').addEventListener('click', async () => {
    const v = $('#key-input').value.trim();
    if (!v) return toast('Paste your key first.', { error: true });
    if (await saveKey('anthropicKey', v, 'Claude key')) {
      $('#key-input').value = '';
      state.settings.mode = 'ai';
      saveSettings();
      renderSettings();
      renderTopbar();
      renderControls();
      checkKey();
    }
  });
  $('#key-check').addEventListener('click', checkKey);
  $('#key-remove').addEventListener('click', () => confirm('Remove the Claude key from this computer?') && saveKey('anthropicKey', '', 'Claude key'));
  $('#model-select').addEventListener('change', (e) => saveKey('model', e.target.value, 'Model'));
  $('#openai-save').addEventListener('click', async () => {
    const v = $('#openai-input').value.trim();
    if (!v) return toast('Paste your key first.', { error: true });
    if (await saveKey('openaiKey', v, 'OpenAI key')) $('#openai-input').value = '';
  });
  $('#openai-remove').addEventListener('click', () => saveKey('openaiKey', '', 'OpenAI key'));
  $('#opt-text').addEventListener('change', (e) => setSetting('onScreenText')(e.target.checked));

  $('#opt-speech').addEventListener('change', (e) => setSetting('speechSubtitles')(e.target.checked));
}

async function init() {
  wire();
  await refreshStatus();
  ops.init({ openProjectInEditor: async (id, where = 'production') => { await openProject(id); location.hash = `#/${where}`; }, refreshStatus });
  await Promise.all([loadTracks(), loadServerSettings(), loadClients()]);
  const saved = store.get('project', null);
  if (saved && state.status) {
    try {
      await openProject(saved);
    } catch {
      store.remove('project');
    }
  }
  route();
  // Notice if Cutline is restarted or stopped while the page is open.
  setInterval(async () => {
    const before = JSON.stringify([state.status?.version, state.status?.ai?.configured, Boolean(state.status)]);
    await refreshStatus();
    if (JSON.stringify([state.status?.version, state.status?.ai?.configured, Boolean(state.status)]) !== before) route();
    ops.refreshCounts();
  }, 15000);
}

init();
