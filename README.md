# CoachAI – Your Personal AI Football Coach

A website with a real AI football coach, powered by Claude:

- **Weekly Training Planner** – 8 quick questions (position, age, strong foot, kit, days per week, time per session, weaknesses, goals) → a personalised 7-day plan with sensible session lengths and rest days.
- **Ask a Coach** – chat with the AI coach about anything to do with getting better at football.

If the AI isn't connected yet, the site still works using a built-in planner and example answers ("Demo mode").

## What's where

| Path | What it is |
|---|---|
| `public/index.html` | The website (hero, features, how it works, coach, pricing, get started) |
| `public/styles.css` | All styles, including dark mode |
| `public/app.js` | The planner + chat, and the built-in demo coach |
| `api/chat.js`, `api/plan.js` | Serverless endpoints the page calls |
| `lib/coach-ai.js` | The Claude prompts and API calls (model, safety fallback, plan JSON schema) |
| `server.js` | Local test server |
| `football-coach-chatbot.html` | The original single-file chatbot (demo answers only) |

Your API key only ever lives on the server – it is never sent to the browser.

## 1. Get a Claude API key

Create one at <https://platform.claude.com/settings/keys>. API usage is billed per request, so set a monthly spend limit in the Claude Console.

## 2. Run it on your computer

Needs Node.js 22.9 or newer.

```bash
npm install
cp .env.example .env      # then paste your key into .env
npm run dev               # open http://localhost:3000
```

Without a key it runs in demo mode.

## 3. Put it online (Vercel)

1. Go to <https://vercel.com/new> and import this GitHub repository.
2. Leave the framework preset as **Other** (no build command needed).
3. Under **Environment Variables**, add `ANTHROPIC_API_KEY` with your key.
4. Click **Deploy**. The coach badge should say **"Online · powered by Claude"**.

To use your own domain, add it in Vercel → Project → Settings → Domains.

## Changing things

- **Coach personality / rules:** edit `COACH_SYSTEM` and `PLAN_SYSTEM` in `lib/coach-ai.js`.
- **Pricing:** the prices in `public/index.html` are placeholders – change them to yours. The buttons open the coach; payments aren't connected.
- **Built-in drills and session-length rules:** `DRILLS`, `AGE_CAP` and `sessionLength()` in `public/app.js`.

## Good to know

- Plans take roughly 10–30 seconds to generate with the AI; chat replies are quicker.
- There's no sign-in or rate limiting yet, so anyone who finds the site can use your API credits. Keep a spend limit set, and add accounts/limits before promoting it widely.
