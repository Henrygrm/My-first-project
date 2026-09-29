// Creates the CoachAI products and prices in your Stripe account (run once per account/mode).
//   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js
// Safe to re-run: prices that already exist (by lookup key) are left alone.
import Stripe from "stripe";
import { PLANS, lookupKey } from "../lib/plans.js";

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("Set STRIPE_SECRET_KEY first (use your sk_test_ key while testing).");
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const DESCRIPTIONS = {
  pro: "For players looking to get better",
  premium: "For rising stars"
};

for (const plan of ["pro", "premium"]) {
  const keys = ["month", "year"].map(i => lookupKey(plan, i));
  const { data: existing } = await stripe.prices.list({ lookup_keys: keys, limit: 10 });
  let productId = existing[0]?.product;
  if (!productId) {
    const product = await stripe.products.create({ name: `CoachAI ${PLANS[plan].name}`, description: DESCRIPTIONS[plan] });
    productId = product.id;
    console.log(`Created product CoachAI ${PLANS[plan].name}`);
  }
  for (const interval of ["month", "year"]) {
    const key = lookupKey(plan, interval);
    if (existing.some(p => p.lookup_key === key)) {
      console.log(`Price ${key} already exists`);
      continue;
    }
    const amount = PLANS[plan].prices[interval];
    await stripe.prices.create({
      product: typeof productId === "string" ? productId : productId.id,
      currency: "usd",
      unit_amount: amount * 100,
      recurring: { interval },
      lookup_key: key,
      nickname: `${PLANS[plan].name} ${interval === "month" ? "monthly" : "yearly"}`
    });
    console.log(`Created price ${key}: $${amount}/${interval}`);
  }
}
console.log("\nDone. Next: add the webhook endpoint in Stripe (see README).");
