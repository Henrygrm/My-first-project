import { $, $$, api, copyText, fmtDuration, fmtSec, h, icon, slug, store, timeAgo, toast, upload } from './ui.js';

// Must match package.json. If the server reports a different version, an
// old copy of Cutline is still running and new features won't work.
const APP_VERSION = '2.1.0';

const ROLE_COLORS = { hook: '#ffb03d', setup: '#6aa8ff', process: '#6aa8ff', reveal: '#3ddc97', payoff: '#3ddc97', cta: '#c79bff' };
const DEFAULTS = {
  business: 'restaurant', businessCustom: '', platform: 'tiktok', clipCount: 2, targetSeconds: 30,
  style: 'mix', music: 'auto', musicLevel: 'normal', mode: 'ai', reframe: 'auto', audio: 'original',
  onScreenText: true, speechSubtitles: false, instructions: '',
  adFormat: '9:16', adSeconds: 15, adCount: 2, adTheme: 'auto', adMusic: 'auto', adAccent: '#ffb03d', adAccentOn: false, adInstructions: '',
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
  adDrafts: {},
  openAdEditors: new Set(),
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
  $('#nav-music-count').textContent = state.tracks.length ? String(state.tracks.length) : '';
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

function route() {
  const name = location.hash.replace(/^#\/?/, '') || 'home';
  const page = ['home', 'ads', 'music', 'settings'].includes(name) ? name : 'home';
  $$('.page').forEach((p) => (p.hidden = p.id !== `page-${page}`));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  if (page === 'music') renderMusicPage();
  if (page === 'settings') renderSettings();
  if (page === 'home') renderHome();
  if (page === 'ads') renderAds();
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
  state.adDrafts = {};
  state.openAdEditors.clear();
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
  if (as) {
    Object.assign(state.settings, { adFormat: as.format, adSeconds: as.seconds, adCount: as.count, adTheme: as.theme, adMusic: as.music });
    if (as.accent) Object.assign(state.settings, { adAccent: as.accent, adAccentOn: true });
  }
  if (p.profile && Object.values(p.profile).some(Boolean)) state.profile = { ...p.profile };
  saveSettings();
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

const themeLabel = (id) => (id === 'auto' ? 'AI picks' : state.status?.ads?.themes.find((t) => t.id === id)?.label || id);
const SCENE_LABELS = { hook: 'Hook', photo: 'Photo', features: 'List', offer: 'Offer', stat: 'Number', review: 'Review', cta: 'Call to action' };
const SCENE_COLORS = { hook: '#ffb03d', photo: '#6aa8ff', features: '#3ddc97', offer: '#ff7a9a', stat: '#c79bff', review: '#ffd84d', cta: '#c79bff' };

function renderAds() {
  renderAdControls();
  renderAdAssets();
  renderAdResults();
}

function renderAdControls() {
  const s = state.settings;
  const st = state.status;
  $('#ad-biz-type').replaceChildren(...(st?.businesses || []).map((b) => h('option', { value: b.id, selected: b.id === s.business }, b.id === 'other' && s.businessCustom ? s.businessCustom : b.label)));
  for (const input of $$('[data-profile]')) input.value = state.profile[input.dataset.profile] || '';
  renderProfileSummary();
  const ads = st?.ads || { formats: [], lengths: [], themes: [] };
  seg($('#ad-format-seg'), ads.formats.map((f) => [f.id, f.id]), s.adFormat, setSetting('adFormat'));
  seg($('#ad-length-seg'), ads.lengths.map((l) => [l, `${l}s`]), s.adSeconds, setSetting('adSeconds'));
  seg($('#ad-count-seg'), [[1, '1'], [2, '2'], [3, '3']], s.adCount, setSetting('adCount'));
  $('#ad-theme-select').replaceChildren(
    h('option', { value: 'auto', selected: s.adTheme === 'auto' }, aiOn() ? 'AI picks the best look' : 'Mix of looks'),
    ...ads.themes.map((t) => h('option', { value: t.id, selected: t.id === s.adTheme }, `${t.label}: ${t.brief.split(',')[0]}`)),
  );
  if (s.adMusic !== 'auto' && s.adMusic !== 'none' && !state.tracks.some((t) => t.id === s.adMusic)) s.adMusic = 'auto';
  $('#ad-music-select').replaceChildren(
    h('option', { value: 'auto', selected: s.adMusic === 'auto' }, state.tracks.length ? 'Auto (best song per ad)' : 'Auto (add songs first)'),
    h('option', { value: 'none', selected: s.adMusic === 'none' }, 'No music'),
    ...state.tracks.map((t) => h('option', { value: t.id, selected: s.adMusic === t.id }, t.name)),
  );
  $('#ad-accent').value = s.adAccent;
  $('#ad-accent-on').checked = s.adAccentOn;
  $('#ad-notes-block').hidden = !aiOn();
  $('#ad-instructions').value = s.adInstructions || '';
  updateAdState();
}

function updateAdState() {
  const p = state.profile;
  let reason = '';
  if (!state.status) reason = "Cutline isn't running.";
  else if (!versionOk()) reason = 'Restart Cutline first (see the red message at the top).';
  else if (!ffmpegOk()) reason = 'Install FFmpeg first.';
  else if (!p.name && !p.services) reason = 'Fill in the business name and what they sell.';
  else if (state.job) reason = 'Working…';
  $('#ad-generate').disabled = Boolean(reason);
  $('#ad-generate-label').textContent = aiOn() ? 'Make ads with AI' : 'Make ads (free mode)';
  const photos = (state.project?.adAssets || []).filter((a) => a.kind === 'photo').length;
  $('#ad-hint').textContent = reason || (!photos ? 'Tip: add a few photos (or use stills from your videos) for better ads.' : aiOn() ? '' : 'Free mode: ads built from templates. Add a Claude key in Settings for AI-written ads.');
  const can = Boolean(state.project?.adPlan) && !state.job && versionOk();
  for (const id of ['ad-ask-input', 'ad-ask-send', 'ad-ask-which']) $(`#${id}`).disabled = !can;
  $('#ad-ask-input').placeholder = !state.project?.adPlan
    ? 'Make ads first, then tell the AI what to change here'
    : aiOn() ? 'Tell the AI what to change, e.g. "ad 1: open with the offer, use the neon look"' : 'e.g. "make it 20 seconds", "make it luxury", "hook: Your text", "redo ad 2"';
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
  const tile = (a, label) => h('div', { class: `asset${a.kind === 'logo' ? ' logo' : ''}`, style: { backgroundImage: `url("/media/${pid}/ad-assets/${a.thumb}?v=${a.rev || 0}")` }, title: a.name },
    h('span', { class: 'num' }, label),
    h('div', { class: 'tools' },
      a.kind === 'photo' ? h('button', { type: 'button', title: 'Rotate', 'aria-label': 'Rotate', onclick: () => assetAction(a, 'rotate') }, icon('rotate')) : null,
      h('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove', onclick: () => assetAction(a, 'delete') }, icon('trash'))));
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
    const res = await upload(`/api/projects/${state.project.id}/ad-assets${kind === 'logo' ? '?kind=logo' : ''}`, 'images', files, (p) => showUploadProgress(zone, p >= 1 ? 'Processing…' : `Uploading… ${Math.round(p * 100)}%`, p));
    state.project.adAssets = res.adAssets;
    for (const f of res.failed) toast(`${f.name}: ${f.error}`, { error: true });
    if (res.added.length) toast(kind === 'logo' ? 'Logo added' : `Added ${res.added.length} photo${res.added.length > 1 ? 's' : ''}`);
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
    await patchProject({ profile: state.profile });
    const { jobId } = await api(`/api/projects/${state.project.id}/ads/generate`, {
      method: 'POST',
      body: {
        business: s.business, businessCustom: s.businessCustom, profile: state.profile,
        count: s.adCount, seconds: s.adSeconds, format: s.adFormat, theme: s.adTheme,
        accent: s.adAccentOn ? s.adAccent : '', music: s.adMusic, musicLevel: s.musicLevel,
        mode: aiOn() ? 'ai' : 'auto', instructions: aiOn() ? s.adInstructions : '',
      },
    });
    state.adDrafts = {};
    state.openAdEditors.clear();
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
    state.adDrafts = {};
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
  if (plan?.source === 'ai' && plan.strategy) strategy.append(h('div', { class: 'strategy' }, h('b', {}, 'AI plan'), plan.strategy));
  if (plan?.source === 'auto') strategy.append(h('div', { class: 'strategy muted' }, h('b', {}, 'Free mode'), 'Ads built from templates and your business details. Add your Claude key in Settings for ads written for this business.'));
  if (plan?.musicNote) strategy.append(h('div', { class: 'notice' }, plan.musicNote));

  const box = $('#ads');
  if (!plan) {
    box.replaceChildren(h('div', { class: 'empty' },
      h('b', {}, state.job?.kind === 'ads' ? 'Making your ads…' : 'No ads yet'),
      h('span', {}, state.job?.kind === 'ads' ? 'This can take a minute or two.' : 'Fill in the business details, add photos or a logo if you have them, and press Make ads.')));
    return;
  }
  box.replaceChildren(h('div', { class: 'clips-grid' }, plan.ads.map((ad, i) => adCard(ad, renders[i], i, plan.format))));
}

function adCard(ad, rendered, i, format) {
  const pid = state.project.id;
  const busy = Boolean(state.job);
  const editing = state.openAdEditors.has(i);
  const postText = [ad.post_caption, (ad.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
  const ratio = { '9:16': '9 / 16', '1:1': '1 / 1', '4:5': '4 / 5' }[format] || '9 / 16';
  const media = h('div', { class: 'clip-video', style: { aspectRatio: ratio } }, rendered
    ? [h('video', { src: `/media/${pid}/ad-output/${rendered.file}`, poster: `/media/${pid}/ad-output/${rendered.thumb}`, controls: true, playsinline: true, preload: 'metadata' }),
      h('span', { class: 'dur' }, fmtDuration(rendered.duration))]
    : h('div', { class: 'clip-pending' }, busy ? 'Animating…' : h('div', {}, h('p', {}, 'Not rendered yet.'), h('br'),
      h('button', { class: 'btn btn-sm', onclick: () => renderAdOne(i), disabled: !ffmpegOk() }, icon('play'), 'Render'))));
  return h('article', { class: 'clip' }, media,
    h('div', { class: 'clip-body' },
      h('div', { class: 'clip-title' }, `${i + 1}. ${ad.title}`),
      h('div', { class: 'badges' },
        h('span', { class: 'badge style' }, themeLabel(ad.theme)),
        ad.angle ? h('span', { class: 'badge' }, ad.angle) : null,
        h('span', { class: 'badge' }, ad.music ? `♪ ${ad.music.name}` : 'No music')),
      ad.why_it_works ? h('div', { class: 'clip-why' }, h('b', {}, 'Why: '), ad.why_it_works) : null,
      h('div', { class: 'clip-actions' },
        rendered ? h('a', { class: 'btn btn-sm btn-primary', href: `/media/${pid}/ad-output/${rendered.file}`, download: `${slug(state.project.name)}-ad-${i + 1}.mp4` }, icon('download'), 'MP4') : null,
        postText ? h('button', { class: 'btn btn-sm', onclick: () => copyText(postText), title: 'Copy post caption + hashtags' }, icon('copy'), 'Caption') : null,
        h('button', { class: 'btn btn-sm', 'aria-expanded': String(editing), onclick: () => {
          editing ? state.openAdEditors.delete(i) : state.openAdEditors.add(i);
          renderAdResults();
        } }, icon('edit'), 'Edit')),
      editing ? adEditor(ad, i, busy) : null));
}

function adEditor(ad, i, busy) {
  const photos = (state.project.adAssets || []).filter((a) => a.kind === 'photo');
  const themes = state.status?.ads?.themes || [];
  const draft = (state.adDrafts[i] ??= structuredClone({
    theme: ad.theme, accent: ad.accent || '', music: ad.music?.id || 'none',
    scenes: ad.scenes.map((sc) => ({ ...sc, itemsText: (sc.items || []).join(', ') })),
  }));
  const bind = (obj, key) => (e) => { obj[key] = e.target.value; };
  const themeAccent = () => themes.find((t) => t.id === draft.theme)?.accent || '#ffb03d';
  return h('div', { class: 'clip-edit' },
    h('label', {}, 'Look'),
    h('select', { onchange: (e) => (draft.theme = e.target.value) }, themes.map((t) => h('option', { value: t.id, selected: t.id === draft.theme }, t.label))),
    h('div', { class: 'accent-row' },
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: Boolean(draft.accent), onchange: (e) => { draft.accent = e.target.checked ? (draft.accent || themeAccent()) : ''; } }), h('span'), 'Brand colour'),
      h('input', { type: 'color', value: draft.accent || themeAccent(), oninput: (e) => (draft.accent = e.target.value), 'aria-label': 'Brand colour' })),
    h('label', {}, 'Music'),
    h('select', { onchange: (e) => (draft.music = e.target.value) },
      h('option', { value: 'none', selected: draft.music === 'none' }, 'No music'),
      state.tracks.map((t) => h('option', { value: t.id, selected: t.id === draft.music }, t.name))),
    h('label', {}, 'Scenes'),
    h('div', { class: 'scene-list' }, draft.scenes.map((sc) => {
      const row = h('div', { class: `scene-edit${sc.removed ? ' removed' : ''}` },
        h('span', { class: 'role', style: { background: SCENE_COLORS[sc.type] } }, SCENE_LABELS[sc.type] || sc.type),
        h('input', { value: sc.headline || '', placeholder: 'Headline', maxlength: '90', oninput: bind(sc, 'headline') }),
        h('button', { class: 'icon-btn', type: 'button', title: sc.removed ? 'Put back' : 'Remove scene', onclick: () => {
          sc.removed = !sc.removed;
          row.classList.toggle('removed', sc.removed);
          row.querySelector('.icon-btn').replaceChildren(icon(sc.removed ? 'refresh' : 'trash'));
        } }, icon(sc.removed ? 'refresh' : 'trash')),
        h('input', { class: 'full', value: sc.subline || '', placeholder: 'Small line (optional)', maxlength: '90', oninput: bind(sc, 'subline') }),
        sc.type === 'features' || sc.type === 'cta'
          ? h('input', { class: 'full', value: sc.itemsText, placeholder: sc.type === 'cta' ? 'Button text, e.g. Book now' : 'Points, separated by commas', maxlength: '180', oninput: bind(sc, 'itemsText') })
          : null,
        h('div', { class: 'row' },
          h('select', { title: 'Photo behind this scene', onchange: (e) => (sc.photo = Number(e.target.value)) },
            h('option', { value: '-1', selected: sc.photo < 0 }, 'No photo (animated background)'),
            photos.map((_, k) => h('option', { value: String(k), selected: sc.photo === k }, `Photo ${k + 1}`))),
          h('input', { type: 'number', min: '1.2', max: '6', step: '0.1', value: String(sc.duration), title: 'Seconds', oninput: (e) => (sc.duration = Number(e.target.value)) })));
      return row;
    })),
    h('button', { class: 'btn btn-sm btn-primary', disabled: busy || !ffmpegOk(), onclick: () => renderAdOne(i) }, icon('refresh'), 'Save and re-render'));
}

async function renderAdOne(i) {
  const draft = state.adDrafts[i];
  const ad = draft ? {
    theme: draft.theme, accent: draft.accent, music: draft.music,
    scenes: draft.scenes.filter((sc) => !sc.removed).map(({ itemsText, removed, ...sc }) => ({ ...sc, items: String(itemsText || '').split(',').map((x) => x.trim()).filter(Boolean) })),
  } : {};
  if (draft && !ad.scenes.length) return toast('Keep at least one scene.', { error: true });
  try {
    const { jobId } = await api(`/api/projects/${state.project.id}/ads/${i}/render`, { method: 'POST', body: { ad } });
    state.adDrafts[i] = null;
    pollJob(jobId, 'ad-render');
  } catch (err) {
    toast(err.message, { error: true });
  }
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
  $('#ad-theme-select').addEventListener('change', (e) => setSetting('adTheme')(e.target.value));
  $('#ad-music-select').addEventListener('change', (e) => setSetting('adMusic')(e.target.value));
  $('#ad-accent').addEventListener('input', (e) => {
    setSetting('adAccent')(e.target.value);
    $('#ad-accent-on').checked = true;
    setSetting('adAccentOn')(true);
  });
  $('#ad-accent-on').addEventListener('change', (e) => setSetting('adAccentOn')(e.target.checked));
  $('#ad-instructions').addEventListener('change', (e) => setSetting('adInstructions')(e.target.value));
  $('#ad-generate').addEventListener('click', generateAds);
  $('#ad-ask-form').addEventListener('submit', askAds);

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
  await Promise.all([loadTracks(), loadServerSettings()]);
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
  }, 15000);
}

init();
