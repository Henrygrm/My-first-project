// Edge cases: no media, odd formats, corrupt files, bad requests, interrupted
// jobs (server killed mid-render), unreachable AI.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
// Run with: npm run test:edge (takes a few minutes; makes no paid API calls)
const S = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-edge-'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = S + '/edgedata';
const PORT = 3797, B = `http://127.0.0.1:${PORT}`;
const results = [];
const ok = (cond, msg) => { results.push(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
let child;
async function start(env = {}) {
  child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, CUTLINE_CUTOUT_MODEL: 'u2netp', CUTLINE_MODEL_DIR: process.env.CUTLINE_MODEL_DIR || path.join(S, 'models'), ENV_FILE: S + '/none.env', ANTHROPIC_API_KEY: '', ...env }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(B + '/api/status'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
}
const j = async (p, o = {}) => { const r = await fetch(B + p, { method: o.method || 'GET', headers: o.body ? { 'content-type': 'application/json' } : {}, body: o.body ? JSON.stringify(o.body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };
const wait = async (id) => { for (;;) { const d = (await j('/api/jobs/' + id)).data; if (['done', 'error', 'interrupted'].includes(d?.status)) return d; await new Promise((r) => setTimeout(r, 600)); } };

await fs.rm(DATA, { recursive: true, force: true });
await start();
const profile = { name: 'Edge Café', services: 'coffee, cake', location: 'Glebe' };

// 1. No photos, no logo, no music: still makes ads.
let p = (await j('/api/projects', { method: 'POST', body: { name: 'empty' } })).data;
let g = (await j(`/api/projects/${p.id}/ads/generate`, { method: 'POST', body: { mode: 'auto', business: 'cafe', profile, count: 1, seconds: 10, music: 'auto' } })).data;
let d = await wait(g.jobId);
let pr = (await j(`/api/projects/${p.id}`)).data;
ok(d.status === 'done' && pr.adRenders?.[0]?.file, `no photos/logo/music: ad rendered (${d.status}${d.error ? ': ' + d.error : ''})`);
ok(pr.adPlan?.musicNote?.includes('music library is empty'), 'empty music library explained');

// 2. Unusual image formats and a corrupt file.
const img = S + '/edgeimg';
await fs.mkdir(img, { recursive: true });
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=900x700', '-frames:v', '1', img + '/a.webp']);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=600x400', '-frames:v', '1', img + '/b.gif']);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480', '-frames:v', '1', '-pix_fmt', 'bgr24', img + '/c.bmp']);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480', '-frames:v', '1', img + '/d.tiff']);
await fs.writeFile(img + '/broken.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200, 7)]));
const f = new FormData();
for (const n of ['a.webp', 'b.gif', 'c.bmp', 'd.tiff', 'broken.png']) f.append('images', new Blob([await fs.readFile(img + '/' + n)]), n);
const up = await (await fetch(`${B}/api/projects/${p.id}/ad-assets`, { method: 'POST', body: f })).json();
ok(up.added?.length === 4, `WebP, GIF, BMP, TIFF converted (${up.added?.length})`);
ok(up.failed?.length === 1 && /JPG or PNG/.test(up.failed[0].error), 'corrupt image rejected with a clear message');
const txt = new FormData();
txt.append('images', new Blob(['hello']), 'notes.txt');
const r2 = await fetch(`${B}/api/projects/${p.id}/ad-assets`, { method: 'POST', body: txt });
ok(r2.status === 400, 'non-image file refused');

// 3. Bad requests.
ok((await j(`/api/projects/${p.id}/ads/9/render`, { method: 'POST', body: { board: {} } })).status === 404, 'unknown ad → 404');
ok((await j(`/api/projects/${p.id}/ads/0/scenes/99/regenerate`, { method: 'POST', body: {} })).status === 404, 'unknown scene → 404');
ok((await j(`/api/projects/${p.id}/ads/0/restore`, { method: 'POST', body: { file: 'nope.mp4' } })).status === 404, 'unknown version → 404');
ok((await j('/api/projects/..%2Fetc/ads/0/kit')).status === 400, 'path traversal refused');
ok((await j('/api/clients/..%2F..%2Fetc')).status === 400, 'client path traversal refused');
const bad = await fetch(`${B}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
ok(bad.status === 400, `malformed JSON → 400 (got ${bad.status})`);
// Studio save with junk values is cleaned up, not crashed.
g = (await j(`/api/projects/${p.id}/ads/0/render`, { method: 'POST', body: { board: { direction: 'nonsense', scenes: [{ recipe: 'zzz', headline: 'x'.repeat(500), duration: 999, main: 'not-a-photo' }] } } })).data;
d = await wait(g.jobId);
pr = (await j(`/api/projects/${p.id}`)).data;
ok(d.status === 'done' && pr.adPlan.ads[0].scenes[0].headline.length <= 90 && pr.adPlan.ads[0].scenes.at(-1).recipe === 'cta', 'junk studio input sanitised and rendered');

// 4. Interrupted job: kill the server mid-render, restart, retry.
g = (await j(`/api/projects/${p.id}/ads/generate`, { method: 'POST', body: { mode: 'auto', business: 'cafe', profile, count: 2, seconds: 30 } })).data;
for (let i = 0; i < 60; i++) { const s = (await j('/api/jobs/' + g.jobId)).data; if (s.status === 'running' && s.progress > 0.45) break; await new Promise((r) => setTimeout(r, 500)); }
child.kill('SIGKILL');
await new Promise((r) => setTimeout(r, 500));
await start();
const after = (await j('/api/jobs/' + g.jobId)).data;
ok(after?.status === 'interrupted', `job after restart: ${after?.status}`);
pr = (await j(`/api/projects/${p.id}`)).data;
ok(pr.lastJob?.status === 'interrupted', 'project reports the interrupted job');
ok(Boolean(pr.adPlan), 'project data intact after a hard kill');
const re = (await j(`/api/jobs/${g.jobId}/retry`, { method: 'POST' })).data;
d = await wait(re.jobId);
pr = (await j(`/api/projects/${p.id}`)).data;
ok(d.status === 'done' && pr.adRenders.filter(Boolean).length === 2, `retry finished the job (${d.status}${d.error ? ': ' + d.error : ''})`);
const leftovers = (await fs.readdir(`${DATA}/projects/${p.id}/ad-output`)).filter((n) => n.startsWith('.'));
ok(leftovers.length === 0, `no half-written temp folders left (${leftovers.join(',')})`);
child.kill();

// 5. Claude unreachable: clear error, no fake result.
await start({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
g = (await j(`/api/projects/${p.id}/ads/generate`, { method: 'POST', body: { mode: 'ai', business: 'cafe', profile, count: 1, seconds: 10 } })).data;
d = await wait(g.jobId);
ok(d.status === 'error' && /reach Claude|connection/i.test(d.error), `AI unreachable → "${d.error}"`);
pr = (await j(`/api/projects/${p.id}`)).data;
ok(pr.adRenders.filter(Boolean).length === 2, 'previous ads kept after a failed AI run');
child.kill();
console.log(results.join('\n'));
process.exit(results.some((x) => x.startsWith('FAIL')) ? 1 : 0);
