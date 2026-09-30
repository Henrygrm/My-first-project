import { json, readJson } from "../lib/http.js";
import { trainingPlan, isLive, toErrorResponse } from "../lib/coach-ai.js";
import { authEnabled, getSignedInUser, getAdmin } from "../lib/supabase.js";
import { useAllowance } from "../lib/usage.js";
import { planFor } from "../lib/plans.js";

// Free plans show drill names only (same as the page) – details stay on the server.
const namesOnly = plan => plan.map(day => day.rest ? day : { ...day, why: "", drills: day.drills.map(d => ({ name: d.name, detail: "", minutes: d.minutes })) });

// POST /api/plan { profile } -> { plan: [7 days], left, savedId }
export async function POST(request) {
  if (!isLive()) return json({ error: "AI coach not configured", demo: true }, 503);
  const body = await readJson(request);
  let allowance = null;
  try {
    let session = null;
    if (authEnabled()) {
      session = await getSignedInUser(request);
      if (!session) return json({ error: "Please log in to get plans from your AI coach.", needLogin: true }, 401);
      allowance = await useAllowance(session.profile, "plan");
      if (!allowance.ok) return json({ error: allowance.message, upgrade: true }, 429);
    }
    const tier = planFor(session?.profile.plan);
    const result = await trainingPlan(body);
    const plan = session && !tier.drillSteps ? namesOnly(result.plan) : result.plan;

    let savedId = null;
    if (session && tier.savePlans) {
      const { data, error } = await getAdmin().from("saved_plans")
        .insert({ user_id: session.user.id, answers: body.profile, plan }).select("id").single();
      if (error) console.error(error); else savedId = data.id;
    }
    return json({ plan, left: allowance ? allowance.left : null, savedId });
  } catch (err) {
    await allowance?.refund?.();
    const { status, error } = toErrorResponse(err);
    return json({ error }, status);
  }
}
