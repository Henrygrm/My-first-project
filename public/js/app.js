import { $, $$, api, copyText, fmtDuration, fmtSec, h, icon, slug, store, timeAgo, toast, upload } from './ui.js';

// Must match package.json. If the server reports a different version, an
// old copy of Cutline is still running and new features won't work.
const APP_VERSION = '2.0.0';

const ROLE_COLORS = { hook: '#ffb03d', setup: '#6aa8ff', process: '#6aa8ff', reveal: '#3ddc97', payoff: '#3ddc97', cta: '#c79bff' };
const DEFAULTS = {
  business: 'restaurant', businessCustom: '', platform: 'tiktok', clipCount: 2, targetSeconds: 30,
  style: 'mix', music: 'auto', musicLevel: 'normal', mode: 'ai', reframe: 'auto', audio: 'original',
  onScreenText: true, speechSubtitles: false, instructions: '',
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
  const page = ['home', 'music', 'settings'].includes(name) ? name : 'home';
  $$('.page').forEach((p) => (p.hidden = p.id !== `page-${page}`));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  if (page === 'music') renderMusicPage();
  if (page === 'settings') renderSettings();
  if (page === 'home') renderHome();
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
  if (p.profile && Object.values(p.profile).some(Boolean)) state.profile = { ...p.profile };
  saveSettings();
  renderHome();
  if (p.activeJob) pollJob(p.activeJob);
}

async function newProject() {
  if (state.job) return toast('Wait for the current job to finish first.', { error: true });
  setProject(null);
  await ensureProject();
  renderHome();
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
          renderHome();
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
      body: { request, clipIndex: which === 'all' ? null : Number(which) },
    });
    input.value = '';
    state.project.chat = [...(state.project.chat || []), { who: 'you', text: which === 'all' ? request : `Clip ${Number(which) + 1}: ${request}` }];
    renderChat();
    pollJob(jobId);
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

function showJobError(message) {
  const box = $('#job');
  box.hidden = false;
  box.classList.add('error');
  $('#job-stage').textContent = message;
  $('#job-pct').textContent = '';
  $('#job-bar').style.width = '0%';
}

async function pollJob(jobId) {
  state.job = { id: jobId };
  const box = $('#job');
  box.hidden = false;
  box.classList.remove('error');
  updateGenerateState();
  renderResults();
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
        box.hidden = true;
        toast('Cutline restarted. Anything unfinished has a Render button.', { error: true });
        break;
      }
      if (!err.status && ++misses <= 15) {
        $('#job-stage').textContent = 'Lost connection to Cutline, retrying…';
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      state.job = null;
      showJobError(err.status ? err.message : 'Cutline stopped. Double-click "Start Cutline", then reload this page.');
      break;
    }
    $('#job-stage').textContent = job.stage;
    $('#job-pct').textContent = `${Math.round(job.progress * 100)}%`;
    $('#job-bar').style.width = `${Math.round(job.progress * 100)}%`;
    if (job.status === 'done' || job.status === 'error') {
      state.job = null;
      finished = job;
      if (job.status === 'error') {
        showJobError(job.error);
        if (job.kind === 'revise') toast(job.error, { error: true });
      } else {
        setTimeout(() => { if (!state.job) box.hidden = true; }, 2000);
        if (job.kind === 'generate') toast('Clips ready');
        if (job.kind === 'render') toast('Clip updated');
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  try {
    await reloadProject();
  } catch {}
  updateGenerateState();
  renderResults();
}

// ---------------------------------------------------------------------------
// Home: results
// ---------------------------------------------------------------------------

function renderChat() {
  const chat = state.project?.chat || [];
  const box = $('#chat');
  box.replaceChildren(...chat.slice(-12).map((m) => h('div', { class: `msg ${m.who}` }, m.text)));
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
  $('#about').textContent = `Cutline ${APP_VERSION}${state.status ? ` · server ${state.status.version || 'old'} · FFmpeg ${state.status.ffmpeg.version || 'missing'}` : ''}`;
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
      clearTimeout(profileTimer);
      profileTimer = setTimeout(() => patchProject({ profile: state.profile }), 600);
    });
  }
  $('#style-select').addEventListener('change', (e) => setSetting('style')(e.target.value));
  $('#music-select').addEventListener('change', (e) => setSetting('music')(e.target.value));
  $('#instructions').addEventListener('change', (e) => setSetting('instructions')(e.target.value));

  const dz = $('#dropzone');
  $('#file-input').addEventListener('change', (e) => handleVideoFiles(e.target.files));
  for (const [zone, handler] of [[dz, handleVideoFiles], [$('#music-drop'), handleMusicFiles]]) {
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

  $('#btn-generate').addEventListener('click', generate);
  $('#ask-form').addEventListener('submit', ask);

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
