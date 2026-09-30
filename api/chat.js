import { json, readJson } from "../lib/http.js";
import { coachReply, isLive, toErrorResponse } from "../lib/coach-ai.js";
import { authEnabled, getSignedInUser } from "../lib/supabase.js";
import { useAllowance } from "../lib/usage.js";

// POST /api/chat { messages: [{ role, content }] } -> { reply, left } (left: null = unlimited)
export async function POST(request) {
  if (!isLive()) return json({ error: "AI coach not configured", demo: true }, 503);
  const body = await readJson(request);
  let allowance = null;
  try {
    if (authEnabled()) {
      const session = await getSignedInUser(request);
      if (!session) return json({ error: "Please log in to chat with your AI coach.", needLogin: true }, 401);
      allowance = await useAllowance(session.profile, "question");
      if (!allowance.ok) return json({ error: allowance.message, upgrade: true }, 429);
    }
    const result = await coachReply(body);
    return json({ ...result, left: allowance ? allowance.left : null });
  } catch (err) {
    await allowance?.refund?.();
    const { status, error } = toErrorResponse(err);
    return json({ error }, status);
  }
}
