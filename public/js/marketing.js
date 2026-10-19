import { $, api, copyText, h, icon, store, toast } from './ui.js';

const SECTIONS = [
  ['hooks', 'Video hooks'],
  ['captions', 'Captions'],
  ['hashtags', 'Hashtags'],
  ['ctas', 'Calls to action'],
  ['video_concepts', 'Video concepts'],
  ['seven_day_plan', '7-day content plan'],
  ['promotions', 'Promotional posts'],
  ['engagement_tips', 'Engagement tips'],
];

let ctx;
const mk = { data: null, busy: new Set(), loadingAll: false };

function form() {
  const f = $('#mk-form');
  const tone = f.tone.value === 'custom' ? f.toneCustom.value.trim() || 'Friendly and confident' : f.tone.value;
  return {
    name: f.name.value.trim(),
    location: f.location.value.trim(),
    services: f.services.value.trim(),
    audience: f.audience.value.trim(),
    toneChoice: f.tone.value,
    toneCustom: f.toneCustom.value.trim(),
    tone,
    extra: f.extra.value.trim(),
  };
}

function fillForm(p = {}) {
  const f = $('#mk-form');
  for (const k of ['name', 'location', 'services', 'audience', 'extra']) f[k].value = p[k] || '';
  f.tone.value = p.toneChoice || 'Friendly and local';
  f.toneCustom.value = p.toneCustom || '';
  f.toneCustom.hidden = f.tone.value !== 'custom';
}

function footageContext() {
  const plan = ctx.state.project?.plan;
  if (!plan || !$('#mk-context').checked) return '';
  return [
    plan.summary,
    ...plan.clips.map((c, i) => `Clip ${i + 1} "${c.title}": ${c.concept} Hook: "${c.hook_text}". CTA: "${c.cta_text}".`),
  ].join('\n');
}

function profilePayload() {
  const { settings } = ctx.state;
  return { ...form(), businessType: settings.business, businessCustom: settings.businessCustom };
}

// ---------------------------------------------------------------------------

function copyBtn(text, title = 'Copy') {
  return h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick: () => copyText(text) }, icon('copy'));
}

function item(text, { label, sub, list } = {}) {
  const copy = [label, text, sub, list?.map((x) => `- ${x}`).join('\n')].filter(Boolean).join('\n');
  return h('div', { class: 'mk-item' },
    h('div', { class: 'txt' },
      label ? h('span', { class: 'lbl' }, label) : null,
      text,
      sub ? h('span', { class: 'sub' }, sub) : null,
      list?.length ? h('ul', {}, list.map((x) => h('li', {}, x))) : null),
    copyBtn(copy));
}

const RENDER = {
  hooks: (d) => [d.map((x) => item(x)), d.map((x) => x).join('\n')],
  ctas: (d) => [d.map((x) => item(x)), d.join('\n')],
  engagement_tips: (d) => [d.map((x) => item(x)), d.map((x) => `- ${x}`).join('\n')],
  captions: (d) => [d.map((c) => item(c.text, { label: c.style })), d.map((c) => c.text).join('\n\n---\n\n')],
  promotions: (d) => [
    d.map((p) => item(p.post_copy, { label: p.title, sub: `Offer: ${p.offer}` })),
    d.map((p) => `${p.title}\nOffer: ${p.offer}\n\n${p.post_copy}`).join('\n\n---\n\n'),
  ],
  video_concepts: (d) => [
    d.map((c) => item(c.description, { label: c.title, sub: `Hook: “${c.hook}”`, list: c.shot_list })),
    d.map((c) => `${c.title}\nHook: ${c.hook}\n${c.description}\nShots:\n${c.shot_list.map((s) => `- ${s}`).join('\n')}`).join('\n\n'),
  ],
  hashtags: (d) => {
    const norm = (t) => (t.startsWith('#') ? t : `#${t}`).replace(/\s+/g, '');
    const groups = [['broad', 'Broad'], ['niche', 'Niche & industry'], ['local', 'Local']];
    const all = groups.flatMap(([k]) => (d[k] || []).map(norm));
    return [
      groups.map(([k, label]) => {
        const tags = (d[k] || []).map(norm);
        return h('div', { class: 'tag-group' },
          h('div', { class: 'tag-group-title' }, label, copyBtn(tags.join(' '), `Copy ${label.toLowerCase()} hashtags`)),
          h('div', { class: 'tags' }, tags.map((t) => h('button', { class: 'tag-chip', type: 'button', title: 'Copy', onclick: () => copyText(t) }, t))));
      }),
      all.join(' '),
    ];
  },
  seven_day_plan: (d) => [
    h('div', { class: 'days' }, d.map((x) => h('div', { class: 'day' },
      h('span', { class: 'd' }, x.day),
      h('div', {}, h('span', { class: 'fmt' }, `${x.format} · ${x.theme}`), h('div', { class: 'idea' }, x.idea), h('div', { class: 'starter' }, x.caption_starter)),
      copyBtn(`${x.day} (${x.format}, ${x.theme})\n${x.idea}\nCaption: ${x.caption_starter}`)))),
    d.map((x) => `${x.day} (${x.format}, ${x.theme})\n${x.idea}\nCaption: ${x.caption_starter}`).join('\n\n'),
  ],
};

function sectionCard(key, label) {
  const data = mk.data?.[key];
  const busy = mk.busy.has(key);
  let body;
  let copyAll = '';
  if (!data) {
    body = [h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })];
  } else {
    [body, copyAll] = RENDER[key](data);
  }
  return h('section', { class: 'mk-section', id: `mk-${key}` },
    h('div', { class: 'mk-head' },
      h('h4', {}, label),
      h('div', { class: 'mk-tools' },
        copyAll ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => copyText(copyAll) }, icon('copy'), 'Copy all') : null,
        data ? h('button', { class: `icon-btn${busy ? ' spin' : ''}`, type: 'button', title: 'Regenerate this section', 'aria-label': `Regenerate ${label}`, disabled: busy, onclick: () => regenerate(key) }, icon('refresh')) : null)),
    h('div', { class: `mk-body${busy ? ' loading' : ''}` }, body));
}

function setupCard() {
  return h('div', { class: 'setup-card' },
    h('h4', {}, icon('alert'), 'Connect Claude to generate marketing content'),
    h('p', { class: 'muted' }, 'Marketing copy is written by Claude, so it needs an API key. Nothing is generated until it is connected.'),
    h('ol', {},
      h('li', {}, 'Create a key at ', h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, h('u', {}, 'console.anthropic.com')), '.'),
      h('li', {}, 'Copy ', h('code', {}, '.env.example'), ' to ', h('code', {}, '.env'), ' and set ', h('code', {}, 'ANTHROPIC_API_KEY'), '.'),
      h('li', {}, 'Restart the server with ', h('code', {}, 'npm start'), ' and reload this page.')));
}

function render() {
  const root = $('#mk-results');
  if (!ctx.aiReady()) {
    root.replaceChildren(setupCard());
    return;
  }
  if (!mk.data && !mk.loadingAll) {
    root.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'empty' },
      h('div', { class: 'empty-art' }, h('span'), h('span'), h('span')),
      h('h4', {}, 'Marketing content will appear here'),
      h('p', {}, 'Fill in the business details and hit Generate. You get captions, hooks, hashtags, video concepts, a 7-day plan, promo posts, engagement tips and calls to action.'))));
    return;
  }
  root.replaceChildren(...SECTIONS.map(([k, l]) => sectionCard(k, l)));
}

function rerenderSection(key) {
  const label = SECTIONS.find(([k]) => k === key)[1];
  $(`#mk-${key}`)?.replaceWith(sectionCard(key, label));
}

async function generateAll(e) {
  e.preventDefault();
  if (!ctx.aiReady()) return render();
  const profile = profilePayload();
  store.set('marketing', profile);
  mk.data = null;
  mk.loadingAll = true;
  const btn = $('#btn-marketing');
  btn.disabled = true;
  btn.lastChild.textContent = ' Writing…';
  render();
  try {
    const project = await ctx.ensureProject();
    const res = await api('/api/marketing', { method: 'POST', body: { profile, footageContext: footageContext(), projectId: project.id } });
    mk.data = res.data;
    toast('Marketing content ready');
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    mk.loadingAll = false;
    btn.disabled = false;
    btn.lastChild.textContent = ' Generate Marketing';
    render();
  }
}

async function regenerate(key) {
  if (mk.busy.has(key)) return;
  mk.busy.add(key);
  rerenderSection(key);
  try {
    const project = await ctx.ensureProject();
    const res = await api('/api/marketing', {
      method: 'POST',
      body: { profile: profilePayload(), section: key, previous: mk.data?.[key], footageContext: footageContext(), projectId: project.id },
    });
    mk.data = { ...mk.data, [key]: res.data[key] };
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    mk.busy.delete(key);
    rerenderSection(key);
  }
}

export function renderMarketingFromProject(project) {
  const m = project?.marketing;
  if (m?.profile) fillForm(m.profile);
  mk.data = m?.data || null;
  syncFootageToggle(project);
  render();
}

export function syncFootageToggle(project) {
  $('#mk-context-wrap').hidden = !project?.plan;
}

export function initMarketing(context) {
  ctx = context;
  fillForm(store.get('marketing', {}));
  const f = $('#mk-form');
  f.addEventListener('submit', generateAll);
  f.tone.addEventListener('change', () => {
    f.toneCustom.hidden = f.tone.value !== 'custom';
    if (!f.toneCustom.hidden) f.toneCustom.focus();
  });
  f.addEventListener('change', () => store.set('marketing', profilePayload()));
}
