import { json, readJson, siteUrl } from "../lib/http.js";
import { authEnabled, getSignedInUser } from "../lib/supabase.js";
import { paymentsEnabled, startCheckout } from "../lib/billing.js";
import { PAID_PLANS, INTERVALS } from "../lib/plans.js";

// POST /api/checkout { plan: "pro"|"premium", interval: "month"|"year" } -> { url } (Stripe Checkout)
export async function POST(request) {
  if (!authEnabled() || !paymentsEnabled()) return json({ error: "Payments aren't set up yet." }, 503);
  try {
    const session = await getSignedInUser(request);
    if (!session) return json({ error: "Log in to upgrade.", needLogin: true }, 401);
    const { plan, interval } = await readJson(request);
    if (!PAID_PLANS.includes(plan) || !INTERVALS.includes(interval)) return json({ error: "Choose Pro or Premium, monthly or yearly." }, 400);
    const url = await startCheckout({ ...session, plan, interval, origin: siteUrl(request) });
    return json({ url });
  } catch (err) {
    console.error(err);
    return json({ error: "Couldn't start checkout. Please try again." }, 500);
  }
}
