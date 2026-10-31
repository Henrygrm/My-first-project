# Progress log

Read `docs/ROADMAP.md` first: it holds the audit, technology decisions and the plan.

## Status (paused 2026-10-31, at the owner's request)

### Done
- Audit + roadmap (`docs/ROADMAP.md`), including technology evaluation and costs.
- Owner approved paid extras: Claude photo analysis/frame review, OpenAI voiceover. Declined for now: AI image and AI video generation.
- **Security:** requests from other websites and non-local Host headers are refused (`server/index.js`, top middleware).
- **Jobs survive restarts:** job records + logs saved in `data/jobs/`. Jobs running when Cutline stopped are marked "interrupted". `POST /api/jobs/:id/retry` re-runs a failed/interrupted job with the same arguments (job kinds registered in `RUNNERS` in `server/index.js`). `GET /api/projects/:id` returns `lastJob`.
- **Backups:** each project save keeps the previous one as `project.prev.json`; a damaged `project.json` falls back to it.
- **Log file:** `data/logs/cutline.log` (rotates at 5 MB) via `server/lib/log.js`.

### Next (task list order)
1. Frontend for jobs: "Try again" button on failed/interrupted jobs (use `lastJob` + retry endpoint); show log file path in Settings (`LOG_PATH` is imported in index.js but not yet exposed).
2. Ad rendering in a worker thread.
3. Motion engine v3 (isomorphic scene graph) — see roadmap phase B.
4. Asset intelligence (local background removal with onnxruntime-node + rembg ISNet/U²-Net models from GitHub releases), brand engine + OFL fonts (from raw.githubusercontent.com/google/fonts), creative director v2, audio/SFX/voiceover, clients + brand kits + versions, studio editor/UI, QA, export presets, 5-industry validation.

### Environment notes for future sessions
- Reachable from the build container: GitHub (raw + releases), npm registry, api.anthropic.com. Not reachable: Hugging Face, Wikimedia, Pexels.
- `@napi-rs/canvas` supports ctx.filter (blur, colour), blend modes, conic gradients, letterSpacing — verified.
- Tests: `npm test` (≈8–10 min in the container). Playwright UI scripts were run ad hoc from the scratchpad.
