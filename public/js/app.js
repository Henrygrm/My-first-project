import { $, $$, api, copyText, fmtDuration, fmtSec, h, icon, slug, store, timeAgo, toast, upload } from './ui.js';
import { initMarketing, renderMarketingFromProject, syncFootageToggle } from './marketing.js';

const BIZ_ICONS = { restaurant: 'utensils', detailing: 'car', trades: 'wrench', barber: 'scissors', gym: 'dumbbell', other: 'store' };
const PLACEHOLDERS = {
  restaurant: 'e.g. Feature the new smash burger. Open on the cheese pull, keep it under 20 seconds.',
  detailing: 'e.g. Show the dirty bonnet first, speed up the polishing, end on the glossy reveal.',
  trades: 'e.g. Bathroom reno: start with the old tiles, finish on the walk-in shower.',
  barber: 'e.g. Skin fade and beard trim. Make the mirror reveal the final shot.',
  gym: 'e.g. Promote the 6am bootcamp. High energy, end on the group high-five.',
  other: 'e.g. What to highlight, what to leave out, any offer to mention.',
};
const ROLE_COLORS = { hook: '#ffb03d', setup: '#6aa8ff', process: '#6aa8ff', reveal: '#3ddc97', payoff: '#3ddc97', cta: '#c79bff' };

const DEFAULT_SETTINGS = {
  business: 'restaurant',
  businessCustom: '',
  platform: 'tiktok',
  clipCount: 2,
  targetSeconds: 30,
  mode: 'ai',
  reframe: 'auto',
  audio: 'original',
  onScreenText: true,
  speechSubtitles: false,
  instructions: '',
};

export const state = {
  status: null,
  project: null,
  settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
  job: null,
  subtab: 'clips',
  drafts: {}, // clip index -> edited copy
  openEditors: new Set(),
};

const saveSettings = () => store.set('settings', state.settings);
const aiReady = () => Boolean(state.status?.ai?.configured);
const ffmpegReady = () => Boolean(state.status?.ffmpeg?.available);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function ensureProject() {
  if (state.project) return state.project;
  const name = $('#project-name').value.trim() || 'Untitled project';
  const p = await api('/api/projects', { method: 'POST', body: { name } });
  setProject(p);
  await patchProject({ business: state.settings.business, businessCustom: state.settings.businessCustom, platform: state.settings.platform });
  return state.project;
}

function setProject(p) {
  state.project = p;
  state.drafts = {};
  state.openEditors.clear();
  if (p) {
    store.set('project', p.id);
    $('#project-name').value = p.name;
  } else {
    store.remove('project');
    $('#project-name').value = 'Untitled project';
  }
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
  if (!state.project) return;
  state.project = await api(`/api/projects/${state.project.id}`);
}

async function openProject(id) {
  const p = await api(`/api/projects/${id}`);
  setProject(p);
  // Bring the project's own choices back into the controls.
  Object.assign(state.settings, {
    business: p.business || state.settings.business,
    businessCustom: p.businessCustom || '',
    platform: p.platform || state.settings.platform,
    instructions: p.instructions ?? state.settings.instructions,
  });
  if (p.settings) {
    for (const k of ['clipCount', 'targetSeconds', 'mode', 'reframe', 'audio', 'onScreenText', 'speechSubtitles']) {
      if (p.settings[k] !== undefined) state.settings[k] = p.settings[k];
    }
  }
  if (state.settings.mode === 'ai' && !aiReady()) state.settings.mode = 'auto';
  saveSettings();
  renderAll();
  renderMarketingFromProject(p);
  if (p.activeJob) pollJob(p.activeJob);
}

async function newProject() {
  if (state.job) return toast('Wait for the current job to finish first.', { error: true });
  setProject(null);
  const p = await api('/api/projects', { method: 'POST', body: { name: 'Untitled project' } });
  setProject(p);
  await patchProject({ business: state.settings.business, businessCustom: state.settings.businessCustom, platform: state.settings.platform });
  renderAll();
  renderMarketingFromProject(p);
  $('#project-name').focus();
  $('#project-name').select();
}

async function showProjects() {
  const dlg = $('#projects-dialog');
  const list = $('#project-list');
  list.replaceChildren(h('li', { class: 'skeleton' }), h('li', { class: 'skeleton' }));
  dlg.showModal();
  const projects = await api('/api/projects').catch(() => []);
  const bizLabel = (id, custom) => custom || state.status?.businesses.find((b) => b.id === id)?.label || id;
  if (!projects.length) {
    list.replaceChildren(h('li', { class: 'muted small' }, 'No saved projects yet. Upload footage to start one.'));
    return;
  }
  list.replaceChildren(...projects.map((p) => h('li', { class: `project-item${p.id === state.project?.id ? ' current' : ''}` },
    h('div', { class: 'pthumb', style: p.thumb ? { backgroundImage: `url("${p.thumb}")` } : {} }),
    h('div', { class: 'pmeta', role: 'button', tabindex: '0', onclick: () => { dlg.close(); openProject(p.id); }, onkeydown: (e) => e.key === 'Enter' && (dlg.close(), openProject(p.id)) },
      h('b', {}, p.name),
      h('small', {}, `${bizLabel(p.business, p.businessCustom)} · ${p.videoCount} video${p.videoCount === 1 ? '' : 's'} · ${p.clipCount} clip${p.clipCount === 1 ? '' : 's'} · ${timeAgo(p.updatedAt)}`)),
    h('button', { class: 'icon-btn', title: 'Delete project', 'aria-label': `Delete ${p.name}`, onclick: async () => {
      if (!confirm(`Delete "${p.name}" and all of its footage and clips? This cannot be undone.`)) return;
      try {
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        if (p.id === state.project?.id) {
          setProject(null);
          renderAll();
          renderMarketingFromProject(null);
        }
        showProjects();
      } catch (err) {
        toast(err.message, { error: true });
      }
    } }, icon('trash')),
  )));
}

// ---------------------------------------------------------------------------
// Status + setup banner
// ---------------------------------------------------------------------------

function renderStatus() {
  const s = state.status;
  const pill = $('#status-pill');
  pill.className = 'status-pill';
  let label;
  if (!s) {
    pill.classList.add('err');
    label = 'Server offline';
  } else if (!s.ffmpeg.available) {
    pill.classList.add('err');
    label = 'FFmpeg missing';
  } else if (!s.ai.configured) {
    pill.classList.add('warn');
    label = 'Auto-edit only';
  } else {
    pill.classList.add('ok');
    label = 'Claude connected';
  }
  $('.label', pill).textContent = label;
  pill.title = s ? `Model: ${s.ai.model} · FFmpeg ${s.ffmpeg.version || 'not found'}` : 'Cannot reach the local server';

  const banner = $('#setup-banner');
  banner.replaceChildren();
  if (!s) {
    banner.append(h('div', { class: 'banner err' }, icon('alert'), h('div', {}, h('b', {}, 'Cannot reach the Cutline server.'), h('p', {}, 'Start it with ', h('code', {}, 'npm start'), ' and reload this page.'))));
    return;
  }
  if (!s.ffmpeg.available) {
    banner.append(h('div', { class: 'banner err' }, icon('alert'), h('div', {},
      h('b', {}, 'FFmpeg is not installed, so videos cannot be analysed or rendered.'),
      h('p', {}, 'Install it, then restart the server: macOS ', h('code', {}, 'brew install ffmpeg'), ' · Windows ', h('code', {}, 'winget install Gyan.FFmpeg'), ' · Linux ', h('code', {}, 'sudo apt install ffmpeg'), '. Or set ', h('code', {}, 'FFMPEG_PATH'), ' in .env.'))));
  }
  if (!s.ai.configured) {
    banner.append(h('div', { class: 'banner warn' }, icon('alert'), h('div', {},
      h('b', {}, 'Claude is not connected yet. '),
      h('span', { class: 'muted' }, 'Auto-edit still renders real clips, but AI editing and marketing need an API key.'),
      h('details', {}, h('summary', {}, 'How to connect Claude'),
        h('ol', {},
          h('li', {}, 'Create an API key at ', h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, h('u', {}, 'console.anthropic.com')), '.'),
          h('li', {}, 'Copy ', h('code', {}, '.env.example'), ' to ', h('code', {}, '.env'), ' in the project folder.'),
          h('li', {}, 'Set ', h('code', {}, 'ANTHROPIC_API_KEY=sk-ant-…'), ' and restart with ', h('code', {}, 'npm start'), '.'),
        )))));
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function renderBusinesses() {
  const grid = $('#biz-grid');
  const list = state.status?.businesses || [];
  grid.replaceChildren(...list.map((b) => h('button', {
    class: 'biz', role: 'radio', 'aria-checked': String(b.id === state.settings.business), title: b.tagline,
    onclick: () => selectBusiness(b.id),
  }, icon(BIZ_ICONS[b.id] || 'store'), h('b', {}, b.label), h('small', {}, b.tagline))));
  const cur = list.find((b) => b.id === state.settings.business);
  $('#biz-tagline').textContent = cur ? `Prioritises: ${cur.priorities.slice(0, 3).map((p) => p.split(':')[0].split(' (')[0]).join(' · ')}` : '';
  $('#biz-custom-wrap').hidden = state.settings.business !== 'other';
  $('#biz-custom').value = state.settings.businessCustom || '';
  $('#instructions').placeholder = PLACEHOLDERS[state.settings.business] || PLACEHOLDERS.other;
}

function selectBusiness(id) {
  state.settings.business = id;
  saveSettings();
  renderBusinesses();
  patchProject({ business: id });
  if (id === 'other') $('#biz-custom').focus();
}

function seg(container, options, value, onChange) {
  container.replaceChildren(...options.map(([val, label]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(val === value),
    onclick: () => {
      onChange(val);
      $$('button', container).forEach((b, i) => b.setAttribute('aria-checked', String(options[i][0] === val)));
    },
  }, label)));
}

function setSetting(key) {
  return (val) => {
    state.settings[key] = val;
    saveSettings();
    if (key === 'platform') patchProject({ platform: val });
  };
}

function renderControls() {
  const s = state.settings;
  seg($('#platform-seg'), (state.status?.platforms || []).map((p) => [p.id, p.label]), s.platform, setSetting('platform'));
  seg($('#clips-seg'), [[1, '1'], [2, '2'], [3, '3'], [4, '4']], s.clipCount, setSetting('clipCount'));
  seg($('#length-seg'), [[15, '15s'], [30, '30s'], [45, '45s'], [60, '60s']], s.targetSeconds, setSetting('targetSeconds'));
  seg($('#reframe-seg'), [['auto', 'Auto'], ['fill', 'Crop to fill'], ['fit', 'Fit + blur']], s.reframe, setSetting('reframe'));
  seg($('#audio-seg'), [['original', 'Original audio'], ['mute', 'Silent (add music in-app)']], s.audio, setSetting('audio'));

  const aiOpt = $('input[name="mode"][value="ai"]');
  aiOpt.disabled = !aiReady();
  const aiBody = aiOpt.nextElementSibling.querySelector('b');
  aiBody.querySelector('.engine-tag')?.remove();
  if (!aiReady()) aiBody.append(h('span', { class: 'engine-tag' }, 'Needs key'));
  if (s.mode === 'ai' && !aiReady()) s.mode = 'auto';
  $(`input[name="mode"][value="${s.mode}"]`).checked = true;

  $('#instructions').value = s.instructions || '';
  $('#opt-text').checked = s.onScreenText;
  const speechOk = Boolean(state.status?.transcription?.configured);
  $('#opt-speech').disabled = !speechOk;
  $('#opt-speech').checked = speechOk && s.speechSubtitles;
  $('#speech-note').textContent = speechOk ? '(Whisper)' : '(needs OPENAI_API_KEY)';
  updateGenerateState();
}

function updateGenerateState() {
  const btn = $('#btn-generate');
  const hint = $('#gen-hint');
  const videos = state.project?.videos?.length || 0;
  let reason = '';
  if (!ffmpegReady()) reason = 'Install FFmpeg to generate clips.';
  else if (!videos) reason = 'Upload at least one video to start.';
  else if (state.job) reason = 'Working on it…';
  btn.disabled = Boolean(reason);
  hint.textContent = reason || (state.settings.mode === 'ai'
    ? `Claude reviews your footage, then FFmpeg renders ${state.settings.clipCount} clip${state.settings.clipCount > 1 ? 's' : ''}.`
    : 'Auto-edit picks moments by motion and sound. No AI involved.');
}

// ---------------------------------------------------------------------------
// Footage
// ---------------------------------------------------------------------------

function renderVideos() {
  const list = $('#video-list');
  const videos = state.project?.videos || [];
  const total = videos.reduce((s, v) => s + v.meta.duration, 0);
  $('#footage-total').textContent = videos.length ? `${videos.length} video${videos.length > 1 ? 's' : ''} · ${fmtDuration(total)}` : '';
  list.replaceChildren(...videos.map((v, i) => h('li', { class: 'video-item' },
    h('button', { class: 'video-thumb', title: 'Preview', onclick: () => previewVideo(`/media/${state.project.id}/videos/${v.file}`, v.name) },
      h('img', { src: `/media/${state.project.id}/videos/${v.thumb}`, alt: '' }), icon('play'), h('span', { class: 'vnum' }, i + 1)),
    h('div', { class: 'video-meta' },
      h('b', { title: v.name }, v.name),
      h('small', {}, `${fmtDuration(v.meta.duration)} · ${v.meta.width}×${v.meta.height} ${v.meta.orientation}${v.meta.hasAudio ? '' : ' · no audio'}`)),
    h('button', { class: 'icon-btn', title: 'Remove video', 'aria-label': `Remove ${v.name}`, onclick: () => removeVideo(v) }, icon('trash')),
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
  if (state.project.plan && !confirm(`Remove "${v.name}"? The current edit plan uses video numbers, so you'll need to generate again.`)) return;
  try {
    state.project = await api(`/api/projects/${state.project.id}/videos/${v.id}`, { method: 'DELETE' });
    renderVideos();
    renderResults();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function handleFiles(files) {
  files = [...files].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts)$/i.test(f.name));
  if (!files.length) return toast('Those files are not videos.', { error: true });
  if (state.job) return toast('Wait for the current job to finish first.', { error: true });
  const dz = $('#dropzone');
  const prog = $('.dz-progress', dz);
  prog.hidden = false;
  $('i', prog).style.width = '0%';
  $('em', prog).textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`;
  try {
    await ensureProject();
    const res = await upload(`/api/projects/${state.project.id}/videos`, 'videos', files, (p) => {
      $('i', prog).style.width = `${Math.round(p * 100)}%`;
      if (p >= 1) $('em', prog).textContent = 'Reading video details…';
    });
    state.project.videos = res.videos;
    renderVideos();
    if (res.added.length) toast(`Added ${res.added.length} video${res.added.length > 1 ? 's' : ''}`);
    for (const f of res.failed) toast(`${f.name}: ${f.error}`, { error: true });
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    prog.hidden = true;
    $('#file-input').value = '';
  }
}

// ---------------------------------------------------------------------------
// Generate + jobs
// ---------------------------------------------------------------------------

async function generate() {
  const s = state.settings;
  s.instructions = $('#instructions').value;
  saveSettings();
  try {
    await ensureProject();
    const { jobId } = await api(`/api/projects/${state.project.id}/generate`, {
      method: 'POST',
      body: {
        business: s.business, businessCustom: s.businessCustom, platform: s.platform, instructions: s.instructions,
        clipCount: s.clipCount, targetSeconds: s.targetSeconds, mode: s.mode, reframe: s.reframe, audio: s.audio,
        onScreenText: s.onScreenText, speechSubtitles: s.speechSubtitles,
      },
    });
    state.subtab = 'clips';
    pollJob(jobId);
  } catch (err) {
    showJobError(err.message);
  }
}

async function renderOne(index) {
  const draft = state.drafts[index];
  const clip = draft ? { ...draft, segments: draft.segments.filter((sg) => !sg.removed) } : undefined;
  if (clip && !clip.segments.length) return toast('Keep at least one segment.', { error: true });
  try {
    const { jobId } = await api(`/api/projects/${state.project.id}/clips/${index}/render`, { method: 'POST', body: { clip } });
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
  while (state.job?.id === jobId) {
    let job;
    try {
      job = await api(`/api/jobs/${jobId}`);
      misses = 0;
    } catch (err) {
      if (err.status === 404) {
        // The server restarted and forgot the job; show whatever was saved.
        state.job = null;
        box.hidden = true;
        toast('The server restarted. Anything not finished shows a Render button.', { error: true });
        break;
      }
      if (!err.status && ++misses <= 15) {
        $('#job-stage').textContent = 'Lost connection to the Cutline server, retrying…';
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      state.job = null;
      showJobError(err.status ? err.message : 'The Cutline server stopped. Check the Terminal window: run npm start again, then reload this page.');
      break;
    }
    $('#job-stage').textContent = job.stage;
    $('#job-pct').textContent = `${Math.round(job.progress * 100)}%`;
    $('#job-bar').style.width = `${Math.round(job.progress * 100)}%`;

    if (job.status === 'done' || job.status === 'error') {
      state.job = null;
      if (job.status === 'error') {
        showJobError(job.error);
        toast(job.code === 'SETUP_REQUIRED' ? 'Setup needed. See the message under the Generate button.' : 'Generation failed', { error: true });
      } else {
        setTimeout(() => { if (!state.job) box.hidden = true; }, 2500);
        toast(job.kind === 'render' ? 'Clip re-rendered' : 'Your clips are ready');
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 900));
  }

  // Whatever happened, show the latest saved plan/clips.
  try {
    const keepDrafts = state.drafts;
    await reloadProject();
    state.drafts = keepDrafts;
  } catch {}
  updateGenerateState();
  renderResults();
}

// ---------------------------------------------------------------------------
// Results: clips
// ---------------------------------------------------------------------------

function clipLength(clip) {
  return clip.segments.reduce((s, sg) => s + (sg.end - sg.start) / (sg.speed || 1), 0);
}

function renderResults() {
  const plan = state.project?.plan;
  const clips = state.project?.clips || [];
  syncFootageToggle(state.project);
  $('#clips-count').textContent = plan ? String(plan.clips.length) : '';

  const badge = $('#plan-badge');
  badge.replaceChildren();
  if (plan) {
    badge.append(
      h('span', { class: `tag ${plan.source}` }, plan.source === 'ai' ? 'Claude AI' : 'Auto-edit'),
      `${plan.businessLabel} · ${state.status?.platforms.find((p) => p.id === plan.platform)?.label || plan.platform}`,
    );
    if (plan.stale) badge.append(h('span', { class: 'tag stale', title: 'Footage changed since this plan was made' }, 'Footage changed'));
  }

  $$('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.subtab === state.subtab));
  $('#sub-clips').hidden = state.subtab !== 'clips';
  $('#sub-plan').hidden = state.subtab !== 'plan';

  const empty = (title, text) => h('div', { class: 'empty' }, h('div', { class: 'empty-art' }, h('span'), h('span'), h('span')), h('h4', {}, title), h('p', {}, text));

  if (!plan) {
    const msg = state.job
      ? empty('Working on your clips…', 'Analysing footage and building the edit. This usually takes under a minute per clip.')
      : empty('Your clips will appear here', 'Pick a business type, upload raw footage and hit Generate Content. You can preview, tweak the text, re-render and download each clip.');
    $('#sub-clips').replaceChildren(msg);
    $('#sub-plan').replaceChildren(empty('No edit plan yet', 'The plan shows which moments were chosen, what was cut and why.'));
    return;
  }

  $('#sub-clips').replaceChildren(h('div', { class: 'clips-grid' }, plan.clips.map((clip, i) => clipCard(clip, clips[i], i))));
  $('#sub-plan').replaceChildren(planView(plan));
}

function clipCard(clip, rendered, i) {
  const pid = state.project.id;
  const base = `${slug(state.project.name)}-${slug(clip.title)}`;
  const busy = Boolean(state.job);
  const postText = [clip.post_caption, (clip.hashtags || []).join(' ')].filter(Boolean).join('\n\n');

  const media = rendered
    ? h('div', { class: 'clip-video' },
      h('video', { src: `/media/${pid}/output/${rendered.file}`, poster: `/media/${pid}/output/${rendered.thumb}`, controls: true, playsinline: true, preload: 'metadata' }),
      h('span', { class: 'dur' }, fmtDuration(rendered.duration)))
    : h('div', { class: 'clip-video' }, h('div', { class: 'clip-pending' }, busy ? 'Rendering…' : h('div', {},
      h('p', {}, 'Planned but not rendered yet.'), h('br'),
      h('button', { class: 'btn btn-sm', onclick: () => renderOne(i), disabled: busy || !ffmpegReady() }, icon('play'), 'Render clip'))));

  const editing = state.openEditors.has(i);
  const card = h('article', { class: 'clip' }, media,
    h('div', { class: 'clip-body' },
      h('div', {}, h('div', { class: 'clip-title' }, clip.title), h('div', { class: 'clip-concept' }, clip.concept)),
      h('div', { class: 'clip-actions' },
        rendered ? h('a', { class: 'btn btn-sm btn-primary', href: `/media/${pid}/output/${rendered.file}`, download: `${base}.mp4` }, icon('download'), 'MP4') : null,
        rendered ? h('a', { class: 'btn btn-sm', href: `/media/${pid}/output/${rendered.srt}`, download: `${base}.srt`, title: 'Caption file to upload with the video' }, 'SRT') : null,
        postText ? h('button', { class: 'btn btn-sm', onclick: () => copyText(postText), title: 'Copy post caption + hashtags' }, icon('copy'), 'Caption') : null,
        h('button', { class: `btn btn-sm${editing ? ' active' : ''}`, 'aria-expanded': String(editing), onclick: () => {
          editing ? state.openEditors.delete(i) : state.openEditors.add(i);
          renderResults();
        } }, icon('edit'), 'Edit'),
      ),
      editing ? clipEditor(clip, i, busy) : null,
    ));
  return card;
}

function clipEditor(clip, i, busy) {
  const draft = (state.drafts[i] ??= structuredClone({ hook_text: clip.hook_text, cta_text: clip.cta_text, segments: clip.segments }));
  const bind = (obj, key) => (e) => { obj[key] = e.target.value; };
  return h('div', { class: 'clip-edit' },
    h('label', {}, 'Hook (first 2–3s)'),
    h('input', { value: draft.hook_text || '', maxlength: '80', oninput: bind(draft, 'hook_text') }),
    h('label', {}, 'Segments & captions'),
    h('div', { class: 'seg-edit-list' }, draft.segments.map((sg) => {
      const row = h('div', { class: `seg-edit${sg.removed ? ' removed' : ''}` },
        h('span', { class: 'role', style: { background: ROLE_COLORS[sg.role] || '#6aa8ff' } }, sg.role || 'clip'),
        h('input', { value: sg.caption || '', placeholder: 'No caption', maxlength: '60', oninput: bind(sg, 'caption') }),
        h('button', { class: 'icon-btn', title: sg.removed ? 'Restore segment' : 'Remove segment', onclick: () => {
          sg.removed = !sg.removed;
          row.classList.toggle('removed', sg.removed);
          row.querySelector('.icon-btn').replaceChildren(icon(sg.removed ? 'refresh' : 'trash'));
        } }, icon(sg.removed ? 'refresh' : 'trash')),
        h('span', { class: 'src' }, `Video ${sg.video + 1} · ${fmtSec(sg.start)}–${fmtSec(sg.end)}${sg.speed !== 1 ? ` · ${sg.speed}×` : ''}`),
      );
      return row;
    })),
    h('label', {}, 'Call to action (last 2–3s)'),
    h('input', { value: draft.cta_text || '', maxlength: '60', oninput: bind(draft, 'cta_text') }),
    h('button', { class: 'btn btn-sm btn-primary', disabled: busy || !ffmpegReady(), onclick: () => renderOne(i) }, icon('refresh'), 'Re-render clip'),
  );
}

// ---------------------------------------------------------------------------
// Results: edit plan
// ---------------------------------------------------------------------------

function planView(plan) {
  const vids = state.project.videos;
  const vname = (i) => `Video ${i + 1}`;
  const wrap = h('div', {});
  wrap.append(h('div', { class: 'plan-summary' }, plan.summary,
    h('span', { class: 'muted' }, `${plan.source === 'ai' ? `Planned by ${plan.model || 'Claude'}` : 'Auto-edit (no AI)'} · ${new Date(plan.createdAt).toLocaleString()}`)));

  wrap.append(h('div', { class: 'plan-section' }, h('h4', {}, 'Clips'), plan.clips.map((clip) => {
    const len = clipLength(clip);
    return h('div', { class: 'plan-clip' },
      h('div', { class: 'plan-clip-head' }, h('b', {}, clip.title), h('span', { class: 'muted small' }, `${fmtDuration(len)} · ${clip.segments.length} cuts`)),
      clip.concept ? h('div', { class: 'muted small' }, clip.concept) : null,
      h('div', { class: 'plan-hook' }, 'Hook: ', h('q', {}, clip.hook_text), clip.hook_reason ? h('span', { class: 'muted' }, ` · ${clip.hook_reason}`) : null),
      h('div', { class: 'timeline', role: 'img', 'aria-label': 'Clip timeline' }, clip.segments.map((sg) => {
        const d = (sg.end - sg.start) / (sg.speed || 1);
        return h('span', { style: { flex: String(d), background: ROLE_COLORS[sg.role] || '#6aa8ff' }, title: `${sg.role}: ${vname(sg.video)} ${fmtSec(sg.start)}–${fmtSec(sg.end)}` }, d > len / 10 ? sg.role : '');
      })),
      h('div', { class: 'timeline-legend' }, h('span', {}, '0:00'), h('span', {}, fmtDuration(len))),
      h('table', { class: 'seg-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Role'), h('th', {}, 'Source'), h('th', {}, 'Caption'), h('th', { class: 'why' }, 'Why'))),
        h('tbody', {}, clip.segments.map((sg) => h('tr', {},
          h('td', {}, h('span', { class: 'role-chip', style: { background: ROLE_COLORS[sg.role] || '#6aa8ff' } }, sg.role)),
          h('td', {}, `${vname(sg.video)} · ${fmtSec(sg.start)}–${fmtSec(sg.end)}${sg.speed !== 1 ? ` · ${sg.speed}×` : ''}`),
          h('td', {}, sg.caption || h('span', { class: 'muted' }, '—')),
          h('td', { class: 'why' }, sg.why || ''),
        )))),
      h('dl', { class: 'kv' },
        h('dt', {}, 'CTA'), h('dd', {}, clip.cta_text || '—'),
        h('dt', {}, 'Pacing'), h('dd', {}, clip.pacing_notes || '—'),
        h('dt', {}, 'Audio'), h('dd', {}, clip.music_suggestion || '—'),
      ),
    );
  })));

  if (plan.footage_review?.length) {
    wrap.append(h('div', { class: 'plan-section' }, h('h4', {}, 'Footage review'), h('ul', { class: 'list' }, plan.footage_review.map((r) => h('li', {},
      h('span', { class: 'time' }, `${vname(r.video)} ${fmtSec(r.start)}–${fmtSec(r.end)}`),
      h('span', { style: { flex: '1' } }, r.description),
      h('span', { class: `q ${r.quality}` }, r.quality))))));
  }
  if (plan.cut_sections?.length) {
    wrap.append(h('div', { class: 'plan-section' }, h('h4', {}, 'Cut from the edit'), h('ul', { class: 'list' }, plan.cut_sections.map((r) => h('li', {},
      h('span', { class: 'time' }, `${vname(r.video)} ${fmtSec(r.start)}–${fmtSec(r.end)}`), h('span', {}, r.reason))))));
  }
  if (plan.reshoot_tips?.length) {
    wrap.append(h('div', { class: 'plan-section' }, h('h4', {}, 'Film better footage next time'), h('ul', { class: 'list' }, plan.reshoot_tips.map((t) => h('li', {}, t)))));
  }
  if (!vids.length) wrap.append(h('p', { class: 'muted small' }, 'The source videos for this plan were removed.'));
  return wrap;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function switchTab(tab) {
  store.set('tab', tab);
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  $('#tab-editor').hidden = tab !== 'editor';
  $('#tab-marketing').hidden = tab !== 'marketing';
}

function renderAll() {
  renderStatus();
  renderBusinesses();
  renderControls();
  renderVideos();
  renderResults();
}

function wire() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $$('[data-goto-tab]').forEach((a) => a.addEventListener('click', () => switchTab(a.dataset.gotoTab)));
  $$('[data-start]').forEach((a) => a.addEventListener('click', () => switchTab('editor')));
  $$('.subtab').forEach((b) => b.addEventListener('click', () => { state.subtab = b.dataset.subtab; renderResults(); }));

  const dz = $('#dropzone');
  $('#file-input').addEventListener('change', (e) => handleFiles(e.target.files));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  // Stop a missed drop from navigating away to the video file.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { state.settings.mode = r.value; saveSettings(); updateGenerateState(); }));
  $('#instructions').addEventListener('change', (e) => { state.settings.instructions = e.target.value; saveSettings(); });
  $('#opt-text').addEventListener('change', (e) => { state.settings.onScreenText = e.target.checked; saveSettings(); });
  $('#opt-speech').addEventListener('change', (e) => { state.settings.speechSubtitles = e.target.checked; saveSettings(); });
  $('#biz-custom').addEventListener('change', (e) => { state.settings.businessCustom = e.target.value.trim(); saveSettings(); patchProject({ businessCustom: state.settings.businessCustom }); });
  $('#btn-generate').addEventListener('click', generate);

  const nameInput = $('#project-name');
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && nameInput.blur());
  nameInput.addEventListener('change', async () => {
    if (!nameInput.value.trim()) nameInput.value = state.project?.name || 'Untitled project';
    if (!state.project) return;
    await patchProject({ name: nameInput.value.trim() });
    $('#saved-hint').textContent = 'Saved';
    setTimeout(() => ($('#saved-hint').textContent = ''), 1500);
  });
  $('#btn-projects').addEventListener('click', showProjects);
  $('#btn-new-project').addEventListener('click', newProject);
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => e.target === d && d.close()));
  $('#video-dialog').addEventListener('close', () => { const p = $('#video-dialog-player'); p.pause(); p.removeAttribute('src'); p.load(); });
}

async function init() {
  wire();
  switchTab(store.get('tab', 'editor'));
  try {
    state.status = await api('/api/status');
  } catch {
    state.status = null;
  }
  if (state.settings.mode === 'ai' && !aiReady()) state.settings.mode = 'auto';

  const ctx = { state, ensureProject, aiReady };
  initMarketing(ctx);

  const saved = store.get('project', null);
  if (saved && state.status) {
    try {
      await openProject(saved);
      return;
    } catch {
      store.remove('project');
    }
  }
  renderAll();
  renderMarketingFromProject(null);
}

init();
