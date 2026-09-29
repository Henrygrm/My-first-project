import { json } from "../lib/http.js";
import { authEnabled, getSignedInUser, getAdmin } from "../lib/supabase.js";
import { planFor } from "../lib/plans.js";

// GET /api/plans -> the player's 10 most recent saved plans (Pro and Premium).
export async function GET(request) {
  if (!authEnabled()) return json({ error: "Accounts aren't set up" }, 503);
  try {
    const session = await getSignedInUser(request);
    if (!session) return json({ error: "Log in to see your saved plans.", needLogin: true }, 401);
    if (!planFor(session.profile.plan).savePlans) {
      return json({ error: "Saving plans is part of Pro and Premium.", upgrade: true }, 403);
    }
    const { data, error } = await getAdmin().from("saved_plans")
      .select("id, created_at, answers, plan")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    return json({ plans: data });
  } catch (err) {
    console.error(err);
    return json({ error: "Couldn't load your saved plans." }, 500);
  }
}
