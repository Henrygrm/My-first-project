# Progress log

Read `docs/ROADMAP.md` first (audit, technology decisions, plan). This file records what is done and what is next, so a new session can continue.

## Status: v4.0.0 (2026-10-31)

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
- **Tests:** `npm test` covers all of the above against the mock Claude API (`scripts/mock-anthropic.mjs`). `npm run test:edge`: no media, odd image formats, corrupt files, bad requests, junk studio input, hard kill mid-render then retry, Claude unreachable.
- **Validation:** 2 ads each for café, restaurant, barber, detailing and trades (free mode, test logos and photos); issues found and fixed:
  - text unit bug; safe-zone auto-fit allowing for camera moves; camera-aware QA boxes
  - logo plates; claim-style hooks filtered; frozen list scenes; loudness parsing
- **Automatic corrections** before rendering (`autoFix` in `ads.js`); final report in `docs/REPORT.md`.

- **Google Form requests (v3.1):**
  - `integrations/google-form/Code.gs` is an Apps Script. `setupCutline()` builds the "Video request" form and a connection code; `doGet` serves answers and chunked uploads to holders of the code, and only for files attached to that answer.
  - `server/lib/intake.js` checks every 2 minutes and maps answers by question title. Each request becomes a client (matched by email, then name), a project with only that request's photos (falling back to the client's library), and an `ads` job.
  - Extra sizes are made by the `ads-size` job, which copies the project and re-renders the same storyboards with no AI.
  - Safeguards: a daily limit, answers sent before connecting wait for the owner, and the URL must be a script.google.com address.
  - UI: the **Requests** page. Tests: `npm run test:form` (a stand-in Apps Script, 34 checks), plus the script itself run against fake Google services.
  - Limits: it only runs while Cutline is open on the Mac. Google can't create file upload questions from a script, so the owner adds 3 by hand. Uploads over 50 MB stay in Drive.

- **Approve and email (v3.2):**
  - Finished requests wait at **Check and approve**. The owner watches the videos, ticks which to send and edits the email, then clicks **Approve and send**.
  - Cutline POSTs each MP4 to the script's `doPost` (`upload`), which saves it to Drive › Cutline videos › client and shares it as a view-only link. Then `email` sends from the owner's Gmail (MailApp) with button links.
  - Script version 2 is needed; the page shows update steps when an older one is detected.
  - Nothing is ever sent automatically. A failed send returns to review with the reason.
  - Gmail limit: about 100 emails a day on a personal account.

- **v4.0: client workflow platform + white/blue redesign.**
  - *Data:* `server/lib/cprojects.js` holds client projects: one folder per project in `data/cprojects/<id>` with `project.json`, `resources/` (clips) and `versions/vN/` (snapshot MP4s). Numbered CP-0001…; every action goes into the project history and `activity.js` (`data/activity.jsonl`).
  - *Settings:* `business.js` (`data/business.json`) holds business details, pricing, invoice settings and email templates.
  - *Invoices:* `invoices.js` (`data/invoices.json`) with pdfkit PDFs. Statuses: draft → issued (when emailed) → paid (owner only), or void on decline.
  - *Workflow:* submitted → collecting (downloads) → ready_for_review → [Approve production] → producing → video_review → [Approve video] → email_review (email + invoice prepared) → [Approve & Send] → sent → client reply → revision_requested / needs_attention / completed / declined.
  - *Approval centre options:* Approve, Request internal changes (`ads-revise`), Regenerate (`ads`), Use my editor changes.
  - *Extra sizes:* re-rendered with `ads-size {format, into}`.
  - *Requests with no effect:* a revise that changes nothing creates no version and sets `lastNoChange`.
  - *Gmail:* Apps Script v3 (`integrations/google-form/Code.gs`), chosen over the Gmail API because it needs no Cloud project and has no weekly token expiry in testing mode.
    - `send` is idempotent per email ref and replies in-thread to the client's last message.
    - `inbox` returns client messages by thread or from-address.
    - setupCutline attaches to the owner's existing form and never creates one.
  - *Replies:* classified by Claude (`classifyReply`) with rule checks. A "declined" that mentions changes, or low confidence, becomes `needs_attention`. Without AI, conservative rules are used.
  - *UI:* the sidebar shell in `index.html` and the new pages in `public/js/ops.js`. `app.js` routes; old hashes (`#/ads`, `#/clients`, …) are aliased. The editor pages live under AI Video Production (tabs), and brand kits under Client Projects (tab).
  - *Design:* `css/styles.css` was rewritten as a light design system with the same class names.
  - *Tests:* `npm run test:workflow` runs the Google script against fake Google services, then the full 16-step workflow against a stand-in Apps Script and the mock Claude.
  - Setup guide for the owner: `docs/SETUP-GOOGLE.md`.

### Owner decisions
- Approved: Claude photo analysis and frame review; OpenAI voiceover.
- Not approved: AI image and video generation. Provider slots exist in `server/providers/index.js`.

### Known limitations / next ideas (ranked)
0. The real Google script has been tested only against faithful stand-ins. The first real form submission and email should be watched.
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
