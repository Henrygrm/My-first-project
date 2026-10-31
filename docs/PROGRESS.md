# Progress log

Read `docs/ROADMAP.md` first (audit, technology decisions, plan). This file records what is done and what is next, so a new session can continue.

## Status: v3.0.0 (2026-10-31)

### Done
- **Foundations:** cross-site/Host request guard; persistent job records with logs, interrupted-job detection and retry (`RUNNERS` registry in `server/index.js`); `project.prev.json` backups; `data/logs/cutline.log`; "Try again" in the UI.
- **Motion engine v3** (`public/engine/`, isomorphic: Node renders, browser previews):
  - `core.js`: easing/springs/keyframes, colour and contrast, text layout.
  - `effects.js`: particles, light, grain, shapes, icons.
  - `compositor.js`: layers, camera/parallax, masks, motion blur, transitions, finishing; cached blurs and shadows.
  - `styles.js`: 10 creative directions. `brand.js`: palettes from brand colours.
  - `recipes.js`: 13 product-first scene recipes. `compose.js`: storyboard → composition, beat-snapped timing, transitions, SFX cues. `fonts.js`: 20 OFL families.
- **Renderer** (`server/lib/engine/`):
  - Parallel worker threads (`worker.js`), FFmpeg grade/grain, client footage decoding (`video.js`).
  - Synthesised SFX (`sfx.js`); audio mix with ducking and loudness (`render.js`).
- **Media:** local background removal (`server/lib/cutout.js`, ISNet via optional `onnxruntime-node`; model downloads to `data/models`); photo/logo analysis (`analyze.js`).
- **Director** (`server/lib/director.js` + `ai.js`): Claude storyboards with validation and lenient label normalisation; free-mode concepts that use only facts the business supplied; Claude pre-render frame review; change requests per ad/scene; scene regeneration.
- **Ads pipeline** (`server/lib/ads.js`): media prep, music choice, voiceover (`server/providers/tts.js`, OpenAI, approved), render, QA, versions (max 6 per ad), restore, studio saves, preview kit.
- **QA** (`server/lib/qa.js`): checks the real MP4 (streams, black/frozen, loudness/peak, safe zones, pixel contrast under text, photo resolution, pacing, branding).
- **Clients** (`server/lib/clients.js`): brand kits, logo-derived colours, media library, new project per client, duplicate project.
- **UI:** Ads page, Studio (live preview, timeline, inspector, versions), Clients page, Settings services list, phone layout fixes.
- **Business profiles:** café added (7 types).
- **Tests:** `npm test` covers all of the above against the mock Claude API (`scripts/mock-anthropic.mjs`).

### Owner decisions
- Approved: Claude photo analysis and frame review; OpenAI voiceover.
- Not approved: AI image and video generation. Provider slots exist in `server/providers/index.js`.

### Known limitations / next ideas (ranked)
1. Test the real Claude director with the owner's key, then tune prompts on real output.
2. Hook variations: 3 alternative openings per ad, re-rendering only scene 1.
3. Content packs: several objectives for one client in one run.
4. Lottie or extra vector animation packs (needs licensed files).
5. Apply brand fonts and colours to the Home clip editor's text overlays (it still uses the v2 text themes).
6. A real 3D path would need WebGL rendering (headless browser) and real product models.

### Environment notes for future sessions
- Reachable from the build container: GitHub (raw and releases), npm registry, api.anthropic.com. Not reachable: Hugging Face, Wikimedia, Pexels.
- Tests run with `CUTLINE_CUTOUT_MODEL=u2netp` (4.5 MB). The app defaults to ISNet (178 MB).
- In shell scripts, kill test servers with `pkill -f '^node server/index.js'`: an unanchored pattern also matches the shell running it.
