# Pitchside Coaching AI – Your Personal AI Football Coach

A website with a real AI football coach (Claude), player accounts, and paid subscriptions.

- **Weekly Training Planner** – 8 quick questions → a personalised 7-day plan.
- **Ask a Coach** – chat with the AI coach about getting better.
- **Accounts** – sign up, log in, reset password (Supabase).
- **Subscriptions** – monthly or yearly, paid with Stripe:

| | Free | Pro | Premium |
|---|---|---|---|
| Who it's for | Beginners | Players looking to get better | Rising stars |
| Monthly | $0 | $12 | $22 |
| Yearly | $0 | $99 (save $45) | $179 (save $85) |
| Yearly deal | – | 7-day free trial | 7-day free trial |
| AI plans | 1 a week | 7 a week | Unlimited (fair use: 30/week) |
| Coach questions | 5 a day | 50 a day | Unlimited (fair use: 300/day) |
| Saved plans | – | ✓ | ✓ |
| Elite plans (coaching cue + target on every drill) | – | – | ✓ |
| Coach remembers your profile | – | – | ✓ |

The limits are enforced on the server (`lib/plans.js`), so they can't be bypassed from the browser.

Anything that isn't set up yet runs in **demo mode**: example AI answers, simulated accounts saved in the browser, and a pretend checkout. Nothing is charged in demo mode.

## What's where

| Path | What it is |
|---|---|
| `public/` | The website: `index.html`, `styles.css`, `app.js` (coach), `account.js` (accounts, pricing, checkout) |
| `api/` | Server endpoints: `chat`, `plan`, `plans`, `me`, `config`, `checkout`, `portal`, `stripe-webhook` |
| `lib/` | Claude prompts (`coach-ai.js`), plan limits (`plans.js`), accounts (`supabase.js`), usage (`usage.js`), payments (`billing.js`) |
| `supabase/schema.sql` | Database tables – paste into Supabase once |
| `scripts/setup-stripe.js` | Creates the Pro/Premium prices in Stripe |
| `tests/` | Server tests (`npm test`) |

Secret keys only ever live on the server – never in the browser.

## Setup (about 30 minutes, all in test mode first)

### 1. Claude – the AI coach
Create an API key at <https://platform.claude.com/settings/keys> and set a monthly spend limit.

### 2. Supabase – accounts
1. Create a free project at <https://supabase.com>.
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**.
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
cp .env.example .env   # fill in what you have; blanks run in demo mode
npm run dev            # http://localhost:3000
npm test               # server tests (use stand-ins, no real accounts needed)
```

To test Stripe webhooks locally, use the Stripe CLI: `stripe listen --forward-to localhost:3000/api/stripe-webhook`.

## Changing things

- **Prices:** change them in Stripe (new prices with the same lookup keys), then update the display copies in `lib/plans.js`, `public/account.js` (`PRICING`) and the pricing section of `public/index.html`.
- **Limits and features:** `lib/plans.js`.
- **Coach personality / rules:** `COACH_SYSTEM` and `PLAN_SYSTEM` in `lib/coach-ai.js`.

## Before you launch

- Add a **Terms of Service**, **Privacy Policy** and **refund policy** – Stripe and app stores expect them, and many players will be under 18 (parents should sign up for younger players).
- Set a spend limit on your Claude account.
