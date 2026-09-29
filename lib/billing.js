// Payments with Stripe: Checkout for new subscriptions, the Customer Portal for
// changes/cancellations, and a webhook that keeps each account's plan in sync.
import Stripe from "stripe";
import { getAdmin, updateProfile } from "./supabase.js";
import { lookupKey, parseLookupKey, PAID_PLANS, INTERVALS, YEARLY_TRIAL_DAYS } from "./plans.js";

export const paymentsEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);

let stripe;
export const getStripe = () => (stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY));
export function _setStripeForTests(client) { stripe = client; priceCache.clear(); }

const priceCache = new Map();
async function priceId(plan, interval) {
  const key = lookupKey(plan, interval);
  if (!priceCache.has(key)) {
    const { data } = await getStripe().prices.list({ lookup_keys: [key], active: true, limit: 1 });
    if (!data.length) throw new Error(`No active Stripe price with lookup key ${key}. Run scripts/setup-stripe.js.`);
    priceCache.set(key, data[0].id);
  }
  return priceCache.get(key);
}

async function ensureCustomer(user, profile) {
  if (profile.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await getStripe().customers.create({ email: user.email, metadata: { user_id: user.id } });
  await updateProfile(user.id, { stripe_customer_id: customer.id });
  return customer.id;
}

const hasActiveSubscription = profile =>
  PAID_PLANS.includes(profile.plan) && ["active", "trialing", "past_due"].includes(profile.subscription_status);

// Returns the URL to send the visitor to.
export async function startCheckout({ user, profile, plan, interval, origin }) {
  if (!PAID_PLANS.includes(plan) || !INTERVALS.includes(interval)) throw new Error("Unknown plan");
  const customer = await ensureCustomer(user, profile);

  // Already subscribed: switching plans happens in the Customer Portal (with proration).
  if (hasActiveSubscription(profile)) return openPortal({ profile: { ...profile, stripe_customer_id: customer }, origin });

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price: await priceId(plan, interval), quantity: 1 }],
    subscription_data: {
      metadata: { user_id: user.id },
      ...(interval === "year" ? { trial_period_days: YEARLY_TRIAL_DAYS } : {})
    },
    allow_promotion_codes: true,
    success_url: `${origin}/?checkout=success#pricing`,
    cancel_url: `${origin}/?checkout=cancelled#pricing`
  });
  return session.url;
}

export async function openPortal({ profile, origin }) {
  if (!profile.stripe_customer_id) throw new Error("No billing account yet");
  const session = await getStripe().billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${origin}/#pricing`
  });
  return session.url;
}

// Copies a Stripe subscription's state onto the matching profile.
export async function syncSubscription(sub) {
  const db = getAdmin();
  let userId = sub.metadata?.user_id;
  if (!userId) {
    const { data } = await db.from("profiles").select("id").eq("stripe_customer_id", sub.customer).maybeSingle();
    userId = data?.id;
  }
  if (!userId) {
    console.warn("Stripe subscription without a matching account:", sub.id);
    return;
  }

  const item = sub.items?.data?.[0];
  const tier = parseLookupKey(item?.price?.lookup_key);
  const live = ["active", "trialing", "past_due"].includes(sub.status);
  const periodEnd = item?.current_period_end ?? sub.current_period_end;

  await updateProfile(userId, {
    plan: live && tier ? tier.plan : "free",
    billing_interval: live && tier ? tier.interval : null,
    subscription_status: sub.status,
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end || sub.cancel_at)
  });
}

// Verifies and handles one webhook call. `rawBody` must be the unparsed request text.
export async function handleWebhook(rawBody, signature) {
  const event = await getStripe().webhooks.constructEventAsync(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode === "subscription" && session.subscription) {
        const sub = await getStripe().subscriptions.retrieve(session.subscription);
        await syncSubscription(sub);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await syncSubscription(event.data.object);
      break;
  }
  return event.type;
}
