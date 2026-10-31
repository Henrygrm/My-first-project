// A tiny stand-in for the Anthropic Messages API, used by the smoke test so
// the full AI workflow can be exercised without an API key or spending credits.
// It streams responses in the real SSE wire format and returns schema-shaped
// JSON for edit plans and change requests.
//
//   node scripts/mock-anthropic.mjs 4555
//   ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4555 npm start
import http from 'node:http';

export const requests = [];

function planFor(text) {
  const videos = [...text.matchAll(/=== VIDEO (\d+): ".+?", ([\d.]+)s/g)].map((m) => ({ n: Number(m[1]), dur: Number(m[2]) }));
  const clipCount = Number(text.match(/DELIVERABLE: (\d+) clip/)?.[1] || 1);
  const assigned = [...text.matchAll(/clip \d+ = "(\w+)"/g)].map((m) => m[1]);
  // No styles given = the AI chooses; pick a different one per clip like a real plan would.
  const own = ['transformation', 'satisfying', 'promo', 'story'];
  // Song pick: the first energetic song in the library, to show the pick beats the clip's mood.
  const library = [...text.matchAll(/^- "(.+?)": ([\w-]+), /gm)].map((m) => ({ name: m[1], mood: m[2] }));
  const song = (library.find((t) => t.mood === 'energetic') || library[0])?.name || 'auto';
  const clips = Array.from({ length: clipCount }, (_, k) => {
    const segments = [];
    videos.forEach((v, vi) => {
      const step = v.dur / 3;
      for (let j = 0; j < 2; j++) {
        const start = Math.min(v.dur - 1, step * j + k * 0.5);
        segments.push({
          video: v.n, start, end: Math.min(v.dur, start + 2.2),
          // 'Transition' is outside the requested label set on purpose: the app must map it, not fail.
          role: segments.length === 0 ? 'hook' : vi === videos.length - 1 && j === 1 ? 'payoff' : j === 1 ? 'Transition' : 'process',
          caption: segments.length === 0 ? '' : `Step ${segments.length} 🔥`,
          speed: j === 1 ? 1.5 : 1, focus_x: 0.4, why: 'Mock: strongest motion in this range.',
          // Loose casing on purpose: the app must normalise these.
          transition: j === 0 ? 'Flash' : 'fade', effect: j === 0 ? 'Zoom-In' : 'none',
          layout: 'full', compare_video: 0, compare_start: 0,
        });
      }
    });
    // A before/after split screen using video 1 as the "before".
    segments.push({ video: videos.at(-1).n, start: 0, end: 2, role: 'payoff', caption: '', speed: 1, focus_x: 0.5, why: 'comparison', transition: 'cut', effect: 'none', layout: 'split', compare_video: 1, compare_start: 0 });
    // An out-of-range segment the server must clamp/drop.
    segments.push({ video: 99, start: 0, end: 3, role: 'process', caption: 'bogus', speed: 1, focus_x: 0.5, why: 'invalid on purpose', transition: 'cut', effect: 'none', layout: 'full', compare_video: 0, compare_start: 0 });
    return {
      title: `Mock clip ${k + 1}`, concept: 'Mock concept', music_mood: 'chill', style: assigned[k] || own[k % own.length],
      angle: ['Transformation reveal', 'Satisfying process', 'Offer', 'Behind the scenes'][k % 4],
      target_viewer: 'Locals who want their car looking new', why_it_works: 'Mock: the reveal pays off the hook.',
      hook_text: 'Watch this transformation 😮', hook_reason: 'Mock reason',
      segments, cta_text: 'Book today', pacing_notes: 'Fast', music_track: song,
      post_caption: 'Mock caption ✨', hashtags: ['#mock', '#test'],
    };
  });
  return {
    strategy: 'Mock strategy: lead with the reveal, then build trust with the process.',
    summary: `Mock plan over ${videos.length} videos.`,
    footage_review: videos.map((v) => ({ video: v.n, start: 0, end: Math.min(2, v.dur), description: 'Opening shot', quality: 'Excellent / strong' })),
    clips,
    cut_sections: [{ video: 1, start: 0, end: 0.5, reason: 'Camera wobble' }],
    reshoot_tips: ['Hold the phone steady.'],
  };
}

// Change request: echo every clip back, changing only the one asked about.
function revisionFor(text) {
  const current = JSON.parse(text.match(/THE CURRENT CLIPS \(video numbers are 1-based\):\n([\s\S]+?)\n\nTHE CREATOR'S REQUEST/)[1]);
  const focus = Number(text.match(/THE CREATOR'S REQUEST \(about clip (\d+)\)/)?.[1] || 1);
  const request = text.match(/THE CREATOR'S REQUEST[^\n]*:\n"([\s\S]*?)"\n/)[1];
  const clips = current.map((c) => {
    const changed = c.clip_number === focus;
    return {
      clip_number: c.clip_number, changed, title: c.title, style: c.style, angle: c.angle || 'Offer',
      target_viewer: 'Locals', why_it_works: 'Mock', music_mood: 'energetic', concept: 'Mock', hook_reason: 'Mock',
      hook_text: changed ? 'Revised by the AI' : c.hook_text, cta_text: c.cta_text,
      segments: (changed ? c.segments.slice(0, 3) : c.segments).map((sg) => ({ ...sg, why: 'Mock' })), pacing_notes: '', post_caption: 'Mock', hashtags: [],
      target_seconds: changed ? 12 : c.length_seconds,
      music_track: changed && /no music/i.test(request) ? 'none' : 'keep',
    };
  });
  return { reply: `Mock: changed clip ${focus} for "${request}".`, clips };
}

// Ad storyboards (motion engine v3). Loose labels on purpose: the app must normalise them.
function boardsFor(text) {
  const count = Number(text.match(/DELIVERABLE: (\d+) ad/)?.[1] || 1);
  const seconds = Number(text.match(/each (\d+) seconds/)?.[1] || 15);
  const photos = [...text.matchAll(/Photo "([^"]+)"( \(cut-out available\))?/g)].map((m) => ({ id: m[1], cut: Boolean(m[2]) }));
  const footage = [...text.matchAll(/Footage "([^"]+)"/g)].map((m) => m[1]);
  const library = [...text.matchAll(/^- "(.+?)": ([\w-]+), /gm)].map((m) => ({ name: m[1], mood: m[2] }));
  const song = (library.find((t) => t.mood === 'energetic') || library[0])?.name || 'auto';
  const p = (i) => photos[i % Math.max(1, photos.length)]?.id || '';
  const ads = Array.from({ length: count }, (_, k) => ({
    title: `Mock ad ${k + 1}`, angle: k ? 'Trust' : 'Product showcase', objective: k ? 'Trust' : 'showcase', why_it_works: 'Mock: the product leads.',
    direction: k ? 'Luxury' : 'premium', brand_colors: ['#C0392B', 'nonsense'], music_track: song, music_mood: 'energetic',
    voiceover_script: /VOICEOVER/.test(text) ? 'Fresh coffee, made properly. Visit us today.' : '',
    scenes: [
      { recipe: 'Product Hero', purpose: 'Hook with the product', duration: 3, headline: 'Your morning, *perfected* 🔥', subline: 'Mock', items: [], main_asset: p(0), other_assets: [], video: '', video_from: 0, camera: 'Push', entrance: 'Drop', text_animation: 'words', transition: '' },
      { recipe: 'photo_full', purpose: 'Desire', duration: 3, headline: 'Made fresh daily', subline: '', items: [], main_asset: 'missing-photo', other_assets: [], video: '', video_from: 0, camera: '', entrance: '', text_animation: '', transition: 'Whip' },
      ...(footage.length ? [{ recipe: 'footage', purpose: 'Real process', duration: 3, headline: 'Watch it happen', subline: '', items: [], main_asset: '', other_assets: [], video: footage[0], video_from: 1, camera: '', entrance: '', text_animation: '', transition: 'zoom' }] : []),
      { recipe: 'features', purpose: 'Value', duration: 3, headline: 'Why locals come back', subline: '', items: ['Roasted on site', 'Open early', 'Oat milk free'], main_asset: p(1), other_assets: [], video: '', video_from: 0, camera: '', entrance: '', text_animation: '', transition: '' },
      { recipe: 'cta', purpose: 'Action', duration: 3, headline: 'Visit *us* today', subline: 'Newtown', items: ['Order ahead'], main_asset: '', other_assets: [], video: '', video_from: 0, camera: '', entrance: '', text_animation: '', transition: '' },
    ],
    post_caption: 'Mock caption ✨', hashtags: ['mock', '#ads'],
  }));
  return { strategy: 'Mock strategy: lead with the product.', photo_notes: photos.map((x) => ({ asset: x.id, description: 'a test photo', best_use: 'supporting' })), ads };
}

function boardRevisionFor(text) {
  const current = JSON.parse(text.match(/THE CURRENT ADS:\n([\s\S]+?)\n\nTHE CREATOR'S REQUEST/)[1]);
  const focus = Number(text.match(/THE CREATOR'S REQUEST \(about ad (\d+)/)?.[1] || 1);
  const scene = Number(text.match(/, scene (\d+)\)/)?.[1] || 1);
  const request = text.match(/THE CREATOR'S REQUEST[^\n]*:\n"([\s\S]*?)"\n/)[1];
  const ads = current.map((a) => {
    const changed = a.ad_number === focus;
    const scenes = a.scenes.map((s, i) => (changed && i === scene - 1 ? { ...s, headline: 'Revised by the AI' } : s));
    return { ...a, changed, scenes, music_track: changed && /no music/i.test(request) ? 'none' : 'keep' };
  });
  return { reply: `Mock: changed ad ${focus}.`, ads };
}

function reviewFor(text) {
  const n = [...text.matchAll(/^Scene (\d+):/gm)].length;
  return { verdict: 'fix', summary: 'Mock review.', scenes: Array.from({ length: n }, (_, i) => ({ scene: i + 1, ok: i !== 1, problem: i === 1 ? 'Headline is generic' : '', fix_headline: i === 1 ? 'Reviewed headline' : '', fix_recipe: '', fix_asset: '' })) };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Client reply classification: a keyword stand-in for Claude's judgement.
function replyFor(text) {
  const t = (text.split('"""')[1] || text).toLowerCase();
  if (/don.t want|not interested|won.t be going ahead|no thanks/.test(t)) return { intent: 'declined', confidence: 0.95, summary: 'The client does not want to go ahead.', requested_changes: [], decline_reason: 'Changed their mind' };
  if (/change|swap|more|instead|could you|can you/.test(t)) return { intent: 'revision', confidence: 0.92, summary: 'The client wants changes.', requested_changes: ['As described in their email'], decline_reason: '' };
  if (/love it|perfect|looks great/.test(t)) return { intent: 'accepted', confidence: 0.9, summary: 'The client is happy.', requested_changes: [], decline_reason: '' };
  return { intent: 'unclear', confidence: 0.4, summary: 'Hard to tell.', requested_changes: [], decline_reason: '' };
}

export function startMock(port = 4555, { rejectFallbacks = false } = {}) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      // Key check (Settings page): the model lookup succeeds unless the key is "bad-key".
      const m = req.url.match(/^\/v1\/models\/([\w.-]+)/);
      if (req.method === 'GET' && m) {
        if (req.headers['x-api-key'] === 'sk-ant-bad-key') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'model', id: m[1], display_name: m[1], created_at: '2026-01-01T00:00:00Z' }));
      }
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
      }
      const body = JSON.parse(raw);
      requests.push({ headers: req.headers, body });

      if (rejectFallbacks && body.fallbacks) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not supported for this account' } }));
      }

      const props = Object.keys(body.output_config?.format?.schema?.properties || {});
      const text = body.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const out = props.includes('intent') ? replyFor(text)
        : props.includes('verdict') ? reviewFor(text)
        : props.includes('photo_notes') ? boardsFor(text)
        : props.includes('reply') ? (props.includes('ads') ? boardRevisionFor(text) : revisionFor(text))
        : planFor(text);
      const json = JSON.stringify(out);

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' });
      sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (let i = 0; i < json.length; i += 400) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json.slice(i, i + 400) } });
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 500 } });
      sse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 4555);
  await startMock(port);
  console.log(`Mock Anthropic API on http://127.0.0.1:${port}`);
}
