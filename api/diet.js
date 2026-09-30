import { json, readJson } from "../lib/http.js";
import { dietPlan, dietFeedback, isLive, toErrorResponse } from "../lib/coach-ai.js";
import { authEnabled, getSignedInUser } from "../lib/supabase.js";
import { useAllowance } from "../lib/usage.js";
import { planFor } from "../lib/plans.js";

// POST /api/diet { action: "plan" | "feedback", input } – Premium only.
//   plan     -> { plan: { waterTarget, notes, days: { training, rest, match } } }
//   feedback -> { tips: [..] }
export async function POST(request) {
  if (!isLive()) return json({ error: "AI coach not configured", demo: true }, 503);
  const { action, input } = await readJson(request);
  if (!["plan", "feedback"].includes(action)) return json({ error: "Unknown action." }, 400);
  let allowance = null;
  try {
    if (authEnabled()) {
      const session = await getSignedInUser(request);
      if (!session) return json({ error: "Please log in to use the diet tracker.", needLogin: true }, 401);
      if (!planFor(session.profile.plan).premium) {
        return json({ error: "The AI diet plan & tracker is part of Premium.", upgrade: true }, 403);
      }
      // Counts towards the fair-use cap like a coach question.
      allowance = await useAllowance(session.profile, "question");
      if (!allowance.ok) return json({ error: allowance.message, upgrade: true }, 429);
    }
    return json(action === "plan" ? await dietPlan(input) : await dietFeedback(input));
  } catch (err) {
    await allowance?.refund?.();
    const { status, error } = toErrorResponse(err);
    return json({ error }, status);
  }
}
