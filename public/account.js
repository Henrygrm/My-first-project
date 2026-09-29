/* ==========================================================================
   CoachAI – accounts, pricing and checkout
   --------------------------------------------------------------------------
   Live mode:  Supabase for sign-up/log-in, Stripe Checkout for payments.
   Demo mode:  when those aren't configured (or the page runs without the
               server), accounts and payments are simulated in this browser
               so you can click through the whole flow. Nothing is charged.
   ========================================================================== */
const PRICING = {
  free:    { name: "Free",    month: 0,  year: 0,   questions: 5,   plans: 1 },
  pro:     { name: "Pro",     month: 12, year: 99,  questions: 50,  plans: 7 },
  premium: { name: "Premium", month: 22, year: 179, questions: 300, plans: 30 }
};
const TRIAL_DAYS = 7;

const Account = (() => {
  let config = { ai: false, auth: null, payments: false };
  let sb = null;            // Supabase client (live accounts)
  let session = null;       // Supabase session
  let me = null;            // account details from /api/me (or the demo account)
  let demoAccounts = false; // simulate accounts in this browser
  let demoPayments = false; // simulate Stripe Checkout
  let billingInterval = "year";
  const listeners = new Set();
  const DEMO_KEY = "coachai-demo-account";
  const PENDING_KEY = "coachai-pending-checkout";

  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } },
    set(key, value) { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }
  };

  /* ---------- state ---------- */
  function demoMe(account) {
    const p = PRICING[account.plan] || PRICING.free;
    return {
      email: account.email, plan: account.plan, interval: account.interval || null,
      status: account.plan === "free" ? null : account.interval === "year" ? "trialing" : "active",
      limits: { question: p.questions, plan: p.plans },
      left: { question: p.questions, plan: p.plans },
      features: { savePlans: account.plan !== "free", rememberProfile: account.plan === "premium", elitePlans: account.plan === "premium" },
      hasBilling: account.plan !== "free",
      demo: true
    };
  }

  async function refresh() {
    if (demoAccounts) {
      const account = store.get(DEMO_KEY);
      me = account ? demoMe(account) : null;
    } else if (session) {
      try {
        const res = await fetch("/api/me", { headers: await authHeaders() });
        me = res.ok ? await res.json() : null;
      } catch (e) { me = null; }
    } else {
      me = null;
    }
    render();
    listeners.forEach(fn => fn(me));
    return me;
  }

  async function authHeaders() {
    if (!sb) return {};
    const { data } = await sb.auth.getSession();
    return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
  }

  /* ---------- auth modal ---------- */
  const modal = () => document.getElementById("auth-modal");
  let modalMode = "signup";
  let afterAuth = null;

  function openAuth(mode = "signup", then = null) {
    afterAuth = then;
    setMode(mode);
    modal().hidden = false;
    document.body.classList.add("modal-open");
    setTimeout(() => document.getElementById(mode === "reset" ? "auth-password" : "auth-email").focus(), 50);
  }

  function closeModals() {
    document.querySelectorAll(".modal").forEach(m => (m.hidden = true));
    document.body.classList.remove("modal-open");
  }

  function setMode(mode) {
    modalMode = mode;
    const copy = {
      signup: ["Create your free account", "Start with the Free plan – upgrade whenever you're ready.", "Create account"],
      login: ["Welcome back", "Log in to your CoachAI account.", "Log in"],
      forgot: ["Reset your password", "We'll email you a link to choose a new password.", "Send reset link"],
      reset: ["Choose a new password", "Enter a new password for your account.", "Save new password"]
    }[mode];
    document.getElementById("auth-title").textContent = copy[0];
    document.getElementById("auth-sub").textContent = copy[1];
    document.getElementById("auth-submit").textContent = copy[2];
    document.getElementById("auth-email-row").hidden = mode === "reset";
    document.getElementById("auth-password-row").hidden = mode === "forgot";
    document.getElementById("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
    document.getElementById("auth-forgot").hidden = mode !== "login";
    document.getElementById("auth-switch").innerHTML =
      mode === "signup" ? `Already have an account? <button type="button" data-auth-mode="login">Log in</button>`
      : mode === "login" ? `New to CoachAI? <button type="button" data-auth-mode="signup">Create a free account</button>`
      : `<button type="button" data-auth-mode="login">Back to log in</button>`;
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.toggle("active", t.dataset.authMode === mode));
    document.querySelector(".auth-tabs").hidden = mode === "forgot" || mode === "reset";
    document.getElementById("auth-demo-note").hidden = !demoAccounts;
    showAuthMessage("");
  }

  function showAuthMessage(text, kind = "error") {
    const el = document.getElementById("auth-message");
    el.textContent = text;
    el.className = "auth-message " + kind;
    el.hidden = !text;
  }

  async function submitAuth() {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const button = document.getElementById("auth-submit");
    if (modalMode !== "reset" && !/^\S+@\S+\.\S+$/.test(email)) return showAuthMessage("Enter a valid email address.");
    if (modalMode !== "forgot" && password.length < 8) return showAuthMessage("Your password needs at least 8 characters.");

    button.disabled = true;
    try {
      if (demoAccounts) {
        if (modalMode === "forgot") return showAuthMessage("In demo mode there's no email to send. Just log in with any password.", "info");
        const existing = store.get(DEMO_KEY);
        store.set(DEMO_KEY, { email: email || existing?.email, plan: existing?.email === email ? existing.plan : "free", interval: existing?.email === email ? existing.interval : null });
        await refresh();
        return finishAuth(modalMode === "signup" ? "Account created – welcome to CoachAI! ⚽" : "You're logged in.");
      }
      if (modalMode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
        if (error) throw error;
        if (!data.session) return showAuthMessage(`Check ${email} for a link to confirm your account, then log in.`, "info");
        return finishAuth("Account created – welcome to CoachAI! ⚽");
      }
      if (modalMode === "login") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return finishAuth("You're logged in.");
      }
      if (modalMode === "forgot") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
        if (error) throw error;
        return showAuthMessage(`If ${email} has an account, a reset link is on its way.`, "info");
      }
      if (modalMode === "reset") {
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;
        return finishAuth("Password updated.");
      }
    } catch (err) {
      showAuthMessage(friendlyAuthError(err));
    } finally {
      button.disabled = false;
    }
  }

  function friendlyAuthError(err) {
    const msg = (err && err.message) || "";
    if (/invalid login credentials/i.test(msg)) return "That email and password don't match. Try again or reset your password.";
    if (/already registered|already exists/i.test(msg)) return "There's already an account with that email. Log in instead.";
    if (/email not confirmed/i.test(msg)) return "Confirm your email first – check your inbox for the link.";
    if (/rate limit|too many/i.test(msg)) return "Too many attempts. Wait a minute and try again.";
    return msg || "Something went wrong. Please try again.";
  }

  async function finishAuth(message) {
    closeModals();
    document.getElementById("auth-password").value = "";
    await refresh();
    toast(message);
    const next = afterAuth || store.get(PENDING_KEY);
    afterAuth = null;
    store.set(PENDING_KEY, null);
    if (next && next.plan) startCheckout(next.plan, next.interval);
  }

  async function signOut() {
    if (demoAccounts) store.set(DEMO_KEY, null);
    else if (sb) await sb.auth.signOut();
    session = null;
    closeMenu();
    await refresh();
    toast("You're logged out.");
  }

  /* ---------- checkout & billing ---------- */
  async function startCheckout(plan, interval = billingInterval) {
    if (!me) {
      store.set(PENDING_KEY, { plan, interval });
      return openAuth("signup", { plan, interval });
    }
    if (demoPayments) return openDemoCheckout(plan, interval);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ plan, interval })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      location.href = data.url;
    } catch (err) {
      toast(err.message || "Couldn't start checkout. Please try again.", "error");
    }
  }

  async function manageBilling() {
    closeMenu();
    if (demoPayments) return openDemoCheckout(null);
    try {
      const res = await fetch("/api/portal", { method: "POST", headers: await authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      location.href = data.url;
    } catch (err) {
      toast(err.message || "Couldn't open billing. Please try again.", "error");
    }
  }

  // Demo stand-in for Stripe Checkout / the billing portal.
  function openDemoCheckout(plan, interval) {
    const box = document.getElementById("checkout-modal");
    const body = document.getElementById("checkout-body");
    if (plan) {
      const p = PRICING[plan];
      const price = interval === "year" ? `$${p.year} / year` : `$${p.month} / month`;
      body.innerHTML = `
        <p class="checkout-line"><span>CoachAI ${p.name} · ${interval === "year" ? "yearly" : "monthly"}</span><strong>${price}</strong></p>
        ${interval === "year" ? `<p class="checkout-line deal"><span>🎁 ${TRIAL_DAYS}-day free trial</span><strong>$0 today</strong></p>
        <p class="checkout-line deal"><span>Yearly saving</span><strong>−$${p.month * 12 - p.year}</strong></p>` : ""}
        <p class="checkout-note">On the live site this is Stripe's secure checkout page, where the player enters their card.</p>
        <button type="button" class="btn btn-primary btn-block" id="demo-pay">Simulate successful payment</button>`;
      body.querySelector("#demo-pay").addEventListener("click", async () => {
        const account = store.get(DEMO_KEY);
        store.set(DEMO_KEY, { ...account, plan, interval });
        closeModals();
        await refresh();
        toast(`Welcome to ${p.name}! 🎉 Your new limits are live.`);
      });
    } else {
      const current = me ? PRICING[me.plan] : PRICING.free;
      body.innerHTML = `
        <p class="checkout-line"><span>Current plan</span><strong>${current.name}${me?.interval ? (me.interval === "year" ? " · yearly" : " · monthly") : ""}</strong></p>
        <p class="checkout-note">On the live site this opens Stripe's billing page to change plan, update the card, see invoices or cancel.</p>
        <button type="button" class="btn btn-ghost btn-block" id="demo-cancel">Simulate cancelling (back to Free)</button>`;
      body.querySelector("#demo-cancel").addEventListener("click", async () => {
        const account = store.get(DEMO_KEY);
        store.set(DEMO_KEY, { ...account, plan: "free", interval: null });
        closeModals();
        await refresh();
        toast("Subscription cancelled – you're on the Free plan.");
      });
    }
    document.getElementById("checkout-title").textContent = plan ? "Demo checkout" : "Demo billing";
    box.hidden = false;
    document.body.classList.add("modal-open");
  }

  // Coming back from Stripe: ?checkout=success|cancelled
  async function handleCheckoutReturn() {
    const params = new URLSearchParams(location.search);
    const result = params.get("checkout");
    if (!result) return;
    history.replaceState(null, "", location.pathname + location.hash);
    if (result === "cancelled") return toast("Checkout cancelled – you haven't been charged.");
    toast("Payment complete – activating your plan…");
    // Stripe tells our server via webhook; check a few times until the plan updates.
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const account = await refresh();
      if (account && account.plan !== "free") return toast(`Welcome to ${PRICING[account.plan].name}! 🎉`);
    }
    toast("Your payment went through. Your plan will update in a moment – refresh if it doesn't.");
  }

  /* ---------- rendering ---------- */
  const menu = () => document.getElementById("account-menu");
  function closeMenu() { if (menu()) menu().hidden = true; document.getElementById("account-button")?.setAttribute("aria-expanded", "false"); }

  function render() {
    const signedIn = Boolean(me);
    document.getElementById("nav-guest").hidden = signedIn;
    document.getElementById("nav-user").hidden = !signedIn;
    if (signedIn) {
      const plan = PRICING[me.plan] || PRICING.free;
      document.getElementById("account-email").textContent = me.email;
      document.getElementById("account-initial").textContent = (me.email || "?")[0].toUpperCase();
      document.querySelectorAll("[data-plan-pill]").forEach(el => { el.textContent = plan.name; el.dataset.plan = me.plan; });
      document.getElementById("menu-plan").textContent =
        `${plan.name} plan${me.interval ? (me.interval === "year" ? " · yearly" : " · monthly") : ""}${me.status === "trialing" ? " · free trial" : ""}${me.cancelAtPeriodEnd ? " · ends soon" : ""}`;
      document.getElementById("menu-usage").textContent =
        `${me.left.question} of ${me.limits.question} coach questions left today · ${me.left.plan} of ${me.limits.plan} AI plans left this week`;
      document.getElementById("menu-upgrade").hidden = me.plan === "premium";
      document.getElementById("menu-upgrade").textContent = me.plan === "free" ? "Upgrade plan" : "Upgrade to Premium";
      document.getElementById("menu-billing").hidden = !me.hasBilling;
      document.getElementById("menu-demo").hidden = !me.demo;
    }
    renderPricing();
  }

  function renderPricing() {
    document.querySelectorAll(".billing-option").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.interval === billingInterval)));
    document.getElementById("pricing").dataset.interval = billingInterval;
    document.querySelectorAll(".price-card[data-plan]").forEach(card => {
      const key = card.dataset.plan;
      const p = PRICING[key];
      const amount = card.querySelector(".price-amount");
      const note = card.querySelector(".price-note");
      if (key === "free") {
        amount.textContent = "$0";
        note.textContent = "Free forever";
      } else if (billingInterval === "year") {
        amount.textContent = `$${p.year}`;
        note.innerHTML = `per year · just $${(p.year / 12).toFixed(2)}/month<br><strong>Save $${p.month * 12 - p.year}</strong> + ${TRIAL_DAYS}-day free trial`;
      } else {
        amount.textContent = `$${p.month}`;
        note.innerHTML = `per month · billed monthly<br>Cancel anytime`;
      }
      card.querySelector(".price-period").textContent = key === "free" ? "/month" : billingInterval === "year" ? "/year" : "/month";

      const button = card.querySelector("[data-plan-cta]");
      const current = me && me.plan === key && (key === "free" || me.interval === billingInterval);
      button.disabled = false;
      button.classList.toggle("is-current", Boolean(current));
      if (!me) {
        button.textContent = key === "free" ? "Sign up free" : `Get ${p.name}`;
      } else if (current) {
        button.textContent = key === "free" ? "Your current plan" : "Manage subscription";
        button.disabled = key === "free";
      } else if (key === "free") {
        button.textContent = "Manage subscription";
      } else if (me.plan === key) {
        button.textContent = billingInterval === "year" ? "Switch to yearly" : "Switch to monthly";
      } else {
        const rank = { free: 0, pro: 1, premium: 2 };
        button.textContent = rank[key] > rank[me.plan] ? `Upgrade to ${p.name}` : `Switch to ${p.name}`;
      }
    });
  }

  function onPlanButton(key) {
    const current = me && me.plan === key && (key === "free" || me.interval === billingInterval);
    if (!me) return key === "free" ? openAuth("signup") : startCheckout(key, billingInterval);
    if (key === "free" || current) return manageBilling();
    return startCheckout(key, billingInterval);
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(message, kind = "ok") {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.className = "toast " + kind;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  /* ---------- wiring ---------- */
  function wire() {
    document.addEventListener("click", e => {
      const t = e.target.closest("[data-auth-open], [data-auth-mode], [data-close-modal], [data-plan-cta], .billing-option, #account-button, #menu-signout, #menu-billing, #menu-upgrade");
      if (!t) {
        if (menu() && !menu().hidden && !e.target.closest("#nav-user")) closeMenu();
        return;
      }
      if (t.dataset.authOpen) openAuth(t.dataset.authOpen);
      else if (t.dataset.authMode) setMode(t.dataset.authMode);
      else if (t.hasAttribute("data-close-modal")) closeModals();
      else if (t.dataset.planCta) onPlanButton(t.dataset.planCta);
      else if (t.classList.contains("billing-option")) { billingInterval = t.dataset.interval; renderPricing(); }
      else if (t.id === "account-button") {
        const open = menu().hidden;
        menu().hidden = !open;
        t.setAttribute("aria-expanded", String(open));
      }
      else if (t.id === "menu-signout") signOut();
      else if (t.id === "menu-billing") manageBilling();
      else if (t.id === "menu-upgrade") { closeMenu(); document.getElementById("pricing").scrollIntoView({ behavior: "smooth" }); }
    });
    document.getElementById("auth-form").addEventListener("submit", e => { e.preventDefault(); submitAuth(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") { closeModals(); closeMenu(); } });
    document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m) closeModals(); }));
  }

  async function init() {
    wire();
    try {
      const res = await fetch("/api/config");
      if (res.ok) config = await res.json();
    } catch (e) { /* no server: demo mode */ }

    if (config.auth && window.supabase) {
      sb = window.supabase.createClient(config.auth.url, config.auth.anonKey);
      const { data } = await sb.auth.getSession();
      session = data.session;
      sb.auth.onAuthStateChange((event, s) => {
        session = s;
        if (event === "PASSWORD_RECOVERY") openAuth("reset");
        if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") refresh();
      });
    } else {
      demoAccounts = true;
    }
    demoPayments = demoAccounts || !config.payments;
    document.body.classList.toggle("demo-accounts", demoAccounts);
    await refresh();
    handleCheckoutReturn();
  }

  const ready = init();

  return {
    ready,
    get config() { return config; },
    get me() { return me; },
    get demo() { return demoAccounts; },
    // True when the server needs a signed-in player before using the AI.
    needsLogin: () => Boolean(config.auth) && !session,
    authHeaders,
    openAuth,
    startCheckout,
    manageBilling,
    refresh,
    toast,
    onChange: fn => listeners.add(fn),
    // Update the "left" counters after an AI call without another round trip.
    setLeft(kind, left) {
      if (me && typeof left === "number") { me.left[kind] = left; render(); listeners.forEach(fn => fn(me)); }
    }
  };
})();
