// Subscription tiers – the same as the PLANS section in public/index.html.
// The server enforces these limits; the page only displays them.
// Prices live in Stripe (see scripts/setup-stripe.js); these are the display copies.
export const YEARLY_DISCOUNT = 0.15; // 15% off when paying yearly
const yearly = monthly => Math.round(monthly * 12 * (1 - YEARLY_DISCOUNT) * 100) / 100;

export const PLANS = {
  free: {
    name: "Free",
    plansAllowed: 1, planPeriod: "month",   // 1 weekly training plan per month
    questionsPerDay: 3,
    drillSteps: false, savePlans: false, premium: false
  },
  pro: {
    name: "Pro",
    plansAllowed: 1, planPeriod: "week",    // a new weekly plan every week
    questionsPerDay: 30,
    drillSteps: true, savePlans: true, premium: false,
    prices: { month: 10, year: yearly(10) } // $102/year
  },
  premium: {
    name: "Premium",
    plansAllowed: Infinity, planPeriod: "week",
    questionsPerDay: Infinity,
    drillSteps: true, savePlans: true, premium: true,
    prices: { month: 22, year: yearly(22) } // $224.40/year
  }
};

// "Unlimited" still has a hidden fair-use cap so one account can't run up a huge AI bill.
export const FAIR_USE = { question: 300, plan: 30 }; // per day / per week

export const PAID_PLANS = ["pro", "premium"];
export const INTERVALS = ["month", "year"];

// Stripe price lookup keys, e.g. pitchside_pro_year.
export const lookupKey = (plan, interval) => `pitchside_${plan}_${interval}`;

export function parseLookupKey(key) {
  const m = /^pitchside_(pro|premium)_(month|year)$/.exec(key || "");
  return m ? { plan: m[1], interval: m[2] } : null;
}

export const planFor = name => PLANS[name] || PLANS.free;
