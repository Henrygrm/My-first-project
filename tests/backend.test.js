// Backend tests with in-memory stand-ins for Supabase, Stripe and Claude (no real accounts needed).
//   npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Stripe from "stripe";

/* ---------- fake Claude API ---------- */
const aiRequests = [];
const aiServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    aiRequests.push(body);
    const day = (d, rest) => ({ day: d, focus: rest ? "Rest" : "Shooting", icon: "🥅", rest, rotating: false,
      minutes: rest ? 0 : 30, why: rest ? "" : "Test", drills: [{ name: "Drill", detail: "Do it", minutes: rest ? 0 : 30 }] });
    const props = body.output_config?.format?.schema?.properties || {};
    const meal = slot => ({ slot, time: "7:30", food: "Porridge" });
    const text = props.tips ? JSON.stringify({ tips: ["Drink more water", "Great breakfasts"] })
      : props.waterTarget ? JSON.stringify({ waterTarget: 8, notes: ["Portion guide"], days: { training: [meal("Breakfast")], rest: [meal("Breakfast")], match: [meal("Breakfast")] } })
      : body.output_config?.format ? JSON.stringify({ days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d, i) => day(d, i % 2 === 1)) })
      : "Test reply";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});

/* ---------- fake Supabase (just the query-builder calls the app uses) ---------- */
function fakeSupabase() {
  const tables = { profiles: [], usage_events: [], saved_plans: [] };
  const users = { "token-ana": { id: "u-ana", email: "ana@example.com" } };
  let nextId = 1;
  const query = (table) => {
    let rows = () => tables[table];
    let op = "select", payload = null, head = false, single = null;
    const filters = [];
    let order = null, limit = null;
    const run = () => {
      let match = rows().filter(r => filters.every(f => f(r)));
      if (op === "insert" || op === "upsert") {
        const row = { id: payload.id ?? `id-${nextId++}`, created_at: new Date().toISOString(), plan: table === "profiles" ? "free" : undefined, ...payload };
        const existing = op === "upsert" && tables[table].find(r => r.id === row.id);
        if (existing) Object.assign(existing, payload); else tables[table].push(row);
        match = [existing || row];
      } else if (op === "update") {
        match.forEach(r => Object.assign(r, payload));
      } else if (op === "delete") {
        tables[table] = tables[table].filter(r => !match.includes(r));
      }
      if (order) match = [...match].sort((a, b) => (a[order.col] < b[order.col] ? 1 : -1) * (order.asc ? -1 : 1));
      if (limit) match = match.slice(0, limit);
      if (head) return { data: null, count: match.length, error: null };
      if (single) return { data: match[0] ?? null, error: single === "single" && !match[0] ? { message: "none" } : null };
      return { data: match, error: null };
    };
    const b = {
      select(_cols, opts) { if (opts?.head) head = true; return b; },
      insert(row) { op = "insert"; payload = row; return b; },
      upsert(row) { op = "upsert"; payload = row; return b; },
      update(fields) { op = "update"; payload = fields; return b; },
      delete() { op = "delete"; return b; },
      eq(col, v) { filters.push(r => r[col] === v); return b; },
      gte(col, v) { filters.push(r => r[col] >= v); return b; },
      order(col, o) { order = { col, asc: o?.ascending }; return b; },
      limit(n) { limit = n; return b; },
      maybeSingle() { single = "maybe"; return b; },
      single() { single = "single"; return b; },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } }
    };
    return b;
  };
  return {
    tables,
    auth: { getUser: async token => (users[token] ? { data: { user: users[token] }, error: null } : { data: { user: null }, error: { message: "bad jwt" } }) },
    from: query
  };
}

/* ---------- fake Stripe (real webhook signing, fake API calls) ---------- */
const realStripe = new Stripe("sk_test_fake");
function fakeStripe() {
  const calls = [];
  return {
    calls,
    webhooks: realStripe.webhooks,
    prices: { list: async ({ lookup_keys }) => ({ data: [{ id: `price_${lookup_keys[0]}`, lookup_key: lookup_keys[0] }] }) },
    customers: { create: async (p) => { calls.push(["customer", p]); return { id: "cus_1" }; } },
    checkout: { sessions: { create: async (p) => { calls.push(["checkout", p]); return { url: "https://checkout.stripe.test/s1" }; } } },
    billingPortal: { sessions: { create: async (p) => { calls.push(["portal", p]); return { url: "https://billing.stripe.test/p1" }; } } },
    subscriptions: { retrieve: async (id) => subscription(id, "pitchside_pro_year", "trialing") }
  };
}
const subscription = (id, key, status, extra = {}) => ({
  id, object: "subscription", customer: "cus_1", status, metadata: { user_id: "u-ana" }, cancel_at_period_end: false,
  items: { data: [{ price: { lookup_key: key }, current_period_end: 1893456000 }] }, ...extra
});

/* ---------- helpers ---------- */
let db, stripe, api;
const req = (path, { method = "GET", token, body, headers = {} } = {}) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });
const call = async (name, method, opts) => {
  const res = await api[name][method](req(`/api/${name}`, { method, ...opts }));
  return { status: res.status, body: await res.json() };
};
const webhook = async (event) => {
  const payload = JSON.stringify(event);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const res = await api["stripe-webhook"].POST(req("/api/stripe-webhook", { method: "POST", body: payload, headers: { "stripe-signature": header } }));
  return res.status;
};
const ask = token => call("chat", "POST", { token, body: { messages: [{ role: "user", content: "How do I shoot?" }] } });
const askDiet = (token, action = "plan") => call("diet", "POST", { token, body: { action, input: { diet: "vegan", avoid: "nuts", goal: "energy", ageGroup: "14-17", logs: { a: { water: 3 }, b: { water: 5 } } } } });
const askPlan = token => call("plan", "POST", { token, body: { profile: { position: "Striker", ageGroup: "14-17", foot: "Right", equipment: ["ball"], daysPerWeek: "3 days", sessionTime: "45 min", weaknesses: "left foot", goal: "goals" } } });

before(async () => {
  await new Promise(r => aiServer.listen(0, r));
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: `http://localhost:${aiServer.address().port}`,
    SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
    STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_test", SITE_URL: "https://pitchside.test"
  });
  const supa = await import("../lib/supabase.js");
  const billing = await import("../lib/billing.js");
  db = fakeSupabase(); supa._setAdminForTests(db);
  stripe = fakeStripe(); billing._setStripeForTests(stripe);
  api = {};
  for (const name of ["config", "me", "chat", "plan", "plans", "diet", "checkout", "portal", "stripe-webhook"]) api[name] = await import(`../api/${name}.js`);
});
after(() => aiServer.close());

/* ---------- tests ---------- */
test("config reports everything switched on, without secret keys", async () => {
  const { body } = await call("config", "GET");
  assert.deepEqual(body, { ai: true, auth: { url: "https://x.supabase.co", anonKey: "anon" }, payments: true });
});

test("AI needs an account", async () => {
  assert.equal((await ask(null)).status, 401);
  assert.equal((await ask("forged-token")).status, 401);
  assert.equal((await askPlan(null)).status, 401);
});

test("Free plan: 3 questions a day, 1 plan a month with drill names only, no saved plans or diet", async () => {
  for (let i = 0; i < 3; i++) {
    const r = await ask("token-ana");
    assert.equal(r.status, 200);
    assert.equal(r.body.left, 2 - i);
  }
  const blocked = await ask("token-ana");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.upgrade, true);
  assert.match(blocked.body.error, /3 free questions for today.*Pro for 30 a day/);

  const plan = await askPlan("token-ana");
  assert.equal(plan.status, 200);
  assert.equal(plan.body.left, 0);
  const training = plan.body.plan.find(d => !d.rest);
  assert.equal(training.drills[0].detail, "");  // names only on Free
  const second = await askPlan("token-ana");
  assert.equal(second.status, 429);
  assert.match(second.body.error, /free training plan for this month/);
  assert.equal(db.tables.saved_plans.length, 0);
  assert.equal((await call("plans", "GET", { token: "token-ana" })).status, 403);

  const diet = await askDiet("token-ana");
  assert.equal(diet.status, 403);
  assert.equal(diet.body.upgrade, true);

  const me = await call("me", "GET", { token: "token-ana" });
  assert.equal(me.body.plan, "free");
  assert.equal(me.body.name, "ana");
  assert.deepEqual(me.body.left, { question: 0, plan: 0 });
  assert.ok(new Date(me.body.resets.plan) > new Date());
});

test("Checkout: yearly Pro, no trial, linked to the account", async () => {
  const r = await call("checkout", "POST", { token: "token-ana", body: { plan: "pro", interval: "year" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.url, "https://checkout.stripe.test/s1");
  const [, params] = stripe.calls.find(c => c[0] === "checkout");
  assert.equal(params.line_items[0].price, "price_pitchside_pro_year");
  assert.equal(params.subscription_data.trial_period_days, undefined);
  assert.equal(params.client_reference_id, "u-ana");
  assert.equal(params.success_url, "https://pitchside.test/?checkout=success#pricing");
  assert.equal(db.tables.profiles[0].stripe_customer_id, "cus_1");

  const bad = await call("checkout", "POST", { token: "token-ana", body: { plan: "gold", interval: "year" } });
  assert.equal(bad.status, 400);
});

test("Yearly prices are 15% off", async () => {
  const { PLANS } = await import("../lib/plans.js");
  assert.deepEqual(PLANS.pro.prices, { month: 10, year: 102 });
  assert.deepEqual(PLANS.premium.prices, { month: 22, year: 224.4 });
});

test("Webhook: rejects bad signatures, upgrades on checkout and starts a fresh allowance", async () => {
  const res = await api["stripe-webhook"].POST(req("/api/stripe-webhook", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=bad" } }));
  assert.equal(res.status, 400);
  assert.equal(db.tables.profiles[0].plan, "free");

  const status = await webhook({ id: "evt_1", object: "event", type: "checkout.session.completed",
    data: { object: { object: "checkout.session", mode: "subscription", subscription: "sub_1" } } });
  assert.equal(status, 200);
  const p = db.tables.profiles[0];
  assert.equal(p.plan, "pro");
  assert.equal(p.billing_interval, "year");
  assert.ok(p.plan_changed_at);
  assert.equal(p.current_period_end, new Date(1893456000 * 1000).toISOString());
});

test("Pro: 30 questions a day, 1 plan a week with full details, saved plans; already subscribed goes to the portal", async () => {
  await new Promise(r => setTimeout(r, 5)); // make sure new uses come after the plan change
  const me = await call("me", "GET", { token: "token-ana" });
  assert.equal(me.body.plan, "pro");
  assert.deepEqual(me.body.left, { question: 30, plan: 1 }); // fresh allowance after upgrading
  assert.equal((await ask("token-ana")).body.left, 29);
  const plan = await askPlan("token-ana");
  assert.equal(plan.status, 200);
  assert.equal(plan.body.plan.find(d => !d.rest).drills[0].detail, "Do it");
  assert.ok(plan.body.savedId);
  assert.equal((await askPlan("token-ana")).status, 429);
  const saved = await call("plans", "GET", { token: "token-ana" });
  assert.equal(saved.body.plans.length, 1);
  assert.equal((await askDiet("token-ana")).status, 403);

  const again = await call("checkout", "POST", { token: "token-ana", body: { plan: "premium", interval: "month" } });
  assert.equal(again.body.url, "https://billing.stripe.test/p1");
  assert.equal((await call("portal", "POST", { token: "token-ana" })).body.url, "https://billing.stripe.test/p1");
});

test("Premium: unlimited questions and plans, and the AI diet tracker", async () => {
  await webhook({ id: "evt_2", object: "event", type: "customer.subscription.updated", data: { object: subscription("sub_1", "pitchside_premium_month", "active") } });
  assert.equal(db.tables.profiles[0].plan, "premium");
  const me = await call("me", "GET", { token: "token-ana" });
  assert.deepEqual(me.body.left, { question: null, plan: null });

  aiRequests.length = 0;
  assert.equal((await ask("token-ana")).body.left, null);
  assert.equal((await askPlan("token-ana")).status, 200);
  assert.equal((await askPlan("token-ana")).status, 200); // no weekly limit
  const diet = await askDiet("token-ana");
  assert.equal(diet.status, 200);
  assert.equal(diet.body.plan.waterTarget, 8);
  const dietRequest = aiRequests.find(r => r.output_config?.format?.schema?.properties?.waterTarget);
  assert.match(dietRequest.messages[0].content, /Diet: vegan/);
  assert.match(dietRequest.system, /Never give calorie targets/);
  const feedback = await askDiet("token-ana", "feedback");
  assert.deepEqual(feedback.body.tips, ["Drink more water", "Great breakfasts"]);
  assert.equal(aiRequests[0].model, "claude-opus-5-5");
  assert.equal(aiRequests[0].fallbacks, "default");
});

test("Cancelled subscription drops back to Free", async () => {
  await webhook({ id: "evt_3", object: "event", type: "customer.subscription.deleted", data: { object: subscription("sub_1", "pitchside_premium_month", "canceled") } });
  const p = db.tables.profiles[0];
  assert.equal(p.plan, "free");
  assert.equal(p.billing_interval, null);
});

test("A failed AI call gives the use back", async () => {
  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = "http://localhost:1"; // nothing listening
  const { _resetClientForTests } = await import("../lib/coach-ai.js");
  _resetClientForTests();
  const before = db.tables.usage_events.filter(e => e.kind === "question").length;
  const r = await ask("token-ana");
  assert.equal(r.status, 502);
  assert.equal(db.tables.usage_events.filter(e => e.kind === "question").length, before);
  process.env.ANTHROPIC_BASE_URL = saved;
  _resetClientForTests();
});

test("The website page and the one-file app are the same", async () => {
  const fs = await import("node:fs");
  const site = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const bolt = fs.readFileSync(new URL("../football-coach-chatbot.html", import.meta.url), "utf8");
  assert.ok(site === bolt, "Run `npm run sync:bolt` after editing public/index.html");
});
