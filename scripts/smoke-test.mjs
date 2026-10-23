// End-to-end smoke test: generates sample footage with FFmpeg, starts the app
// against a mock Claude API, and runs the whole workflow through the HTTP API:
// upload → auto-edit → AI edit → re-render → marketing → no-key setup errors.
//
//   npm test
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requests, startMock } from './mock-anthropic.mjs';
import { computeTimeline } from '../server/lib/timeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-test-'));
const MOCK_PORT = 4555;
const children = [];

function log(...a) {
  console.log('  •', ...a);
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);
}

function makeSamples() {
  const a = path.join(TMP, 'landscape kitchen.mp4');
  const b = path.join(TMP, 'portrait.mov');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'mandelbrot=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=12',
    '-filter_complex', '[1:v]trim=0:6,setpts=PTS-STARTPTS[m];[0:v][m]concat=n=2:v=1[v]', '-map', '[v]', '-map', '2:a', '-t', '12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=720x1280:r=30:d=9', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', b]);
  const bad = path.join(TMP, 'notes.mp4');
  return { a, b, bad };
}

async function startServer(port, env) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', PORT: String(port), DATA_DIR: path.join(TMP, `data-${port}`), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/status`);
      return { base: `http://127.0.0.1:${port}`, output: () => out };
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`Server did not start:\n${out}`);
}

async function call(base, p, { method = 'GET', body } = {}) {
  const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function waitJob(base, jobId) {
  for (let i = 0; i < 600; i++) {
    const { data } = await call(base, `/api/jobs/${jobId}`);
    if (data.status === 'done') return data;
    if (data.status === 'error') throw new Error(`Job failed: ${data.error}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Job timed out');
}

function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
}

async function checkClips(base, dataDir, project) {
  assert.ok(project.clips.length > 0, 'clips rendered');
  for (const c of project.clips) {
    const file = path.join(dataDir, 'projects', project.id, 'output', c.file);
    const info = probe(file);
    const v = info.streams.find((s) => s.codec_type === 'video');
    assert.equal(v.width, 1080);
    assert.equal(v.height, 1920);
    assert.ok(info.streams.some((s) => s.codec_type === 'audio'), 'has audio track');
    const dur = Number(info.format.duration);
    assert.ok(Math.abs(dur - c.duration) < 0.6, `duration ${dur} ≈ ${c.duration}`);
    const res = await fetch(`${base}/media/${project.id}/output/${c.file}`, { headers: { range: 'bytes=0-99' } });
    assert.equal(res.status, 206, 'media supports range requests');
    const srt = await fs.readFile(path.join(dataDir, 'projects', project.id, 'output', c.srt), 'utf8');
    assert.match(srt, /-->/);
  }
}

async function main() {
  console.log('\nCutline smoke test\n');
  const { a, b, bad } = makeSamples();
  await fs.writeFile(bad, 'this is not a video');
  await startMock(MOCK_PORT);

  // --- with a (mock) Claude key ------------------------------------------
  const port = 3555;
  const dataDir = path.join(TMP, `data-${port}`);
  const srv = await startServer(port, { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` });
  const base = srv.base;

  const status = (await call(base, '/api/status')).data;
  assert.equal(status.ai.configured, true);
  assert.equal(status.ffmpeg.available, true);
  assert.equal(status.businesses.length, 6);
  log('status ok', status.ai.model, status.ffmpeg.version);

  const html = await (await fetch(base + '/')).text();
  assert.match(html, /Start Creating/);
  log('landing page served');

  const project = (await call(base, '/api/projects', { method: 'POST', body: { name: 'Smoke test' } })).data;
  assert.ok(project.id);

  const form = new FormData();
  for (const f of [a, b, bad]) form.append('videos', new Blob([await fs.readFile(f)]), path.basename(f));
  const up = await (await fetch(`${base}/api/projects/${project.id}/videos`, { method: 'POST', body: form })).json();
  assert.equal(up.added.length, 2, 'two videos added');
  assert.equal(up.failed.length, 1, 'bad file rejected');
  assert.equal(up.added[1].meta.orientation, 'portrait');
  assert.equal(up.added[1].meta.hasAudio, false);
  log('upload ok (2 videos, 1 bad file rejected)');

  // Music library: a 120 BPM test track
  const track = path.join(TMP, 'beat 120.mp3');
  ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*(50+80*exp(-30*mod(t,0.5)))*mod(t,0.5))*exp(-9*mod(t,0.5))+0.15*sin(2*PI*55*t)':s=44100:d=40", '-ac', '2', track]);
  const mform = new FormData();
  mform.append('tracks', new Blob([await fs.readFile(track)]), 'beat 120.mp3');
  mform.append('tracks', new Blob([Buffer.from('not audio')]), 'notes.mp3');
  const mus = await (await fetch(`${base}/api/music`, { method: 'POST', body: mform })).json();
  assert.equal(mus.added.length, 1, JSON.stringify(mus));
  assert.equal(mus.failed.length, 1, 'bad audio rejected');
  assert.ok(Math.abs(mus.added[0].bpm - 120) < 1, `tempo detected: ${mus.added[0].bpm}`);
  const pm = await call(base, `/api/music/${mus.added[0].id}`, { method: 'PATCH', body: { mood: 'chill' } });
  assert.equal(pm.data.mood, 'chill');
  assert.equal((await fetch(`${base}/music-files/${mus.added[0].file}`)).status, 200);
  log(`music library ok (detected ${mus.added[0].bpm} BPM)`);

  // Auto-edit (no AI): three clips, mixed styles, music on the beat
  let job = (await call(base, `/api/projects/${project.id}/generate`, { method: 'POST', body: { business: 'detailing', platform: 'tiktok', mode: 'auto', clipCount: 3, targetSeconds: 15, style: 'mix', music: 'auto' } })).data;
  let t = Date.now();
  await waitJob(base, job.jobId);
  let p = (await call(base, `/api/projects/${project.id}`)).data;
  assert.equal(p.plan.source, 'auto');
  assert.equal(p.plan.clips.length, 3);
  assert.equal(new Set(p.plan.clips.map((c) => c.style)).size, 3, 'each clip has its own style');
  assert.ok(p.plan.clips.every((c) => c.music?.bpm === mus.added[0].bpm), 'music on every clip');
  for (const c of p.plan.clips) {
    const beat = 60 / c.music.bpm;
    for (const it of computeTimeline(c.segments).items.slice(0, -1)) {
      const r = it.visEnd / beat;
      assert.ok(Math.abs(r - Math.round(r)) * beat < 0.01, `${c.style}: cut at ${it.visEnd.toFixed(3)}s is on the beat`);
    }
  }
  await checkClips(base, dataDir, p);
  log(`auto-edit rendered ${p.clips.length} clips (${p.plan.clips.map((c) => c.style).join(', ')}) in ${((Date.now() - t) / 1000).toFixed(1)}s:`, p.clips.map((c) => `${c.duration}s`).join(', '));

  // AI edit via mock Claude
  job = (await call(base, `/api/projects/${project.id}/generate`, { method: 'POST', body: { business: 'restaurant', platform: 'reels', mode: 'ai', clipCount: 2, targetSeconds: 15, instructions: 'Open on the sizzle', reframe: 'fill' } })).data;
  t = Date.now();
  await waitJob(base, job.jobId);
  p = (await call(base, `/api/projects/${project.id}`)).data;
  assert.equal(p.plan.source, 'ai');
  assert.ok(p.plan.clips.every((c) => c.segments.every((s) => s.video >= 0 && s.video < 2)), 'invalid video indexes dropped');
  assert.ok(!p.plan.clips[0].hook_text.includes('😮'), 'emoji stripped from on-screen text');
  const roles = new Set(p.plan.clips.flatMap((c) => c.segments.map((s) => s.role)));
  assert.ok([...roles].every((r) => ['hook', 'setup', 'process', 'reveal', 'payoff', 'cta'].includes(r)), `unexpected labels normalised: ${[...roles]}`);
  assert.ok(p.plan.footage_review.every((r) => r.quality === 'strong'), 'quality label normalised');
  const segsAll = p.plan.clips.flatMap((c) => c.segments);
  assert.ok(segsAll.some((sg) => sg.transition === 'flash') && segsAll.some((sg) => sg.effect === 'zoom_in'), 'transition/effect labels normalised');
  assert.ok(segsAll.some((sg) => sg.layout === 'split' && sg.compare_video === 0), 'split screen kept with 0-based compare video');
  assert.ok(p.plan.clips.every((c) => c.style), 'styles assigned');
  await checkClips(base, dataDir, p);
  const planReq = requests.at(-1);
  const images = planReq.body.messages[0].content.filter((x) => x.type === 'image').length;
  assert.ok(images >= 6, 'frames sent to Claude');
  assert.equal(planReq.body.fallbacks, 'default');
  assert.match(planReq.headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
  assert.equal(planReq.body.output_config.format.type, 'json_schema');
  assert.equal(planReq.body.model, 'claude-opus-5-5');
  log(`AI edit rendered ${p.clips.length} clips in ${((Date.now() - t) / 1000).toFixed(1)}s (${images} frames sent to Claude)`);

  // Edit text + drop a segment, re-render clip 0
  const clip0 = p.plan.clips[0];
  const edited = { hook_text: 'New hook text', cta_text: 'Call now', style: 'promo', music: 'none', segments: clip0.segments.slice(0, 2).map((s) => ({ ...s, caption: 'Edited caption' })) };
  job = (await call(base, `/api/projects/${project.id}/clips/0/render`, { method: 'POST', body: { clip: edited } })).data;
  await waitJob(base, job.jobId);
  const p2 = (await call(base, `/api/projects/${project.id}`)).data;
  assert.equal(p2.plan.clips[0].hook_text, 'New hook text');
  assert.equal(p2.plan.clips[0].segments.length, 2);
  assert.notEqual(p2.clips[0].file, p.clips[0].file, 'new file name after re-render');
  await assert.rejects(fs.access(path.join(dataDir, 'projects', project.id, 'output', p.clips[0].file)), 'old render cleaned up');
  assert.equal(p2.plan.clips[0].style, 'promo');
  assert.equal(p2.plan.clips[0].music, null);
  const srt = await fs.readFile(path.join(dataDir, 'projects', project.id, 'output', p2.clips[0].srt), 'utf8');
  assert.match(srt, /New hook text/);
  log('edit + re-render ok');

  // Marketing
  const profile = { name: 'Gloss Boss', businessType: 'detailing', location: 'Parramatta', services: 'Ceramic coating', audience: 'Car lovers', tone: 'Bold' };
  const mk = await call(base, '/api/marketing', { method: 'POST', body: { profile, projectId: project.id, footageContext: 'clip context' } });
  assert.equal(mk.status, 200, JSON.stringify(mk.data));
  for (const k of ['captions', 'hooks', 'hashtags', 'video_concepts', 'seven_day_plan', 'promotions', 'engagement_tips', 'ctas']) assert.ok(mk.data.data[k], `section ${k}`);
  const regen = await call(base, '/api/marketing', { method: 'POST', body: { profile, section: 'hooks', previous: mk.data.data.hooks, projectId: project.id } });
  assert.deepEqual(Object.keys(regen.data.data), ['hooks']);
  assert.match(requests.at(-1).body.messages[0].content[0].text, /fresh alternatives/);
  const saved = (await call(base, `/api/projects/${project.id}`)).data;
  assert.ok(saved.marketing.data.seven_day_plan.length === 7, 'marketing saved with project');
  log('marketing full + single-section regenerate ok');

  // Project list + delete video marks plan stale
  const list = (await call(base, '/api/projects')).data;
  assert.equal(list[0].id, project.id);
  const del = (await call(base, `/api/projects/${project.id}/videos/${up.added[1].id}`, { method: 'DELETE' })).data;
  assert.equal(del.videos.length, 1);
  assert.equal(del.plan.stale, true);
  assert.equal((await call(base, '/api/projects/..%2F..%2Fetc')).status, 400, 'path traversal rejected');
  log('projects api ok');

  // --- without any key ----------------------------------------------------
  const srv2 = await startServer(3556, { ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}` });
  const st2 = (await call(srv2.base, '/api/status')).data;
  assert.equal(st2.ai.configured, false);
  const mk2 = await call(srv2.base, '/api/marketing', { method: 'POST', body: { profile } });
  assert.equal(mk2.status, 400);
  assert.equal(mk2.data.code, 'SETUP_REQUIRED');
  const p3 = (await call(srv2.base, '/api/projects', { method: 'POST', body: { name: 'No key' } })).data;
  const form2 = new FormData();
  form2.append('videos', new Blob([await fs.readFile(a)]), 'a.mp4');
  await fetch(`${srv2.base}/api/projects/${p3.id}/videos`, { method: 'POST', body: form2 });
  const j2 = (await call(srv2.base, `/api/projects/${p3.id}/generate`, { method: 'POST', body: { mode: 'ai' } })).data;
  await assert.rejects(waitJob(srv2.base, j2.jobId), /ANTHROPIC_API_KEY/);
  log('no-key mode returns clear setup errors (no fake results)');

  // --- API that rejects the fallback beta: app retries without it ----------
  await startMock(MOCK_PORT + 1, { rejectFallbacks: true });
  const srv3 = await startServer(3557, { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT + 1}` });
  const before = requests.length;
  const mk3 = await call(srv3.base, '/api/marketing', { method: 'POST', body: { profile, section: 'ctas' } });
  assert.equal(mk3.status, 200, JSON.stringify(mk3.data));
  assert.equal(requests.length - before, 2, 'retried once');
  assert.equal(requests.at(-1).body.fallbacks, undefined);
  log('falls back to a plain request when the fallback beta is rejected');

  console.log('\n  All checks passed ✔\n');
}

try {
  await main();
} catch (err) {
  console.error('\n  ✘', err.stack || err.message);
  for (const c of children) c.kill();
  process.exitCode = 1;
} finally {
  for (const c of children) c.kill();
  await fs.rm(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 100);
}
