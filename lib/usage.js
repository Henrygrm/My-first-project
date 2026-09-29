// Per-plan usage limits, counted in the usage_events table.
import { getAdmin } from "./supabase.js";
import { planFor } from "./plans.js";

const DAY = 24 * 60 * 60 * 1000;
const RULES = {
  question: { limitKey: "questionsPerDay", window: DAY, label: "coach questions today" },
  plan: { limitKey: "plansPerWeek", window: 7 * DAY, label: "AI plans this week" }
};

async function countSince(userId, kind, sinceMs) {
  const { count, error } = await getAdmin()
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", kind)
    .gte("created_at", new Date(Date.now() - sinceMs).toISOString());
  if (error) throw error;
  return count || 0;
}

// Remaining allowance for each kind, e.g. { question: 3, plan: 1 }.
export async function remaining(userId, planName) {
  const plan = planFor(planName);
  const out = {};
  for (const [kind, rule] of Object.entries(RULES)) {
    out[kind] = Math.max(0, plan[rule.limitKey] - (await countSince(userId, kind, rule.window)));
  }
  return out;
}

// Records one use if the plan allows it. Returns { ok, left, refund } or { ok: false, message }.
export async function useAllowance(userId, planName, kind) {
  const rule = RULES[kind];
  const limit = planFor(planName)[rule.limitKey];
  const used = await countSince(userId, kind, rule.window);
  if (used >= limit) {
    const upgrade = planName === "premium" ? "" : planName === "pro" ? " Upgrade to Premium for more." : " Upgrade to Pro or Premium for more.";
    return { ok: false, message: `You've used all ${limit} ${rule.label} on the ${planFor(planName).name} plan.${upgrade}` };
  }
  const { data, error } = await getAdmin().from("usage_events").insert({ user_id: userId, kind }).select("id").single();
  if (error) throw error;
  // If the AI call fails afterwards, give the use back.
  const refund = () => getAdmin().from("usage_events").delete().eq("id", data.id);
  return { ok: true, left: limit - used - 1, refund };
}
