import { json } from "../lib/http.js";
import { authEnabled, getSignedInUser } from "../lib/supabase.js";
import { remaining } from "../lib/usage.js";
import { planFor } from "../lib/plans.js";

// GET /api/me -> the signed-in player's plan, billing state and what's left this day/week.
export async function GET(request) {
  if (!authEnabled()) return json({ error: "Accounts aren't set up" }, 503);
  try {
    const session = await getSignedInUser(request);
    if (!session) return json({ error: "Not signed in" }, 401);
    const { user, profile } = session;
    const plan = planFor(profile.plan);
    return json({
      email: user.email,
      plan: profile.plan || "free",
      interval: profile.billing_interval,
      status: profile.subscription_status,
      periodEnd: profile.current_period_end,
      cancelAtPeriodEnd: Boolean(profile.cancel_at_period_end),
      hasBilling: Boolean(profile.stripe_customer_id),
      limits: { question: plan.questionsPerDay, plan: plan.plansPerWeek },
      left: await remaining(user.id, profile.plan),
      features: { savePlans: plan.savePlans, rememberProfile: plan.rememberProfile, elitePlans: plan.elitePlans }
    });
  } catch (err) {
    console.error(err);
    return json({ error: "Couldn't load your account." }, 500);
  }
}
