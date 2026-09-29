import { json, readJson } from "../lib/http.js";
import { coachReply, isLive, toErrorResponse } from "../lib/coach-ai.js";
import { authEnabled, getSignedInUser } from "../lib/supabase.js";
import { useAllowance } from "../lib/usage.js";
import { planFor } from "../lib/plans.js";

// POST /api/chat { messages: [{ role, content }] } -> { reply, left }
export async function POST(request) {
  if (!isLive()) return json({ error: "AI coach not configured", demo: true }, 503);
  const body = await readJson(request);
  let allowance = null;
  try {
    let playerProfile = null;
    if (authEnabled()) {
      const session = await getSignedInUser(request);
      if (!session) return json({ error: "Create a free account to chat with your AI coach.", needLogin: true }, 401);
      allowance = await useAllowance(session.user.id, session.profile.plan, "question");
      if (!allowance.ok) return json({ error: allowance.message, upgrade: true }, 429);
      if (planFor(session.profile.plan).rememberProfile) playerProfile = session.profile.player_profile;
    }
    const result = await coachReply(body, { playerProfile });
    return json({ ...result, left: allowance?.left ?? null });
  } catch (err) {
    await allowance?.refund?.();
    const { status, error } = toErrorResponse(err);
    return json({ error }, status);
  }
}
