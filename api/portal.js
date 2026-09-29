import { json, siteUrl } from "../lib/http.js";
import { authEnabled, getSignedInUser } from "../lib/supabase.js";
import { paymentsEnabled, openPortal } from "../lib/billing.js";

// POST /api/portal -> { url } (Stripe Customer Portal: change plan, update card, cancel, invoices)
export async function POST(request) {
  if (!authEnabled() || !paymentsEnabled()) return json({ error: "Payments aren't set up yet." }, 503);
  try {
    const session = await getSignedInUser(request);
    if (!session) return json({ error: "Log in to manage your subscription.", needLogin: true }, 401);
    if (!session.profile.stripe_customer_id) return json({ error: "You don't have a subscription yet." }, 400);
    return json({ url: await openPortal({ profile: session.profile, origin: siteUrl(request) }) });
  } catch (err) {
    console.error(err);
    return json({ error: "Couldn't open billing. Please try again." }, 500);
  }
}
