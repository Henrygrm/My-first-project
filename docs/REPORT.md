# Cutline v4: client workflow platform (latest)

## What was built

- **Client Onboarding:** connects your *existing* Google Form and never changes it.
  - New submissions appear automatically, and their files download into the project and the client's brand kit.
  - You review each one and click **Approve production**. A "start without my review" option is available, with a daily limit.
- **Client Projects:** one project per submission, numbered CP-0001 onwards. Each holds:
  - contact details, answers, requirements and resources
  - a 10-step progress bar and production status
  - every video version, emails and invoice
  - client feedback, revisions, private notes and a full history
- **AI production:** your answers (business, customers, menu/about, goal, focus, must-say, must-not), photos, footage and logo go to the existing AI director and engine. The extra sizes a client asked for are re-rendered from the same storyboard.
- **Video Approval Centre:** full player, requirements, resources, the AI's description and quality check. Options:
  - **Approve video**
  - **Request internal changes**
  - **Regenerate video**
  - Fine-tune in the editor, then **Use my editor changes**
- **Pending Emails:** the personalised email (your template), video links, invoice and the client's requirements. Edit anything, then **Approve & Send**. Nothing is ever sent automatically, and the server refuses a send without that explicit approval.
- **Gmail:** sends from your Gmail. Revisions reply in the same conversation. Each email can only be sent once, even after a retry. Client replies are read and filed under the right project.
- **Client Revisions:** each reply is classified as a change request, happy, declined or unclear.
  - Unclear or mixed messages are flagged for you, never guessed. A message that asks for changes is never treated as a decline.
  - Your instructions, plus the client's email and the original brief, produce a new version. It goes back to the approval centre, then a new email waits for your approval.
- **Declines:** the project is marked declined and archived, the invoice is voided (no charge), and it can be undone.
- **Invoices:** your details and price from Settings, numbered, with GST options and a PDF (Tax Invoice when GST applies). Sent with the delivery email, marked paid only by you, and voided on decline.
- **Dashboard:** statistics, a needs-your-attention list, projects by stage and an activity feed. Everything is clickable.
- **Redesign:** a white and blue design system across every page, including the existing editor, Studio, music and settings. It has a sidebar with the 10 sections and works on phones.

## How Gmail is connected (and why)

Through your own Google Apps Script, authorised with Google's sign-in (OAuth). Cutline never sees your password.

This was chosen over a Google Cloud "Gmail API" project because:

- that route needs about 20 setup steps
- in testing mode, its sign-in expires every 7 days
- publishing it needs Google's review for Gmail access

The script does the same job: send, reply in thread and read replies.

## Tested

- `npm run test:workflow` runs the Google script (31 checks against fake Google services), then all 16 steps of your workflow (50 checks) against a stand-in Apps Script and the mock Claude. This covers:
  - duplicates and failures
  - restarts, refused cross-site sends and voided invoices
- Every page was clicked through in a browser at desktop and phone sizes with no errors.

## Honest limitations

- **Not yet run against a real Google account or real Claude replies.** Send yourself a test submission first and watch it through.
- Cutline must be open on your Mac to check the form and Gmail every 2 minutes.
- Without a Claude key, revisions can only make simple changes (music, opening line, call to action, length, style). When the engine can't make a change, Cutline says so instead of creating a fake version.
- Hand edits made in the editor update the main size only. Use "Request internal changes" to update every size.

---

# Cutline v3: implementation report

Covers the "master project" (parts 1 and 2). The plan and technology evaluation are in `docs/ROADMAP.md`; the running status for future sessions is in `docs/PROGRESS.md`.

## What was replaced

| Before (v2) | After (v3) |
|---|---|
| Ad renderer with 7 fixed text layouts, 6 hard-coded themes (orange/black default), one font | **Motion engine v3:** layered scene graph with camera and parallax, keyframes, masks, motion blur, particles, light sweeps, shadows and reflections, 10 transition types, colour grade and grain. 13 product-first composition recipes; 20 bundled typefaces. |
| Fixed theme colours | **Brand engine:** palettes built from the client's logo and photo colours (or brand kit), contrast-checked, combined with one of 10 creative directions. No two businesses look the same. |
| Claude wrote text into a fixed template | **AI creative director:** objective, direction, brand colours, music, and per-scene recipe, photo, camera, animation, transition and purpose; voiceover script. Plus a free-mode director that builds three structurally different concepts. |
| Edit form + full re-render to see changes | **Studio:** live in-browser preview (same engine), timeline, scene inspector, per-scene "New take", versions with restore. |
| In-memory jobs lost on restart | Persistent jobs with logs, interrupted-job detection and **Try again**. |

## What was upgraded

- **Product visuals:** local background removal (ISNet model, free, private) turns client photos into floating studio product shots with contact shadows, reflections and light sweeps. Small or unsuitable photos are detected and used as cards instead.
- **Audio:** synthesised sound effects (whoosh, swoosh, impact, pop, click, shimmer, riser) in five sound families, placed on transitions and reveals. Music is beat-matched (scene changes land on the beat). Voiceover is ducked under. Everything is normalised to -14 LUFS.
- **Rendering:** parallel worker threads (one per CPU core), so the app stays responsive and multi-core Macs render several times faster. Client footage can play inside ad scenes.
- **Quality control:** every render is checked on the actual MP4:
  - streams, frame rate, codec and length
  - black and frozen frames, loudness and peaks
  - text inside platform safe zones, and text contrast measured on the real pixels
  - photo resolution, pacing, repetition and branding

  Automatic corrections before rendering cover small photos used full screen, repeated neighbouring designs, slow hooks and text-only scenes. Text is auto-fitted into the safe zone allowing for camera moves.
- **Clients:** brand kits (logo, colours, preferred look, details, photo library); new projects for a client start fully set up; projects can be duplicated.
- **Security and reliability:** requests from other websites are blocked; project saves keep a backup copy; there is a rotating log file; failed renders never delete the previous version.

## New technologies

- `@napi-rs/canvas` (already present) is now the core of a custom isomorphic motion engine.
- `onnxruntime-node` (optional dependency) with the ISNet model, for background removal.
- Worker threads for rendering.
- The OpenAI text-to-speech API, for voiceover (approved).
- Fontsource / Google Fonts typefaces (OFL licence).

**Evaluated and not adopted:**
- **Remotion:** a headless-Chrome download and React toolchain for benefits the in-house engine already gives.
- **Three.js:** no WebGL in the renderer, and no real 3D models of client products.
- **Lottie:** needs a DOM shim and licensed animation files.
- **AI image and video generation:** not approved.

## Fully working (implemented and tested)

- Ads end to end in AI mode (against a test stand-in for Claude) and in free mode:
  - photos, logo, cut-outs, director, review, render, quality checks
  - change requests, scene regeneration, Studio edits, versions and restore
- Clients and brand kits.
- The existing clip editor (unchanged features, retested).
- Settings, services and costs, job retry, cross-site blocking.

**Tests:**
- `npm test` covers all of the above against the mock Claude API.
- `npm run test:edge` covers edge cases:
  - no photos at all; WebP, GIF, BMP and TIFF images; corrupt files and bad requests
  - junk Studio input; a server hard-killed mid-render followed by **Try again**
  - Claude unreachable

**Validation:** two ads each for a café, restaurant, barber, car detailer and plumber (free mode, with test logos and photos). Each business got:
- a palette from its own logo
- two different creative directions and concept structures
- products in most scenes
- music and sound effects
- quality reports with no technical, safe-zone, contrast or loudness problems

The only remaining notes were genuinely low-resolution test photos.

## What still needs work / honest limitations

1. **The real Claude director has not been run yet.** It was tested only with a stand-in that returns realistic answers, because no API key is available in this build environment. The first real runs should be watched, and prompts tuned on what comes back.
2. **Test imagery was limited.** Stock photo sites can't be reached from the build environment, so validation used small openly licensed sample photos. Real client photos (large, sharp, well lit) will look far better, and the quality checks will say when they don't.
3. **No true 3D.** Products get 2.5D treatment from real photos; real 3D would need WebGL rendering and real product models.
4. **Preview fidelity.** The live preview approximates video footage timing and skips grain. The final MP4 is exact. Safari versions before 18 may not show blur effects in the preview.
5. **The Home clip editor** still uses the v2 text styles (brand fonts and colours are not applied there yet).
6. **Speed:** a 15-second ad rendered in about 25–55 seconds on the 4-core build machine. An Apple Silicon Mac should be faster.

## Paid services

| Service | Cost | Status |
|---|---|---|
| Claude (Anthropic): direction, revisions, frame review | about 5–15 cents per batch of ads, plus 2–4 cents per ad for review | needs your key |
| OpenAI TTS: voiceover | about 1–2 cents per ad | approved; needs an OpenAI key; off unless ticked |
| OpenAI Whisper: spoken subtitles on clips | small, per minute | optional |
| Background removal | free (local) | automatic |
| AI image / video generation | — | not enabled |

## Ranked further improvements

1. Tune the director's prompts on real Claude output (needs your key and a few real jobs).
2. Hook variations: three alternative openings per ad for A/B testing, re-rendering only the first scene.
3. Content packs: several objectives per client in one run.
4. Brand fonts and colours in the Home clip editor.
5. Optional AI imagery for supporting visuals, if you approve it later (the provider slot exists).
