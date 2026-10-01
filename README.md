# Pitchside Coaching AI – Your Personal AI Football Coach

**One page, two ways to run it.** `public/index.html` is the whole app: log in → choose a plan → your coach.
`football-coach-chatbot.html` is an identical copy for Bolt (run `npm run sync:bolt` after editing the page).

- **On the website** (this repo deployed with its `/api` server and keys): real accounts (Supabase), real payments (Stripe) and the real AI coach (Claude).
- **Anywhere else** (Bolt, a preview, opening the file): **test mode** – pretend accounts saved in the browser, pretend upgrades and example AI answers. The page switches automatically.

What's inside:
- **Log in / Sign up first** – nothing else shows until you're logged in ("Keep me logged in" is optional).
- **Plans page** – Free, Pro (Most popular) and Premium, monthly or yearly (15% off).
- **Weekly Training Planner**, **Ask a Coach**, **My Plans** and **Premium** tabs, locked by plan.

| | Free | Pro | Premium |
|---|---|---|---|
| Monthly | $0 | $10 | $22 |
| Yearly (15% off) | $0 | $102 ($8.50/month) | $224.40 ($18.70/month) |
| Weekly training plans | 1 per month | 1 every week | Unlimited* |
| Ask a Coach questions | 3 a day | 30 a day | Unlimited* |
| Drills | Names only | Step-by-step instructions | Step-by-step instructions |
| Save & view past plans | – | ✓ | ✓ |
| Weekly check-ins that adapt next week's plan | – | – | ✓ |
| AI diet plan & food tracker | – | – | ✓ |
| Match-day warm-ups, fitness & food tips | – | – | ✓ |
| Download plan as PDF | – | – | ✓ |

*Fair use: up to 300 questions a day and 30 plans a week, so one account can't run up a huge AI bill.

On the website the limits are enforced by the server (`lib/plans.js`, `lib/usage.js`) – Free plans even come back from the server with drill names only. Changing plan starts a fresh allowance. Keep `PLANS` in `public/index.html` and `lib/plans.js` in step if you change them.

## What's where

| Path | What it is |
|---|---|
| `public/index.html` | The app/website (HTML, CSS and JavaScript in one file) |
| `football-coach-chatbot.html` | Identical copy for Bolt (`npm run sync:bolt`) |
| `public/vendor/supabase.js` | Supabase login library (only loaded when accounts are switched on) |
| `api/` | Server endpoints: `config`, `me`, `chat`, `plan`, `plans`, `diet`, `checkout`, `portal`, `stripe-webhook` |
| `lib/` | Claude prompts (`coach-ai.js`), plans & prices (`plans.js`), accounts (`supabase.js`), usage limits (`usage.js`), payments (`billing.js`) |
| `supabase/schema.sql` | Database tables – paste into Supabase once |
| `scripts/setup-stripe.js` | Creates the Pro/Premium monthly and yearly prices in Stripe |
| `tests/` | Server tests (`npm test`) |

Secret keys only ever live on the server – never in the page.

## Setup (about 30 minutes, all in test mode first)

### 1. Claude – the AI coach
Create an API key at <https://platform.claude.com/settings/keys> and set a monthly spend limit.

### 2. Supabase – accounts
1. Create a free project at <https://supabase.com>.
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run** (run it again if you set Supabase up before – it adds a new column).
3. **Project Settings → API**: copy the Project URL, the `anon` key and the `service_role` key.
4. **Authentication → URL Configuration**: set **Site URL** to your site's address (e.g. `https://your-site.vercel.app`) so confirmation and password-reset emails link back to it.

### 3. Stripe – payments
1. Create an account at <https://stripe.com> and stay in **Test mode**.
2. **Developers → API keys**: copy the secret key (`sk_test_...`).
3. Create the prices (run on your computer):
   ```bash
   npm install
   STRIPE_SECRET_KEY=sk_test_... npm run setup:stripe
   ```
4. **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-SITE/api/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** (`whsec_...`).
5. **Settings → Billing → Customer portal**: turn it on and allow customers to switch between the Pro and Premium prices and to cancel.

### 4. Put it online (Vercel)
1. Import this repository at <https://vercel.com/new> (framework preset: **Other**).
2. Add the environment variables from `.env.example` (all of them).
3. Deploy. Then update the Stripe webhook URL and Supabase Site URL if your address changed.

Test a purchase with Stripe's test card `4242 4242 4242 4242` (any future date, any CVC).

### Going live
In Stripe, switch to **Live mode**, run `npm run setup:stripe` again with your `sk_live_` key, add a live webhook endpoint, and replace `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Vercel.

## Run it on your computer

Needs Node.js 22.9+.

```bash
npm install
cp .env.example .env   # fill in what you have; blanks run in test mode
npm run dev            # http://localhost:3000
npm test               # server tests (use stand-ins, no real accounts needed)
```

To test Stripe webhooks locally, use the Stripe CLI: `stripe listen --forward-to localhost:3000/api/stripe-webhook`.

## Changing things

- **Prices:** change them in Stripe (new prices with the same lookup keys), then update `PLANS` in `lib/plans.js` and in `public/index.html`, and run `npm run sync:bolt`.
- **Limits and features:** `PLANS` in `lib/plans.js` (server) and `public/index.html` (page), then `npm run sync:bolt`.
- **Coach personality / rules:** `COACH_SYSTEM` and `PLAN_SYSTEM` in `lib/coach-ai.js`.

## Good to know

- Diet-tracker logs, weekly check-ins and the **My Plans** list are saved in the player's browser for now, so they don't follow the player to another device. (AI plans are also saved on the server for Pro and Premium.)
- If Supabase's **Confirm email** setting is on, new players get a "check your email" message and log in after confirming.

## Before you launch

- Add a **Terms of Service**, **Privacy Policy** and **refund policy** – Stripe and app stores expect them, and many players will be under 18 (parents should sign up for younger players).
- Set a spend limit on your Claude account.
