// Sets up (or updates) Stripe for Pitchside Coaching AI so it matches the website's prices in lib/plans.js.
//   STRIPE_SECRET_KEY=sk_test_... npm run setup:stripe
//   SITE_URL=https://your-site.vercel.app STRIPE_SECRET_KEY=... npm run setup:stripe   (also creates the webhook)
// Safe to run again any time – e.g. after changing prices.
import Stripe from "stripe";
import { setupStripe } from "../lib/stripe-setup.js";
import { PLANS } from "../lib/plans.js";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_SECRET_KEY first (your sk_test_ key while testing). Never commit it to the code.");
  process.exit(1);
}
console.log(`Setting up Stripe in ${key.startsWith("sk_live_") ? "LIVE" : "TEST"} mode…\n`);

try {
  const summary = await setupStripe(new Stripe(key), { siteUrl: process.env.SITE_URL });
  console.log("\nPrices now in Stripe:");
  for (const plan of ["pro", "premium"]) {
    console.log(`  ${PLANS[plan].name}: $${PLANS[plan].prices.month}/month or $${PLANS[plan].prices.year}/year`);
  }
  if (summary.webhook?.secret) {
    console.log(`\nAdd this to your site's environment variables (keep it secret):\n  STRIPE_WEBHOOK_SECRET=${summary.webhook.secret}`);
  } else if (!summary.webhook) {
    console.log("\nNext: once your site is online, run this again with SITE_URL set to create the webhook.");
  }
} catch (err) {
  console.error("\nStripe setup failed:", err.message);
  process.exit(1);
}
