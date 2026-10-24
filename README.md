# Cutline

My personal video editor for local-business clips. Drop in raw footage from a restaurant, detailer, tradie, barber, gym or any other business, and Cutline makes finished 9:16 clips (TikTok, Reels, Shorts) with music cut to the beat, transitions, a hook, captions and a call to action. Then type changes into the bar at the top ("make clip 2 15 seconds", "use the lofi song", "punchier hook") and it re-edits them.

## Starting it (Mac)

Double-click **Start Cutline** in the `My-first-project` folder. It stops any old copy, downloads the latest version, and opens http://127.0.0.1:3000. Leave the Terminal window open while you use it; close it to stop Cutline.

The first time, macOS may ask whether to open it: right-click **Start Cutline** → **Open** → **Open**.

You need Node.js 20.12+ and FFmpeg (`brew install node ffmpeg`).

## The three pages

- **Home.** Pick the business, fill in its details (name, services, suburb, offer, customers), drop in footage, choose platform, length, number of clips, style and music, then **Generate**. Finished clips show with their angle and why they should work. Download the MP4, copy the post caption, or open **Edit** to change text or shots by hand. The bar at the top takes plain-English changes for all clips or one clip.
- **Music.** Add MP3s and see every song already added, with its tempo, length and mood (Energetic / Chill / Build-up, which decides which clips use it). Play, change the mood, or remove. **Music volume** sets how loud music sits against the footage's own sound.
- **Settings.** Paste the Claude API key (saved to `.env` on this computer, never sent to the browser), check it works, pick the model, switch between Claude AI and free auto-edit, and set framing, footage sound, on-screen text and spoken subtitles (needs an OpenAI key).

## Claude AI vs free mode

**With a Claude key** (recommended): Claude looks at frames from every video plus measured motion, sound and brightness, and the business details you typed. It first works out a strategy for that business (what will stop people scrolling, who it's for), then gives each clip a different angle (transformation reveal, satisfying process, offer, behind the scenes…) and writes an exact edit: which moments, in what order, speed, crop, transitions, hook, captions and call to action. The change bar sends your request to Claude with the current edit and the footage, so you can ask for anything.

**Without a key** (free mode): shots are picked from measured motion and sound, each clip gets a different style, and hooks, captions and calls to action come from templates for the industry, personalised with the business name, offer and services. The change bar understands common requests: lengths ("make clip 2 15 seconds", "shorter"), text ("hook: Wait for it", "cta: Book at Gloss Boss", "no captions"), music ("no music", "use the lofi song", "different song", "louder music"), style ("make it a promo", "before and after", "faster") and "redo clip 1". It says so when it doesn't understand something instead of guessing.

## Styles

| Style | What it looks like |
|---|---|
| Beat montage | Fast cuts on the beat, punch-ins, flash/zoom/whip transitions, bold text |
| Before & after | Opens on the "before", builds through the work, slow-mo reveal, split-screen comparison |
| Satisfying process | Longer calm shots, slow push-ins, dissolves, original sound up front |
| Story / day in the life | A caption on every shot, soft transitions, warm grade |
| Top 3 list | Numbered sections with wipe transitions |
| Promo ad | Big sales text, quick cuts, strong call to action |

"Mix" lets Claude (or free mode) pick a different style per clip.

## Music

Each song is analysed once for tempo and beat. When a clip is made with a Claude key, Claude sees your song list (names, moods, tempos) and picks the best song for each clip and business; in free mode, a song matching the clip's mood is picked. Each clip gets a different song when possible. Every cut lands on the beat, the music starts on a beat after any quiet intro, both music and footage sound are level-matched, and the finished clip is normalised to -14 LUFS (what TikTok and Instagram use).

Only use music you're allowed to post. Pixabay Music tracks are free for social posts.

## Clip length

Clips are made to the length you pick (within the platform limit). If there isn't enough usable footage, Cutline uses more of each shot, slows some down a little, then repeats the best moments, and notes it on the clip. If it still can't reach the length, the clip says how long it is and why.

## Settings in `.env`

The Settings page writes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CLAUDE_MODEL` into `.env`. Other options (port, FFmpeg path, frame budget) are listed in `.env.example`. `.env` is git-ignored.

## How it works

```
upload ─► ffprobe ─► FFmpeg analysis: motion, cuts, brightness, loudness per second (cached)
       ─► plan:   Claude (frames + signals + business details → strategy + edit list)
             or   free auto-edit (motion/sound scoring + style templates)
       ─► validate, snap cuts to the music's beat, fit to length
       ─► render: trim → speed → 9:16 crop or blurred fill → transitions → grade
                  → text overlays → music mix → loudness normalise → MP4 + SRT
change bar ─► Claude revises the edit list (or rule parser without a key) ─► re-render changed clips
```

```
server/index.js          API routes
server/lib/ai.js         Claude calls (plan + revise), Zod-validated structured output
server/lib/commands.js   change-bar rules for free mode
server/lib/pipeline.js   generate / revise / re-render jobs
server/lib/planner.js    plan validation, free auto-edit, beat sync, length fitting
server/lib/render.js     FFmpeg render graph
server/lib/music.js      music library + beat detection
server/lib/settings.js   Settings page → .env
public/                  Home / Music / Settings (plain HTML/CSS/JS)
scripts/smoke-test.mjs   end-to-end test against a mock Claude API (npm test)
```

## Testing

`npm test` makes sample footage and music, starts the app against a local stand-in for the Claude API, and runs everything through the real API and FFmpeg: uploads, music library, free and AI edits, the change bar (AI and rules), manual edits, Settings (using a temporary `.env`), setup errors and the fallback retry. It checks every output is a real 1080×1920 MP4 with audio at the right length, that cuts land on the beat, and that the music is audible. It makes no paid API calls.

## Troubleshooting

| What you see | What to do |
|---|---|
| Red "old copy of Cutline is still running" | Close every Terminal window, then double-click **Start Cutline**. |
| "Not found" when adding music | Same cause: an old copy is running. Use **Start Cutline**. |
| Red "FFmpeg is not installed" | `brew install ffmpeg`, then **Start Cutline** again. |
| "Your Claude API key was rejected" | Copy the key again into Settings and press **Check**. |
| "Out of credit" | Add credit at console.anthropic.com → Billing. |
| "Cutline stopped" | The Terminal window was closed. Double-click **Start Cutline**. |
| iPhone video won't preview | Normal for HEVC footage in some browsers. It still edits fine. |

## Limitations

- Emoji are removed from text drawn on the video (post captions keep them).
- Claude sees sampled frames (about 40 per generation), not every frame.
- One job runs at a time. 4K HEVC footage is the slowest to render.
