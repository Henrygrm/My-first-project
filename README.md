# Cutline

A personal AI video studio for making social media ads and clips for local businesses: cafés, restaurants, barbers, car detailers, tradies, gyms and more. It turns a business's photos, footage and logo into professional motion-graphics ads and edited 9:16 clips, with music cut to the beat, sound design, adaptive branding and automatic quality checks.

## Starting it (Mac)

Double-click **Start Cutline** in the `My-first-project` folder. It stops any old copy, downloads updates, and opens http://127.0.0.1:3000 once Cutline is ready. Leave the Terminal window open while you use it; close it to stop Cutline.

The first time, macOS may ask whether to open it: right-click **Start Cutline** → **Open** → **Open**. You need Node.js 20.12+ and FFmpeg (`brew install node ffmpeg`).

## The pages

- **Home**: edits real footage into clips (TikTok, Reels, Shorts). Pick the business, add videos, choose length, number of clips and style, then **Generate**. Type changes into the bar at the top.
- **Ads**: motion-graphics ads built around the business's products. Pick a client (or fill in the business details), add product photos and the logo, choose a goal, look, format, length and music, then **Make ads**. Each ad comes with a quality report. Open **Studio** to edit.
- **Studio** (from an ad): a live preview that plays instantly in the browser (the same engine as the final render), a timeline of scenes, and an inspector for each scene: design, headline, photos, length, layout, camera move, entrance, text animation and transition. Change the whole ad's look, background, accent colour, music or voiceover. **New take** regenerates one scene; **Versions** restores an earlier render.
- **Clients**: a brand kit per business: logo (its colours become the brand colours), exact brand colours, preferred look, business details and a photo library. **New project** starts with all of it, so returning clients need nothing re-entered.
- **Music**: your song library with tempo, length and mood. Songs are analysed for their beat; scenes and cuts land on it.
- **Settings**: Claude key, model, engine (AI or free), output options, OpenAI key (voiceover and spoken subtitles), and the services list with what each costs.

## How the ads are made

1. **Media analysis.** Every photo is measured (size, sharpness, brightness, colours). Products are cut out of their background locally (ISNet model, free, nothing leaves the computer), so they can float as studio product shots.
2. **Creative direction.** With a Claude key, Claude looks at the photos, logo and footage and acts as creative director: it chooses the objective, a creative direction, brand colours, the music and, for every scene, a composition recipe, photo, camera move, animation and transition, with a purpose for each scene. It writes the copy (never inventing offers, reviews or facts) and an optional voiceover script. Without a key, a rule-based director builds three structurally different concepts from the business details and the best photos.
3. **Review.** Claude looks at a still from every scene before rendering and fixes weak ones (optional, a few cents).
4. **Rendering.** The motion engine draws every frame with layered compositions: photos and cut-outs with depth and parallax, camera moves, light sweeps, shadows and reflections, particles (steam, water droplets, sparks, confetti), kinetic typography, motion blur, transitions, colour grading and film grain. Frames are rendered in parallel on all CPU cores and encoded by FFmpeg.
5. **Sound.** Music (looped, beat-matched, level-balanced), synthesised sound effects on transitions and reveals, and an optional voiceover with the music ducked underneath, normalised to -14 LUFS.
6. **Quality control.** Every render is inspected: resolution, frame rate, codec, length, black or frozen frames, loudness and peaks, text inside platform safe zones, real text contrast on the rendered pixels, photo resolution, pacing, repetition and branding. Problems come with a suggested fix.

**Creative directions:** Cinematic, Luxury, Minimalist, Futuristic, Energetic, Editorial, Modern commercial, Playful, Premium, Industrial. Each defines typography (20 bundled open-licence typefaces), motion, backgrounds, transitions, grade and sound; the client's brand colours supply the palette.

**Scene recipes:** product hero, full-screen photo (2.5D depth when the subject can be cut out), photo stack, before/after, kinetic type, benefits list, offer burst, customer review, big number, process steps, client footage, location, call to action.

**Formats:** 9:16 (TikTok, Reels, Shorts, Facebook Reels), 4:5 and 1:1 (feeds), 16:9 (YouTube, websites). 1080p, 30 fps, H.264 + AAC 48 kHz.

## Paid services

| Service | Used for | Cost | Status |
|---|---|---|---|
| Claude (Anthropic) | Creative direction, change requests, scene review | about 5–15 cents per batch of ads | needs your Claude key |
| OpenAI text-to-speech | Voiceovers | about 1–2 cents per ad | needs an OpenAI key; off unless ticked |
| OpenAI Whisper | Spoken subtitles on clips | small, per minute of audio | needs an OpenAI key; optional |
| Background removal | Product cut-outs | free (runs locally) | automatic |
| AI image / video generation | — | — | not enabled (not approved) |

Keys are stored in `.env` on this computer only and never sent to the browser.

## Music and licensing

Only use music you're allowed to post commercially. Pixabay Music tracks are free for business posts. Sound effects are synthesised by Cutline, so they have no licensing restrictions. Fonts are SIL Open Font License (licences in `assets/fonts/lib`).

## Data

No database: everything lives in `data/` on this computer.

| Folder | Contents |
|---|---|
| `data/projects/<id>/` | `project.json` (plus `project.prev.json`, the previous save), footage, photos, cut-outs, renders and versions |
| `data/clients/<id>/` | brand kits and photo libraries |
| `data/music/` | music library |
| `data/jobs/` | job records (so interrupted jobs can be retried after a restart) |
| `data/logs/cutline.log` | log file (rotates at 5 MB) |
| `data/models/`, `data/sfx/` | the cut-out model (downloaded once) and generated sound effects |

Back up the `data` folder to keep everything.

## Testing

`npm test` creates sample footage, photos and music, starts the app against a local stand-in for the Claude API, and runs everything through the real API, FFmpeg and the motion engine: uploads, clips (free and AI), ads (AI director, frame review, normalisation of loose AI labels, QA, change requests, scene regeneration, studio edits, versions and restore), free-mode concepts, clients and brand kits, settings, job retry, cross-site request blocking and setup errors. It makes no paid API calls.

## Troubleshooting

| What you see | What to do |
|---|---|
| Red "old copy of Cutline is still running" | Close every Terminal window, then double-click **Start Cutline**. |
| Page won't load right after starting | Wait for "Cutline is running" in the Terminal, then reload. |
| "Your Claude API key was rejected" | Copy the key again into Settings and press **Check**. |
| "Out of credit" | Add credit at console.anthropic.com → Billing. |
| A job failed | Press **Try again**; details are in the log file shown in Settings. |
| Photos marked "!" | Small, blurry or dark photos look soft full screen; use larger, sharper ones. |

## Limitations

- No true 3D models: products get 2.5D treatment (cut-outs, depth, parallax, tilts, light sweeps) from real photos.
- AI image and video generation are not enabled. The best ads come from the client's own sharp photos and footage.
- The live preview approximates video footage playback; the rendered MP4 is exact.
- The AI paths are tested against a stand-in for the Claude API; real Claude output can vary.
