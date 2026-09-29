// Subscription tiers. The server enforces these limits – the browser only displays them.
// Prices live in Stripe (see scripts/setup-stripe.js); these are the display copies.
export const PLANS = {
  free: {
    name: "Free",
    questionsPerDay: 5,
    plansPerWeek: 1,
    savePlans: false,
    rememberProfile: false,
    elitePlans: false
  },
  pro: {
    name: "Pro",
    questionsPerDay: 50,
    plansPerWeek: 7,
    savePlans: true,
    rememberProfile: false,
    elitePlans: false,
    prices: { month: 12, year: 99 }
  },
  premium: {
    name: "Premium",
    questionsPerDay: 300,  // "unlimited" with a fair-use cap
    plansPerWeek: 30,
    savePlans: true,
    rememberProfile: true,
    elitePlans: true,
    prices: { month: 22, year: 179 }
  }
};

export const PAID_PLANS = ["pro", "premium"];
export const INTERVALS = ["month", "year"];
export const YEARLY_TRIAL_DAYS = 7;

// Stripe price lookup keys, e.g. pitchside_pro_year.
export const lookupKey = (plan, interval) => `pitchside_${plan}_${interval}`;

export function parseLookupKey(key) {
  const m = /^pitchside_(pro|premium)_(month|year)$/.exec(key || "");
  return m ? { plan: m[1], interval: m[2] } : null;
}

export const planFor = name => PLANS[name] || PLANS.free;
