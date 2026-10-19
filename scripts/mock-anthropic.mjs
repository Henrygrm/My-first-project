// A tiny stand-in for the Anthropic Messages API, used by the smoke test so
// the full AI workflow can be exercised without an API key or spending credits.
// It streams responses in the real SSE wire format and returns schema-shaped
// JSON for edit plans and marketing requests.
//
//   node scripts/mock-anthropic.mjs 4555
//   ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4555 npm start
import http from 'node:http';

export const requests = [];

function planFor(text) {
  const videos = [...text.matchAll(/=== VIDEO (\d+): ".+?" — duration ([\d.]+)s/g)].map((m) => ({ n: Number(m[1]), dur: Number(m[2]) }));
  const clipCount = Number(text.match(/DELIVERABLE: (\d+) clip/)?.[1] || 1);
  const clips = Array.from({ length: clipCount }, (_, k) => {
    const segments = [];
    videos.forEach((v, vi) => {
      const step = v.dur / 3;
      for (let j = 0; j < 2; j++) {
        const start = Math.min(v.dur - 1, step * j + k * 0.5);
        segments.push({
          video: v.n, start, end: Math.min(v.dur, start + 2.2),
          role: segments.length === 0 ? 'hook' : vi === videos.length - 1 && j === 1 ? 'payoff' : 'process',
          caption: segments.length === 0 ? '' : `Step ${segments.length} 🔥`,
          speed: j === 1 ? 1.5 : 1, focus_x: 0.4, why: 'Mock: strongest motion in this range.',
        });
      }
    });
    // An out-of-range segment the server must clamp/drop.
    segments.push({ video: 99, start: 0, end: 3, role: 'process', caption: 'bogus', speed: 1, focus_x: 0.5, why: 'invalid on purpose' });
    return {
      title: `Mock clip ${k + 1}`, concept: 'Mock concept', hook_text: 'Watch this transformation 😮', hook_reason: 'Mock reason',
      segments, cta_text: 'Book today', pacing_notes: 'Fast', music_suggestion: 'Upbeat trending audio',
      post_caption: 'Mock caption ✨', hashtags: ['#mock', '#test'],
    };
  });
  return {
    summary: `Mock plan over ${videos.length} videos.`,
    footage_review: videos.map((v) => ({ video: v.n, start: 0, end: Math.min(2, v.dur), description: 'Opening shot', quality: 'usable' })),
    clips,
    cut_sections: [{ video: 1, start: 0, end: 0.5, reason: 'Camera wobble' }],
    reshoot_tips: ['Hold the phone steady.'],
  };
}

const MARKETING = {
  captions: Array.from({ length: 5 }, (_, i) => ({ style: ['Story', 'Short', 'Educational', 'Offer', 'Behind the scenes'][i], text: `Mock caption ${i + 1} ✨\nLine two.` })),
  hooks: Array.from({ length: 8 }, (_, i) => `Mock hook ${i + 1}`),
  hashtags: { broad: ['#local', '#smallbusiness'], niche: ['#detailing', 'ceramiccoating'], local: ['#parramatta'] },
  video_concepts: Array.from({ length: 4 }, (_, i) => ({ title: `Concept ${i + 1}`, hook: 'Hook', description: 'Description', shot_list: ['Shot A', 'Shot B'] })),
  seven_day_plan: Array.from({ length: 7 }, (_, i) => ({ day: `Day ${i + 1}`, theme: 'Theme', format: 'Reel', idea: 'Idea', caption_starter: 'Starter…' })),
  promotions: Array.from({ length: 3 }, (_, i) => ({ title: `Promo ${i + 1}`, offer: '10% off', post_copy: 'Copy' })),
  engagement_tips: Array.from({ length: 6 }, (_, i) => `Tip ${i + 1}`),
  ctas: Array.from({ length: 6 }, (_, i) => `CTA ${i + 1}`),
};

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function startMock(port = 4555, { rejectFallbacks = false } = {}) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
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
      const out = props.includes('clips') ? planFor(text) : Object.fromEntries(props.map((k) => [k, MARKETING[k]]));
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
