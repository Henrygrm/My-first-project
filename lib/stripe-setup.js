// Brings a Stripe account in line with the plans and prices in lib/plans.js.
// Used by scripts/setup-stripe.js. Safe to run again whenever prices change:
//   • creates the Pro and Premium products (or updates their name/description)
//   • creates the monthly and yearly prices; if a price changed, makes a new one,
//     moves the lookup key to it and archives the old one (Stripe prices can't be edited)
//   • sets up the Customer Portal (switch plan, update card, invoices, cancel)
//   • optionally creates the webhook endpoint for your site
import { PLANS, PAID_PLANS, INTERVALS, lookupKey } from "./plans.js";

export const APP_TAG = "pitchside";
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed"
];
const DESCRIPTIONS = {
  pro: "For players who want to get better",
  premium: "For rising stars"
};
const cents = dollars => Math.round(dollars * 100);

async function listAll(listFn, params) {
  const out = [];
  for await (const item of listFn(params)) out.push(item);
  return out;
}

export async function setupStripe(stripe, { siteUrl, log = console.log } = {}) {
  const summary = { products: {}, prices: {}, portal: null, webhook: null };

  // 1. Products
  const existingProducts = await listAll(p => stripe.products.list(p), { limit: 100, active: true });
  for (const plan of PAID_PLANS) {
    const name = `Pitchside Coaching AI ${PLANS[plan].name}`;
    // Ours (tagged), or one with the same name made by an earlier version of this script.
    let product = existingProducts.find(p => p.metadata?.app === APP_TAG && p.metadata?.plan === plan)
      || existingProducts.find(p => p.name === name);
    if (!product) {
      product = await stripe.products.create({ name, description: DESCRIPTIONS[plan], metadata: { app: APP_TAG, plan } });
      log(`✓ Created product: ${name}`);
    } else if (product.name !== name || product.description !== DESCRIPTIONS[plan] || product.metadata?.app !== APP_TAG) {
      product = await stripe.products.update(product.id, { name, description: DESCRIPTIONS[plan], metadata: { app: APP_TAG, plan } });
      log(`✓ Updated product: ${name}`);
    } else {
      log(`• Product already set up: ${name}`);
    }
    summary.products[plan] = product.id;
  }

  // 2. Prices
  const keys = PAID_PLANS.flatMap(plan => INTERVALS.map(i => lookupKey(plan, i)));
  const { data: existingPrices } = await stripe.prices.list({ lookup_keys: keys, active: true, limit: 10 });
  for (const plan of PAID_PLANS) {
    for (const interval of INTERVALS) {
      const key = lookupKey(plan, interval);
      const amount = cents(PLANS[plan].prices[interval]);
      const label = `${PLANS[plan].name} ${interval === "month" ? "monthly" : "yearly"}`;
      const current = existingPrices.find(p => p.lookup_key === key);
      const matches = current && current.unit_amount === amount && current.currency === "usd" &&
        current.recurring?.interval === interval && (current.product?.id || current.product) === summary.products[plan];
      if (matches) {
        log(`• Price already correct: ${label} $${(amount / 100).toFixed(2)}`);
        summary.prices[key] = current.id;
        continue;
      }
      const price = await stripe.prices.create({
        product: summary.products[plan],
        currency: "usd",
        unit_amount: amount,
        recurring: { interval },
        lookup_key: key,
        transfer_lookup_key: true, // take the key over from an old price, if there is one
        nickname: label,
        metadata: { app: APP_TAG }
      });
      if (current) {
        await stripe.prices.update(current.id, { active: false });
        log(`✓ Updated price: ${label} $${(current.unit_amount / 100).toFixed(2)} → $${(amount / 100).toFixed(2)} (old price archived)`);
      } else {
        log(`✓ Created price: ${label} $${(amount / 100).toFixed(2)}`);
      }
      summary.prices[key] = price.id;
    }
  }

  // 3. Customer Portal (Stripe's page for switching plan, updating the card, invoices and cancelling)
  const portalSettings = {
    business_profile: { headline: "Pitchside Coaching AI – manage your subscription" },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products: PAID_PLANS.map(plan => ({
          product: summary.products[plan],
          prices: INTERVALS.map(i => summary.prices[lookupKey(plan, i)])
        }))
      }
    },
    metadata: { app: APP_TAG }
  };
  const configs = await listAll(p => stripe.billingPortal.configurations.list(p), { limit: 100, active: true });
  const ours = configs.find(c => c.metadata?.app === APP_TAG);
  const portal = ours
    ? await stripe.billingPortal.configurations.update(ours.id, portalSettings)
    : await stripe.billingPortal.configurations.create(portalSettings);
  log(`✓ ${ours ? "Updated" : "Created"} the customer billing page (switch plan, update card, invoices, cancel)`);
  summary.portal = portal.id;

  // 4. Webhook (needs the site's public address)
  if (siteUrl) {
    const url = siteUrl.replace(/\/$/, "") + "/api/stripe-webhook";
    const hooks = await listAll(p => stripe.webhookEndpoints.list(p), { limit: 100 });
    const existing = hooks.find(h => h.url === url);
    if (existing) {
      await stripe.webhookEndpoints.update(existing.id, { enabled_events: WEBHOOK_EVENTS, disabled: false });
      log(`• Webhook already exists for ${url} (events updated). Its signing secret is in the Stripe dashboard.`);
      summary.webhook = { id: existing.id, url, secret: null };
    } else {
      const hook = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, description: "Pitchside Coaching AI", metadata: { app: APP_TAG } });
      log(`✓ Created webhook for ${url}`);
      summary.webhook = { id: hook.id, url, secret: hook.secret };
    }
  }
  return summary;
}
