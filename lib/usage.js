// Per-plan usage limits, counted in the usage_events table.
// Same rules as the page: questions per day, training plans per calendar month (Free)
// or week (Pro, weeks start Monday). Changing plan starts a fresh allowance.
// Days, weeks and months are counted in Sydney time (see lib/time.js).
import { getAdmin } from "./supabase.js";
import { planFor, FAIR_USE } from "./plans.js";
import { periodStart, nextPeriodStart, niceDate } from "./time.js";

export { periodStart, nextPeriodStart };

// The limit and counting period for one kind of use on a plan.
function rule(profile, kind) {
  const plan = planFor(profile.plan);
  const limit = kind === "question" ? plan.questionsPerDay : plan.plansAllowed;
  const period = kind === "question" ? "day" : plan.planPeriod;
  const unlimited = limit === Infinity;
  return { plan, unlimited, limit: unlimited ? FAIR_USE[kind] : limit, period: unlimited && kind === "plan" ? "week" : period };
}

function since(profile, period) {
  const start = periodStart(period).getTime();
  const changed = profile.plan_changed_at ? new Date(profile.plan_changed_at).getTime() : 0;
  return new Date(Math.max(start, changed)).toISOString();
}

async function countSince(userId, kind, sinceIso) {
  const { count, error } = await getAdmin()
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", kind)
    .gte("created_at", sinceIso);
  if (error) throw error;
  return count || 0;
}

// What's left, e.g. { left: { question: 2, plan: null }, resets: { question, plan } } – null means unlimited.
export async function remaining(profile) {
  const left = {}, resets = {};
  for (const kind of ["question", "plan"]) {
    const r = rule(profile, kind);
    const used = await countSince(profile.id, kind, since(profile, r.period));
    left[kind] = r.unlimited ? null : Math.max(0, r.limit - used);
    resets[kind] = nextPeriodStart(r.period).toISOString();
  }
  return { left, resets };
}

function limitMessage(profile, kind, r) {
  if (r.unlimited) return "You've hit the fair-use limit for now. Please try again tomorrow.";
  const next = niceDate(nextPeriodStart(r.period));
  if (kind === "question") {
    return profile.plan === "free"
      ? `You've used your ${r.limit} free questions for today. They reset tomorrow – or upgrade to Pro for ${planFor("pro").questionsPerDay} a day. ⚽`
      : `You've used all ${r.limit} of today's questions. They reset tomorrow – or go Premium for unlimited questions. ⚽`;
  }
  return profile.plan === "free"
    ? `You've made your free training plan for this month. 🙌 Your next free plan unlocks on ${next}. Upgrade to Pro for a brand-new plan every week.`
    : `You've made this week's plan already. 🙌 Your next one unlocks on ${next}. Premium lets you rebuild your plan any time.`;
}

// Records one use if the plan allows it. Returns { ok, left, refund } or { ok: false, message }.
// `left` is null for unlimited plans.
export async function useAllowance(profile, kind) {
  const r = rule(profile, kind);
  const used = await countSince(profile.id, kind, since(profile, r.period));
  if (used >= r.limit) return { ok: false, message: limitMessage(profile, kind, r) };
  const { data, error } = await getAdmin().from("usage_events").insert({ user_id: profile.id, kind }).select("id").single();
  if (error) throw error;
  // If the AI call fails afterwards, give the use back.
  const refund = () => getAdmin().from("usage_events").delete().eq("id", data.id);
  return { ok: true, left: r.unlimited ? null : r.limit - used - 1, refund };
}
