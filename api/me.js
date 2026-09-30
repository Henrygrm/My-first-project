import { json } from "../lib/http.js";
import { authEnabled, getSignedInUser } from "../lib/supabase.js";
import { remaining } from "../lib/usage.js";

// GET /api/me -> the signed-in player's name, plan and what's left (null = unlimited).
export async function GET(request) {
  if (!authEnabled()) return json({ error: "Accounts aren't set up" }, 503);
  try {
    const session = await getSignedInUser(request);
    if (!session) return json({ error: "Not signed in", needLogin: true }, 401);
    const { user, profile } = session;
    const { left, resets } = await remaining(profile);
    return json({
      id: user.id,
      name: user.user_metadata?.name || (user.email || "").split("@")[0],
      email: user.email,
      plan: profile.plan || "free",
      interval: profile.billing_interval,
      status: profile.subscription_status,
      periodEnd: profile.current_period_end,
      cancelAtPeriodEnd: Boolean(profile.cancel_at_period_end),
      hasBilling: Boolean(profile.stripe_customer_id),
      left,
      resets
    });
  } catch (err) {
    console.error(err);
    return json({ error: "Couldn't load your account." }, 500);
  }
}
