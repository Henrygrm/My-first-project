# Cutline: audit and technical roadmap

Written at the start of the "master project" (v2.1.0 → v3). Progress is tracked in `docs/PROGRESS.md`.

## 1. What exists today (v2.1.0)

| Area | How it works now |
|---|---|
| Server | One Node 22 / Express 5 process, bound to 127.0.0.1. ~7,600 lines, no build step. |
| Storage | No database: one folder per project with `project.json` (atomic write + per-project lock), footage, renders. Music library in `data/music`. Keys in `.env`. |
| Jobs | In-memory queue, one job at a time, polled by the browser. Lost if the server restarts. |
| Clip editor (Home) | FFmpeg filter graphs cut real footage: motion/audio/brightness analysis, Claude or heuristic edit lists, beat-synced cuts, transitions, grades, PNG text overlays, loudness to -14 LUFS. |
| Ads | `adRender.js`: a canvas renderer with 7 fixed scene layouts (hook, photo, features, offer, stat, review, cta), 6 hard-coded themes, one font family, 5 transitions, piped to FFmpeg. Claude writes a storyboard of those 7 scene types. |
| AI | Claude via structured outputs (Zod), server-side refusal fallback. Optional Whisper for speech subtitles. |
| UI | Single-page app (HTML + 1,200-line `app.js`): Home, Ads, Music, Settings. |
| Tests | End-to-end smoke test (20 checks) against a mock Claude API, with real FFmpeg renders. |

## 2. Audit findings

### Works well (keep)
- The footage pipeline: beat detection, beat-synced cuts, length fitting, loudness, hardware decode fallback. Tested across 3 FFmpeg builds.
- Structured AI output with server-side validation ("never trust the model's labels").
- Honest failure behaviour: setup errors instead of fake results; tests cover it.
- Simple, local, no database. Fine for one operator; keep files but organise them better.

### Limits video quality (the main problem)
1. **Ads are text-first by construction.** Scene types are text layouts; photos are only ever a full-screen background. There is no way to make a product the hero: no cutouts, no layers, no placement, no depth.
2. **One renderer function per scene type.** Every ad of a type looks the same. Adding variety means adding more hard-coded functions.
3. **No keyframes, layers, camera or depth.** Animation is a handful of entrance presets (pop, slide, words, typewriter, zoom).
4. **Fixed palettes.** Six themes, with Bold (orange on black) the default and the most common. No colours taken from the client's logo or photos.
5. **One typeface (Inter).** Typography can't express luxury, editorial, industrial and so on.
6. **No sound design.** Music only; no whooshes, impacts or risers on transitions.
7. **Ads can't use the client's video footage**, only stills.

### Limits creative flexibility and workflow
- No timeline or scene inspector; editing an ad means a full re-render to see anything.
- Can't regenerate one scene; the change bar re-plans whole ads.
- No clients or brand kits: business details and logo are re-entered per project.
- No version history; re-rendering overwrites.
- Jobs vanish on restart; no logs; no retries for API calls.

### Reliability and security
- **Cross-site request gap (fix first):** any website open in the same browser can send simple POST requests to `127.0.0.1:3000` and start jobs (including paid Claude calls) or upload files. Needs an Origin/Host check on every state-changing request.
- Ad rendering runs on the main thread (frames are drawn synchronously); a long render slows API responses. Move it to a worker thread.
- No backup of project data; no rotating log file.

## 3. Technology evaluation

| Technology | Verdict | Reason |
|---|---|---|
| **Remotion** (React video) | **Not adopted now** | Great tool, but it means rendering through headless Chrome (an extra ~100 MB browser download on the Mac), a React/bundler toolchain and a rewrite of everything. Free licence covers individuals/≤3-person companies ([licence](https://www.remotion.dev/docs/license)). The two things it would give us, layered composition and a live browser preview, can be had with far less weight (below). Revisit if Lottie/3D become essential. |
| **Own canvas motion engine** (Skia via `@napi-rs/canvas`) | **Adopted: rebuild the ad engine on it** | Already installed, fast, supports blur/colour filters, blend modes, masks, shadows, gradients, letter spacing (verified). Written as an *isomorphic* module so the same code renders final frames in Node and plays a live preview in the browser's `<canvas>`. |
| **FFmpeg** | **Keep** | Encoding, decoding client footage into ad scenes, audio mixing, loudness, QA analysis (blackdetect, freezedetect, ebur128). |
| **Three.js** | **Not adopted** | Needs WebGL, which the Node renderer doesn't have. Real 3D also needs 3D models of the client's actual products, which don't exist. 2.5D (layered cutouts with depth, perspective tilts, parallax, light sweeps, shadows) gives the "product hero" look from real photos. |
| **Lottie** | **Deferred** | Rendering in Node needs a DOM shim; also needs licensed animation files. Vector icons and effects are drawn natively by the engine instead. |
| **Background removal** | **Adopted, local and free** | ISNet/U²-Net ONNX model run locally with `onnxruntime-node`. No per-image cost, client photos never leave the computer. Paid APIs (Photoroom ≈$0.02/image, remove.bg ≈$0.20) are not needed. |
| **AI image generation** | **Optional, needs approval** | For supporting visuals only (backgrounds, generic ingredients), never to fake a client's product. OpenAI GPT Image ≈ $0.01–0.17 per image depending on quality ([prices](https://pricepertoken.com/gpt-image-pricing)). |
| **AI video generation** | **Optional, needs approval** | Kling via fal ≈ $0.07–0.24 per generated second ([prices](https://www.costbench.com/compare/fal-ai-vs-kling-api/)), so $0.35–1.20 per 5-second shot. Useful for animating a client photo; expensive to use liberally. |
| **Voiceover** | **Optional, needs approval** | OpenAI gpt-4o-mini-tts ≈ $0.015 per minute of audio ([pricing](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts)), so about 1 cent per ad. |
| **Sound effects** | **Adopted, free** | Synthesised by FFmpeg (whooshes, impacts, risers, pops, shimmers). No licensing questions. |
| **Fonts** | **Adopted, free** | A curated set of Google Fonts (SIL Open Font License), bundled with their licences. |

All paid services go behind a provider interface (`server/providers/`) with a cost estimate per call, off until approved and configured.

**Owner decisions (2026-10-31):** approved: Claude photo analysis + rendered-frame review (existing Claude key), OpenAI voiceover. Not approved for now: AI image generation, AI video generation (the provider slots exist so they can be added later without restructuring).

## 4. Roadmap (in order)

### Phase A: Foundations
1. Security: Origin/Host check on all state-changing requests.
2. Persistent jobs: job records + logs on disk, recovery after restart ("interrupted, resume?"), retries with backoff for API calls.
3. Ad rendering in a worker thread.
4. Clients and brand kits: client profile (business details, logo, colours, fonts, style, media library), projects belong to a client, a returning client needs nothing re-entered.
5. Versions: every ad render is kept as a version with its storyboard; restore, compare and duplicate.

### Phase B: Motion engine v3 (replaces `adRender.js`)
- Scene graph: layers (image, cutout, video, text, shape, gradient, particles, light, logo), each with keyframed transform/opacity/blur/colour and named easing curves.
- 2.5D camera: per-layer depth, which gives parallax, push-ins, orbits and dolly moves.
- Masks (shape, wipe, iris, text-as-mask), blend modes, drop and contact shadows, glows, light sweeps over the product, motion blur on fast moves (sub-frame sampling), film grain, vignette, colour grading.
- Kinetic typography system with per-word/per-letter animation and font-aware layout.
- Particles: steam, dust, sparkles, water droplets, bubbles, confetti, embers.
- Transitions: whip pan with motion blur, zoom-through, push, mask wipe, light flash, match-cut on the product, dissolve.
- Isomorphic: the same code powers the browser preview.

### Phase C: Asset intelligence
- Local background removal → transparent cutouts, masks and subject boxes.
- Image analysis: resolution, sharpness, brightness, dominant colours, subject position.
- Claude vision tags per photo: what it shows (product/process/place/people), quality, best use.
- Client footage as ad scene sources (moving backgrounds and clips).

### Phase D: Brand engine
- Palette extraction from logo and photos, roles (background, surface, primary, accent, text) with contrast checks.
- Ten creative directions (cinematic, luxury, minimalist, futuristic, energetic, editorial, modern commercial, playful, premium, industrial). Each defines type pairing, motion personality, backgrounds, transitions, grade, particles and sound palette. Combined with the brand colours, never a fixed theme.

### Phase E: Creative director v2
- Brief analysis → creative direction → storyboard of *composition recipes* (product hero, ingredient burst, before/after, footage + kinetic caption, offer burst, review card, logo sting, process sequence and so on), each with purpose, subject, assets, composition, camera, animation, text, sound and transition.
- Compiles to the scene graph; validated; free-mode director chooses recipes with real variety.
- Contact-sheet self-review: render keyframes, Claude looks at them and fixes weak scenes (optional, small cost).
- Regenerate one scene in context.

### Phase F: Audio
- Event-driven sound design: SFX on transitions, reveals and text hits; risers into reveals.
- Music beat grid drives scene cuts (already) and animation accents.
- Voiceover provider (pending approval) with ducking.

### Phase G: Studio editor and UI redesign
- Ad studio: scene timeline (drag to reorder, resize duration), scene inspector (text, font, colours, animation, camera, transition, asset swap), live preview in the browser, regenerate scene, versions.
- Clients page; consistent, more refined visual design across the app.

### Phase H: Quality control
- Automatic checks on every render: resolution/fps/codec/duration, black or frozen frames, loudness/true peak/clipping, text inside platform safe zones, text contrast against what's actually behind it, upscaled (blurry) assets, repeated scenes/transitions, logo and brand colours present. Auto-fix where possible; otherwise a clear report with fixes.

### Phase I: Export presets
- TikTok, Reels, Shorts and Facebook Reels (1080×1920, 30 fps, H.264 High, AAC 48 kHz, -14 LUFS), plus 1:1, 4:5 and 16:9; per-platform safe zones.

### Phase J: Validation
- Real renders for café, restaurant, barber, car detailing and trades; inspect frames; fix weaknesses. Edge cases: missing assets, bad images, failed APIs, interrupted jobs.

## 5. Additional features, ranked by value
1. **Brand kits per client.** Biggest time saver for repeat work.
2. **Live preview + per-scene regeneration.** Fix one weak scene in seconds.
3. **AI contact-sheet review.** Catches ugly scenes before the client does.
4. **Hook variations.** Same ad, 3 different openings, re-rendering only the first scene (A/B testing for clients).
5. **Content packs.** Several ads for one client in one run (offer, trust, showcase).
6. **Version history and duplication.** Safe experimentation and revisions.
7. **Cover/thumbnail export.** Platforms show it before playback.
8. **QA report attached to each delivery.**
Not worth it now: user accounts/logins (single-operator local app), cloud rendering, a full NLE.

## 6. Known limitations (honest)
- No true 3D models; 2.5D compositing from real photos instead.
- AI video, AI images and voiceover cost money per use and need approval plus API keys.
- Best results need real client photos. With none, ads fall back to footage stills, brand graphics and (if approved) generated supporting imagery.
- This build environment can't reach stock-photo sites, so testing uses the limited openly licensed images reachable from GitHub plus generated test media.
