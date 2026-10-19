# Cutline

A personal content studio for local businesses. Upload raw footage from a restaurant, car detailer, tradie, barber, gym or any other local business. Cutline turns it into edited 9:16 social clips with hooks and captions burned in, plus a full set of marketing copy.

- **AI video editing.** Claude reviews frames sampled from your footage, together with measured motion, scene cuts, audio level and brightness. It returns an exact edit list: which moments to use, what to cut, the speed and crop of each segment, and the hook, caption and CTA text. FFmpeg then renders real MP4s (1080×1920, H.264/AAC).
- **Auto-edit (no AI).** This mode works without any API key. It picks moments from the measured motion and sound, cuts them to the industry's pacing and uses template text, which you can edit before re-rendering. It is clearly labelled as non-AI in the app.
- **AI marketing.** Captions, hooks, hashtags (broad, niche and local), video concepts with shot lists, a 7-day plan, promo posts, engagement tips and CTAs. Every section has copy buttons and can be regenerated on its own.
- **Projects.** Each project is a folder on disk (`data/projects/<id>/project.json` plus footage and renders). There is no database. Your last settings and marketing profile are kept in browser localStorage.

## Setup

You need **Node.js 20.12+** (22 recommended) and **FFmpeg**:

| OS | Install FFmpeg |
|---|---|
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` (then open a new terminal) |
| Ubuntu/Debian | `sudo apt install ffmpeg` |

```bash
npm install
cp .env.example .env      # then edit .env (see below)
npm start                 # → http://127.0.0.1:3000
```

### API keys

| Variable | Needed for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI editing and all marketing content | https://console.anthropic.com/settings/keys |
| `OPENAI_API_KEY` *(optional)* | Spoken-word subtitles (Whisper speech-to-text). Claude can see frames but can't hear audio | https://platform.openai.com/api-keys |

Keys live only in `.env` on the server. The browser never sees them, and `.env` is git-ignored. Without a Claude key the app still runs: Auto-edit renders real clips, and the AI features show a setup message instead of fake results.

Other options (model, port, FFmpeg path, frame budget and so on) are documented in `.env.example`. The default model is `claude-opus-5-5`. Requests opt into the API's server-side refusal fallback (`fallbacks: "default"`), so if the model declines a request it is retried on Anthropic's recommended fallback model. Set `CLAUDE_FALLBACKS=off` to disable this.

To use it from your phone on the same Wi-Fi, set `HOST=0.0.0.0` and open `http://<your-computer-ip>:3000`. There is no login, so only do this on a network you trust.

## Workflow

1. Open the app and click **Start Creating**.
2. Pick the business type.
3. Drop in raw videos (several at once is fine).
4. Choose the platform, number of clips, length and engine, and add any instructions.
5. Click **Generate Content** and watch the progress. Preview each clip in the browser.
6. Optionally click **Edit** on a clip to change the hook, captions or CTA, or drop segments, then **Re-render**.
7. Download the **MP4** (and **SRT** captions), and copy the post caption.
8. Switch to **Marketing**, fill in the business details and generate. Copy what you need, and regenerate any section you don't like.

## How the video pipeline works

```
upload ─► ffprobe (duration, rotation, audio)
       ─► FFmpeg analysis: per-second motion, hard cuts, brightness, loudness   (cached)
       ─► [optional] Whisper transcript with word timestamps                     (cached)
       ─► plan:  Claude (frames + signals + business brief + platform rules → JSON edit list)
            or   Auto-edit heuristic
       ─► validate: clamp timestamps to real durations, drop bad segments, enforce platform max
       ─► render per clip: trim → speed → 9:16 (smart crop on focus_x, or blurred fill)
                           → concat → burned-in ASS text (hook/captions/CTA/speech) → fade → MP4 + SRT + thumbnail
```

Each industry has a profile in `server/lib/businesses.js`: what to prioritise, what to avoid, pacing, structure, template text and hashtag seeds. Tweak it to change how clips are cut for that business type.

## Project layout

```
server/index.js          Express app + API routes
server/lib/ai.js         Claude calls (edit plan, marketing) with Zod-validated structured output
server/lib/ffmpeg.js     probe, analysis, frame sampling
server/lib/planner.js    plan validation + no-AI auto-edit
server/lib/render.js     FFmpeg render graph
server/lib/subtitles.js  ASS/SRT generation (platform safe zones)
server/lib/pipeline.js   generate / re-render jobs
server/lib/store.js      file-based projects + job queue
public/                  landing page + dashboard (plain HTML/CSS/JS, no build step)
scripts/smoke-test.mjs   end-to-end test against a mock Claude API (npm test)
```

## Testing

`npm test` generates sample footage, starts the app against a local mock of the Claude API (`scripts/mock-anthropic.mjs`), and runs the whole workflow through the API: upload, auto-edit, AI edit, re-render, marketing, setup errors and the fallback retry. It checks that every output is a real 1080×1920 MP4 with audio. It makes no paid API calls.

## Limitations

- No music is added (licensing). Clips keep the original audio, or you can pick a silent track and add a trending sound inside TikTok or Instagram.
- Emoji are stripped from burned-in text because FFmpeg's subtitle renderer can't draw colour emoji. Post captions keep them.
- Claude sees sampled frames (about 40 per generation by default, `AI_MAX_FRAMES`), not every frame, so very fast moments between samples can be missed.
- One job runs at a time. Rendering speed depends on your CPU; a 30-second clip usually takes 5–20 seconds.
