import { json, readJson } from "../lib/http.js";
import { trainingPlan, isLive, toErrorResponse } from "../lib/coach-ai.js";
import { authEnabled, getSignedInUser, getAdmin, updateProfile } from "../lib/supabase.js";
import { useAllowance } from "../lib/usage.js";
import { planFor } from "../lib/plans.js";

// POST /api/plan { profile } -> { plan: [7 days], left, savedId }
export async function POST(request) {
  if (!isLive()) return json({ error: "AI coach not configured", demo: true }, 503);
  const body = await readJson(request);
  let allowance = null;
  try {
    let session = null;
    if (authEnabled()) {
      session = await getSignedInUser(request);
      if (!session) return json({ error: "Create a free account to get plans from your AI coach.", needLogin: true }, 401);
      allowance = await useAllowance(session.user.id, session.profile.plan, "plan");
      if (!allowance.ok) return json({ error: allowance.message, upgrade: true }, 429);
    }
    const tier = planFor(session?.profile.plan);
    const result = await trainingPlan(body, { elite: tier.elitePlans });

    let savedId = null;
    if (session) {
      const answers = body.profile;
      // Remember the latest answers (Premium's coach uses them in chat).
      await updateProfile(session.user.id, { player_profile: answers }).catch(err => console.error(err));
      if (tier.savePlans) {
        const { data, error } = await getAdmin().from("saved_plans")
          .insert({ user_id: session.user.id, answers, plan: result.plan }).select("id").single();
        if (error) console.error(error); else savedId = data.id;
      }
    }
    return json({ ...result, left: allowance?.left ?? null, savedId, elite: tier.elitePlans });
  } catch (err) {
    await allowance?.refund?.();
    const { status, error } = toErrorResponse(err);
    return json({ error }, status);
  }
}
