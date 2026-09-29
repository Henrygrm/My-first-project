/* ==========================================================================
   Pitchside Coaching AI – front-end app
   --------------------------------------------------------------------------
   🔌 AI CONNECTION
   The page talks to our own backend (/api/chat and /api/plan), which calls
   Claude with the secret API key kept safely on the server – never in here.
   The server also checks the player's account and plan limits (account.js
   adds the login token to each request).
   If the backend isn't set up yet (no API key, or the page is opened as a
   plain file), the site automatically falls back to the built-in demo coach.
   ========================================================================== */
const API_TIMEOUT_MS = 65000;
let aiMode = "checking";          // "live" (Claude) or "demo" (built-in answers)
let lastPlanSource = "builtin";   // who made the most recent plan: "ai" or "builtin"
let lastPlanElite = false;        // Premium "elite" plan

async function postJSON(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await Account.authHeaders()) },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "Request failed: " + res.status);
      Object.assign(err, { status: res.status, demo: Boolean(data.demo), needLogin: Boolean(data.needLogin), upgrade: Boolean(data.upgrade) });
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function detectAiMode() {
  await Account.ready;
  aiMode = Account.config.ai ? "live" : "demo";
  updateAiStatus();
}

// Status line under "Pitchside Coach": live/demo, and what's left on the player's plan.
function updateAiStatus() {
  const el = document.getElementById("coach-status");
  if (!el) return;
  const me = Account.me;
  let text;
  if (aiMode !== "live") text = "Demo mode · example answers";
  else if (Account.needsLogin()) text = "Online · sign up free to use your AI coach";
  else if (me && me.limits) text = `${PRICING[me.plan].name} · ${me.left.question} questions left today · ${me.left.plan} plans left this week`;
  else text = "Online · powered by Claude";
  el.textContent = text;
  el.classList.toggle("demo", aiMode !== "live");
  const saved = document.getElementById("saved-plans-btn");
  if (saved) saved.hidden = !(me && me.features && me.features.savePlans && !me.demo && aiMode === "live");
}
Account.onChange(updateAiStatus);

// A coach message with buttons, e.g. "Sign up free" or "See plans".
function addActionMessage(container, text, actions) {
  const msg = addMessage(container, "bot", text);
  const row = document.createElement("div");
  row.className = "fc-actions";
  actions.forEach(a => row.appendChild(makeChip(a.label, a.onClick, a.primary)));
  msg.querySelector(".fc-bubble").appendChild(row);
  container.scrollTop = container.scrollHeight;
  return msg;
}

const seePlans = { label: "See plans", primary: true, onClick: () => document.getElementById("pricing").scrollIntoView({ behavior: "smooth" }) };
const signUpActions = [
  { label: "Sign up free", primary: true, onClick: () => Account.openAuth("signup") },
  { label: "Log in", onClick: () => Account.openAuth("login") }
];

/** Tab 2: returns the coach's answer. `history` is [{ role, content }]. */
async function getCoachReply(question, history) {
  if (aiMode === "checking") await detectAiMode();
  if (aiMode === "live") {
    try {
      const data = await postJSON("/api/chat", { messages: history });
      Account.setLeft("question", data.left);
      return data.reply;
    } catch (err) {
      if (!err.demo) throw err; // needLogin / upgrade / real errors are shown by the chat
      aiMode = "demo";
      updateAiStatus();
    }
  }
  await wait(700 + Math.random() * 600); // pretend the demo coach is "thinking"
  return fakeCoachReply(question);
}

/** Tab 1: returns a 7-day plan: [{ day, focus, icon, rest, rotating, minutes, why, drills: [{ name, detail, minutes }] }]. */
async function getTrainingPlan(profile) {
  if (aiMode === "checking") await detectAiMode();
  lastPlanElite = false;
  if (aiMode === "live") {
    try {
      const data = await postJSON("/api/plan", { profile });
      if (Array.isArray(data.plan) && data.plan.length === 7) {
        Account.setLeft("plan", data.left);
        lastPlanSource = "ai";
        lastPlanElite = Boolean(data.elite);
        return data.plan;
      }
    } catch (err) {
      if (err.demo) {
        aiMode = "demo";
        updateAiStatus();
      } else if (err.needLogin) {
        addActionMessage(plannerMsgs, "Here's a plan from our built-in planner. Create a free account to get plans written by your AI coach. 👇", signUpActions);
      } else if (err.upgrade) {
        addActionMessage(plannerMsgs, `${err.message} Here's a plan from our built-in planner for now. 👇`, [seePlans]);
      } else {
        console.warn("AI plan failed, using the built-in planner:", err);
        addMessage(plannerMsgs, "bot", "The AI coach is busy right now, so here's a plan from our built-in planner instead. 👇");
      }
    }
  } else {
    await wait(1200);
  }
  lastPlanSource = "builtin";
  return fakeTrainingPlan(profile);
}

// Pro & Premium: list saved plans and open one.
async function showSavedPlans() {
  try {
    const res = await fetch("/api/plans", { headers: await Account.authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (!data.plans.length) return addMessage(plannerMsgs, "bot", "You haven't saved any plans yet. Every AI plan you make is saved here automatically.");
    addActionMessage(plannerMsgs, "Your saved plans – tap one to open it:", data.plans.map(saved => ({
      label: `${new Date(saved.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${saved.answers.position || "Plan"} · ${saved.answers.daysPerWeek || ""}`,
      onClick: () => { lastPlanSource = "ai"; lastPlanElite = false; renderPlan(saved.plan, saved.answers); }
    })));
  } catch (err) {
    addMessage(plannerMsgs, "bot", err.message || "Couldn't load your saved plans.");
  }
}

/* ==========================================================================
   BUILT-IN PLANNER + DEMO COACH (used when the AI isn't connected)
   ========================================================================== */
// Equipment keys used by the questions and the drill library.
const EQUIPMENT = [
  { key: "ball",    label: "⚽ Ball",               words: ["ball"] },
  { key: "cones",   label: "🔶 Cones",              words: ["cone", "marker"] },
  { key: "goal",    label: "🥅 Goal",               words: ["goal", "net"] },
  { key: "wall",    label: "🧱 Wall",               words: ["wall", "rebound"] },
  { key: "partner", label: "🧑‍🤝‍🧑 A friend to train with", words: ["friend", "partner", "mate", "brother", "sister", "dad", "mum", "mom", "someone", "teammate"] },
  { key: "space",   label: "🏟️ Pitch or park",      words: ["pitch", "park", "field", "space", "grass"] }
];

// Every drill: name, detail, default minutes, and the equipment it needs.
// {weak} is replaced with the player's weaker foot.
const DRILLS = {
  ballMastery: [
    { name: "Toe taps & sole rolls", detail: "3 × 1 min as fast as you can, then 1 min slow & perfect", min: 6, needs: ["ball"] },
    { name: "Juggling challenge", detail: "Try to beat your record – count every set", min: 8, needs: ["ball"] },
    { name: "Cone box touches", detail: "Keep the ball inside a 4-cone box using inside/outside touches", min: 8, needs: ["ball", "cones"] },
    { name: "Inside–outside rolls", detail: "Roll, drag & push with both feet, 5 × 1 min", min: 6, needs: ["ball"] }
  ],
  passing: [
    { name: "Wall passes", detail: "50 with each foot, two-touch", min: 10, needs: ["ball", "wall"] },
    { name: "One-touch wall passing", detail: "Alternate feet, 3 × 2 min", min: 8, needs: ["ball", "wall"] },
    { name: "Passing through gates", detail: "Pass to your partner through cone gates 5 m apart", min: 10, needs: ["ball", "partner", "cones"] },
    { name: "Partner passing", detail: "Two-touch passing at 10 m, then 15 m – 50 each foot", min: 10, needs: ["ball", "partner"] },
    { name: "Long passing", detail: "20 driven passes to a partner 25 m away", min: 10, needs: ["ball", "partner", "space"] },
    { name: "Target passing", detail: "Pass at a target (a bag or tree) from 10 m – 20 each foot", min: 8, needs: ["ball"] }
  ],
  firstTouch: [
    { name: "Wall control", detail: "Trap with inside, outside, sole & thigh", min: 8, needs: ["ball", "wall"] },
    { name: "High-ball control", detail: "Throw it up and cushion it dead – 20 reps", min: 6, needs: ["ball"] },
    { name: "Partner throw & control", detail: "Partner throws, you control and pass back – 20 reps", min: 8, needs: ["ball", "partner"] },
    { name: "Touch away from pressure", detail: "First touch into space to the left/right, 20 reps", min: 6, needs: ["ball", "wall"] }
  ],
  shooting: [
    { name: "Target shooting", detail: "20 shots aimed at the corners", min: 10, needs: ["ball", "goal"] },
    { name: "First-time finishing", detail: "Partner rolls the ball in – shoot first time, 15 reps", min: 10, needs: ["ball", "goal", "partner"] },
    { name: "Volleys & half-volleys", detail: "10 with each foot", min: 8, needs: ["ball", "goal"] },
    { name: "Wall target shooting", detail: "Hit a marked spot on the wall – 20 shots", min: 8, needs: ["ball", "wall"] },
    { name: "Mini-goal shooting", detail: "Use two bottles or jumpers as posts, 12 m out – 20 shots", min: 8, needs: ["ball"] }
  ],
  dribbling: [
    { name: "Cone slalom", detail: "6 runs, using both feet", min: 8, needs: ["ball", "cones"] },
    { name: "1v1 moves", detail: "Step-over, drag-back & scissors – 10 each", min: 8, needs: ["ball"] },
    { name: "1v1 vs a friend", detail: "Beat your partner to a line – 6 rounds each", min: 10, needs: ["ball", "partner"] },
    { name: "Speed dribble", detail: "6 × 20 m, touching the ball every step", min: 6, needs: ["ball", "space"] }
  ],
  speed: [
    { name: "Quick feet", detail: "Fast feet on the spot, 6 × 15 s with 45 s rest", min: 5, needs: [] },
    { name: "Falling starts", detail: "Lean forward until you fall, then sprint 10 m – 8 reps, walk back", min: 6, needs: [] },
    { name: "Reaction starts", detail: "Sprint 10 m on your partner's clap – 8 reps", min: 8, needs: ["partner"] },
    { name: "Acceleration sprints", detail: "8 × 20 m at full speed, full rest between", min: 8, needs: ["space"] },
    { name: "Zig-zag agility", detail: "Cut in and out of 5 cones, 6 reps", min: 8, needs: ["cones"] }
  ],
  fitness: [
    { name: "Interval runs", detail: "8 × (1 min fast, 1 min jog)", min: 16, needs: ["space"] },
    { name: "Box-to-box shuttles", detail: "6 × 40 m with 30 s rest", min: 12, needs: ["space"] },
    { name: "Football circuit", detail: "3 rounds of 30 s on / 30 s off: burpees, jump squats, mountain climbers", min: 10, needs: [] },
    { name: "Ball-work intervals", detail: "30 s fast dribbling, 30 s rest × 10", min: 10, needs: ["ball"] }
  ],
  strength: [
    { name: "Bodyweight circuit", detail: "3 × (10 squats, 10 lunges each leg, 20 s plank)", min: 12, needs: [] },
    { name: "Single-leg balance & hops", detail: "3 × 30 s each leg", min: 6, needs: [] },
    { name: "Core strength", detail: "Side planks & dead bugs – 3 rounds", min: 8, needs: [] }
  ],
  gameIQ: [
    { name: "Scanning drill", detail: "Check over your shoulder before every touch – 5 min", min: 6, needs: ["ball"] },
    { name: "Watch & learn", detail: "10 min of pro clips for your position – note their movement", min: 10, needs: [] },
    { name: "Visualisation", detail: "Picture yourself making 5 great plays in your next game", min: 5, needs: [] }
  ],
  weakFoot: [
    { name: "Weak-foot wall passes", detail: "100 touches with your {weak} foot only", min: 8, needs: ["ball", "wall"] },
    { name: "Weak-foot dribbling", detail: "Use only your {weak} foot, 3 × 2 min", min: 6, needs: ["ball"] },
    { name: "Weak-foot finishing", detail: "10 shots with your {weak} foot", min: 6, needs: ["ball", "goal"] }
  ],
  heading: [
    { name: "Self-throw headers", detail: "Toss it up & head at a target – 20 reps", min: 6, needs: ["ball"] },
    { name: "Partner headers", detail: "Partner throws, head it back to their hands – 20 reps", min: 8, needs: ["ball", "partner"] },
    { name: "Jump & head", detail: "3 × 8 jumping headers", min: 6, needs: ["ball"] }
  ],
  defending: [
    { name: "Jockeying footwork", detail: "Side-on shuffles, 4 × 1 min", min: 5, needs: [] },
    { name: "1v1 defending", detail: "Stop your partner getting past you – 6 rounds", min: 10, needs: ["ball", "partner"] },
    { name: "Recovery runs", detail: "Turn and sprint 15 m – 8 reps", min: 6, needs: [] }
  ],
  crossing: [
    { name: "Crossing to a target zone", detail: "15 crosses into a coned area", min: 10, needs: ["ball", "cones", "space"] },
    { name: "Wall crossing", detail: "Whip the ball at a high target – 15 each foot", min: 8, needs: ["ball", "wall"] },
    { name: "Crossing to a partner", detail: "15 crosses for your partner to finish", min: 10, needs: ["ball", "partner", "space"] }
  ],
  game: [
    { name: "1v1 / 2v2 game", detail: "First to 5 goals, use small goals or bottles", min: 15, needs: ["ball", "partner"] },
    { name: "Keep-ball", detail: "Keep the ball away from your partner in a small box", min: 8, needs: ["ball", "partner"] }
  ],
  light: [
    { name: "Easy ball touches", detail: "Slow, relaxed toe taps & rolls", min: 8, needs: ["ball"] },
    { name: "Mobility & stretching", detail: "Hips, hamstrings, calves & groin", min: 10, needs: [] },
    { name: "Easy jog or walk", detail: "Nice and relaxed – you should be able to chat", min: 8, needs: [] }
  ],
  Goalkeeper: [
    { name: "Wall reaction catches", detail: "Throw at the wall and catch the rebound, 3 × 2 min", min: 8, needs: ["ball", "wall"] },
    { name: "Handling – 'W' catch", detail: "Self-throws, catching with your hands in a W shape – 30 reps", min: 6, needs: ["ball"] },
    { name: "Set-position footwork", detail: "Shuffle across the goal line, set, spring – 6 reps", min: 6, needs: [] },
    { name: "Diving saves", detail: "Partner serves low & high – 10 each side (on soft ground)", min: 10, needs: ["ball", "partner"] },
    { name: "Shot stopping", detail: "Partner shoots from 12 m – 20 shots", min: 12, needs: ["ball", "partner", "goal"] },
    { name: "Distribution", detail: "15 throws + 15 kicks at a target", min: 10, needs: ["ball"] }
  ],
  Defender: [
    { name: "Jockeying & body shape", detail: "Side-on, on your toes – 4 × 1 min", min: 5, needs: [] },
    { name: "Heading clearances", detail: "Self-throw and head high & far – 20 reps", min: 6, needs: ["ball"] },
    { name: "1v1 defending", detail: "Stop your partner getting past you – 6 rounds", min: 10, needs: ["ball", "partner"] },
    { name: "Long switches", detail: "20 long passes to a target 25 m away", min: 10, needs: ["ball", "space"] },
    { name: "Recovery sprints", detail: "Turn and chase 20 m – 8 reps", min: 6, needs: [] }
  ],
  Midfielder: [
    { name: "Turn & play forward", detail: "Receive off the wall, half-turn, play forward – 20 reps", min: 8, needs: ["ball", "wall"] },
    { name: "Scanning & first touch", detail: "Look over your shoulder before every receive – 5 min", min: 6, needs: ["ball"] },
    { name: "Passing triangle", detail: "Pass and move around 3 cones, one- and two-touch", min: 10, needs: ["ball", "cones"] },
    { name: "Through-ball practice", detail: "15 passes into space between two markers", min: 8, needs: ["ball"] },
    { name: "Box-to-box runs", detail: "6 × 60 m at 80% pace", min: 8, needs: ["space"] }
  ],
  Winger: [
    { name: "Cut inside & shoot", detail: "Dribble in from the side and shoot – 12 reps", min: 10, needs: ["ball", "goal"] },
    { name: "1v1 wing moves", detail: "Step-overs, scissors & drag-backs at speed – 10 each", min: 8, needs: ["ball"] },
    { name: "Byline crosses", detail: "Dribble to the byline and cross – 12 reps", min: 10, needs: ["ball", "space"] },
    { name: "Explosive starts", detail: "10 × 15 m bursts", min: 6, needs: [] }
  ],
  Striker: [
    { name: "Finishing drill", detail: "20 shots – aim for the corners", min: 10, needs: ["ball", "goal"] },
    { name: "Hold-up play", detail: "Back to the wall: receive, shield, lay off – 15 reps", min: 8, needs: ["ball", "wall"] },
    { name: "Runs in behind", detail: "Check away, then sprint in behind – 10 reps", min: 6, needs: [] },
    { name: "Quick-shot reactions", detail: "Partner feeds from different angles – shoot in 2 touches", min: 10, needs: ["ball", "goal", "partner"] },
    { name: "Mini-goal finishing", detail: "Two bottles as posts – 20 low finishes", min: 8, needs: ["ball"] }
  ]
};

const FOCUS_INFO = {
  ballMastery: { label: "Ball Mastery", icon: "⚽", type: "skill" },
  passing:     { label: "Passing", icon: "🎯", type: "skill" },
  firstTouch:  { label: "First Touch", icon: "👟", type: "skill" },
  shooting:    { label: "Shooting & Finishing", icon: "🥅", type: "skill" },
  dribbling:   { label: "Dribbling & 1v1", icon: "🌀", type: "skill" },
  speed:       { label: "Speed & Agility", icon: "⚡", type: "speed" },
  fitness:     { label: "Fitness & Stamina", icon: "🔋", type: "fitness" },
  strength:    { label: "Strength & Balance", icon: "💪", type: "strength" },
  gameIQ:      { label: "Game Intelligence", icon: "🧠", type: "skill" },
  weakFoot:    { label: "Weaker Foot", icon: "🦶", type: "skill" },
  heading:     { label: "Heading", icon: "⬆️", type: "skill" },
  defending:   { label: "Defending", icon: "🛡️", type: "skill" },
  crossing:    { label: "Crossing", icon: "📐", type: "skill" },
  game:        { label: "Game Play", icon: "🏟️", type: "game" },
  light:       { label: "Light Touch & Recovery", icon: "🧘", type: "light" },
  position:    { label: "Position Skills", icon: "📋", type: "skill" }
};

// Words a player might type → the focus they point to.
const FOCUS_KEYWORDS = {
  weakFoot:   ["weak foot", "left foot", "right foot", "other foot", "both feet", "weaker"],
  speed:      ["speed", "pace", "fast", "slow", "quick", "sprint", "agility"],
  fitness:    ["stamina", "fitness", "tired", "endurance", "running", "unfit"],
  shooting:   ["shoot", "shot", "finish", "goal", "scoring", "score"],
  passing:    ["pass"],
  dribbling:  ["dribbl", "skill", "trick", "1v1", "close control"],
  firstTouch: ["touch", "control", "receiv"],
  heading:    ["header", "heading", "aerial", "jump"],
  strength:   ["strength", "strong", "physical", "muscle", "balance", "weak body"],
  gameIQ:     ["confidence", "nervous", "mental", "positioning", "vision", "awareness", "decision"],
  defending:  ["defend", "tackl", "marking"],
  crossing:   ["cross"],
  ballMastery:["ball mastery", "juggl", "technique"]
};

function findFocusCats(text) {
  const lower = (text || "").toLowerCase();
  return Object.keys(FOCUS_KEYWORDS).filter(cat => FOCUS_KEYWORDS[cat].some(k => lower.includes(k)));
}

// True when the player's answers point at something specific to train.
function hasSpecificFocus(p) {
  return findFocusCats(p.weaknesses + " " + p.goal).length > 0;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
// Training days are spread out so there is always rest in between.
const TRAINING_DAYS = {
  1: ["Wednesday"],
  2: ["Tuesday", "Saturday"],
  3: ["Monday", "Wednesday", "Saturday"],
  4: ["Monday", "Tuesday", "Thursday", "Saturday"],
  5: ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"],
  6: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
};
// Longest sensible session per age group.
const AGE_CAP = { "Under 10": 45, "10-13": 60, "14-17": 75, "18+": 90 };

const round5 = n => Math.max(5, Math.round(n / 5) * 5);

// Works out how long a session should be, and why.
function sessionLength(type, available, ageGroup) {
  const cap = AGE_CAP[ageGroup] || 60;
  const time = Math.min(available, cap);
  const capped = available > cap;
  const capNote = capped ? ` Capped at ${cap} min – at this age, shorter focused sessions beat long tiring ones.` : "";
  switch (type) {
    case "speed":
      return { minutes: Math.min(time, Math.max(15, Math.min(30, round5(time * 0.6)))),
        why: "Short & sharp – sprint quality drops once you're tired, so speed work stays under 30 min with full rest between reps." };
    case "fitness":
      return { minutes: Math.min(time, 40),
        why: "Hard conditioning – about 30–40 min is plenty. Going longer just makes you tired, not fitter faster." };
    case "strength":
      return { minutes: Math.min(time, 30),
        why: "Bodyweight strength needs quality reps, not long sessions – 20–30 min is ideal." };
    case "light":
      return { minutes: Math.min(time, Math.max(15, Math.min(30, round5(time * 0.5)))),
        why: "3rd training day in a row – a lighter, shorter session lets your body recover while keeping your touch sharp." };
    case "game":
      return { minutes: time, why: "Game day – play as long as you've got. Games train everything at once." + capNote };
    default:
      return { minutes: time, why: `Skill day – uses your full ${time} min, because more quality touches = faster improvement.` + capNote };
  }
}

function fakeTrainingPlan(p) {
  const equipment = p.equipment || [];
  const has = d => d.needs.every(n => equipment.includes(n));
  const weak = p.foot === "Left" ? "right" : p.foot === "Right" ? "left" : "weaker";
  const available = parseInt(p.sessionTime, 10) || 45;
  const daysCount = Math.min(6, Math.max(1, parseInt(p.daysPerWeek, 10) || 3));
  const trainDays = TRAINING_DAYS[daysCount];
  const rotating = p.focusMode === "rotating" || !hasSpecificFocus(p);

  const drillsFor = cat => (cat === "position" ? DRILLS[p.position] : DRILLS[cat] || []).filter(has);

  // 1. Decide the main focus for each training day.
  let order;
  if (rotating) {
    const pool = shuffle(["ballMastery", "passing", "shooting", "dribbling", "speed", "fitness", "firstTouch", "gameIQ"]);
    if (daysCount >= 3) pool.splice(1, 0, "position");
    if (daysCount >= 5 && equipment.includes("partner")) pool.splice(4, 0, "game");
    order = pool;
  } else {
    const goals = findFocusCats(p.weaknesses + " " + p.goal);
    const extras = ["position", "speed", "ballMastery", "fitness", "firstTouch"].filter(c => !goals.includes(c));
    if (equipment.includes("partner")) extras.splice(3, 0, "game");
    order = [];
    for (let i = 0; order.length < 7; i++) {  // alternate: your goal, then something else
      order.push(goals[i % goals.length]);
      order.push(extras[i % extras.length]);
    }
  }
  // Skip focuses with no drills for the player's equipment.
  order = order.filter(cat => drillsFor(cat).length > 0);
  if (order.length === 0) order = ["fitness"];

  // 2. Build each day. `used` counts drills across the week so top-ups vary day to day.
  const used = {};
  const leastUsed = pool => pool.slice().sort((a, b) => (used[a.name] || 0) - (used[b.name] || 0));
  let streak = 0, next = 0;
  return DAY_NAMES.map(day => {
    if (!trainDays.includes(day)) {
      streak = 0;
      return day === "Sunday"
        ? { day, focus: "Rest day", rest: true, drills: [
            { name: "Full rest", detail: "Sleep well and eat good food" },
            { name: "Reflect", detail: "Write down one thing you improved this week" } ] }
        : { day, focus: "Rest & recovery", rest: true, drills: [
            { name: "Full rest", detail: "Muscles get stronger while you rest" },
            { name: "Optional", detail: "Light walk or stretching, drink plenty of water" } ] };
    }
    streak++;
    const cat = streak >= 3 ? "light" : order[next++ % order.length];
    const info = FOCUS_INFO[cat];
    const { minutes, why } = sessionLength(info.type, available, p.ageGroup);
    const label = cat === "position" ? `${p.position} Skills` : info.label;
    const icon = cat === "position" && p.position === "Goalkeeper" ? "🧤" : info.icon;

    // Warm-up and cool-down scale with the session length.
    const warm = cat === "light" ? 0 : minutes <= 20 ? 5 : minutes <= 45 ? 8 : 10;
    const cool = cat === "light" ? 0 : minutes <= 20 ? 3 : 5;
    const drills = [];
    if (warm) drills.push({ name: "Warm-up", detail: equipment.includes("ball") ? "Jog, dynamic stretches & easy touches" : "Jog, high knees, heel flicks & dynamic stretches", minutes: warm });

    let remaining = minutes - warm - cool;
    const take = (pool, limit = Infinity) => {
      for (const d of pool) {
        if (limit-- <= 0) return;
        if (remaining < 4) return;
        if (drills.some(x => x.name === d.name)) continue;
        const m = Math.min(d.min, remaining);
        if (m < 4) continue;
        drills.push({ name: d.name, detail: d.detail.replace("{weak}", weak), minutes: m });
        used[d.name] = (used[d.name] || 0) + 1;
        remaining -= m;
      }
    };
    take(drillsFor(cat));
    // Top up skill sessions with weak-foot and position work, fitness with strength.
    if (info.type === "skill" || info.type === "game") {
      if (p.foot !== "Both") take(leastUsed(drillsFor("weakFoot")), 1);
      take(leastUsed(["position", "ballMastery", "firstTouch", "passing", "dribbling"].flatMap(drillsFor)));
    } else if (info.type !== "light") {
      take(leastUsed(drillsFor("strength")));
    }
    if (remaining >= 4 && cat !== "light") {
      drills.push(equipment.includes("partner") && equipment.includes("ball")
        ? { name: "Small-sided game", detail: "Play 1v1 or 2v2 – try today's skills in a game", minutes: remaining }
        : { name: "Free practice", detail: "Repeat your favourite drill from today", minutes: remaining });
      remaining = 0;
    }
    if (remaining > 0 && drills.length > 1) drills[1].minutes += remaining; // leftover minutes go to the main drill
    if (cool) drills.push({ name: "Cool-down", detail: "Light jog + stretching", minutes: cool });

    return { day, focus: label, icon, rotating, minutes: drills.reduce((s, d) => s + d.minutes, 0), why, drills };
  });
}

const COACH_ANSWERS = [
  { keys: ["weak foot", "left foot", "right foot", "other foot"], reply: "Great question! To improve your weaker foot:\n\n1. Do 100 wall passes with ONLY your weak foot every day.\n2. Juggle using just that foot.\n3. In training games, challenge yourself to use it at least 5 times.\n\nIt feels awkward at first, but after 3–4 weeks you'll notice a big difference! 💪" },
  { keys: ["faster", "speed", "pace", "quick"], reply: "To get faster:\n\n• Short sprints (10–20 m) with full rest between them\n• Ladder drills for quick feet\n• Work on your first 3 steps – that's where games are won\n• Sleep well – your body gets faster while you rest!\n\nTry 2 speed sessions a week. 🏃" },
  { keys: ["shoot", "shot", "finish", "score", "goal"], reply: "Better shooting tips:\n\n1. Plant your non-kicking foot next to the ball, pointing at the target.\n2. Keep your head down and body over the ball to keep it low.\n3. Strike with your laces for power, inside of the foot for accuracy.\n4. Aim for the corners – keepers hate them!\n\nPractise 20 shots, 3 times a week. ⚽" },
  { keys: ["stamina", "fitness", "tired", "run more", "endurance"], reply: "To build stamina:\n\n• Interval runs: 1 min fast, 1 min jog, repeat 8 times\n• Play small-sided games – they're fitness in disguise\n• Drink water and eat carbs (pasta, rice) before training\n\nBuild it up slowly over a few weeks. 🔋" },
  { keys: ["dribbl", "skill", "trick"], reply: "Dribbling tips:\n\n• Keep the ball close – lots of small touches\n• Use both the inside and outside of your feet\n• Look up between touches to see space\n• Learn 2 moves really well (like a step-over and a drag-back) before adding more\n\nSet up cones and dribble through them every day! 🌀" },
  { keys: ["pass", "passing"], reply: "For better passing:\n\n• Use the inside of your foot for short, accurate passes\n• Point your standing foot where you want the ball to go\n• Check your shoulder BEFORE the ball arrives so you know where to pass\n• Pass to your teammate's stronger foot\n\nWall passing is the best way to practise alone. 🎯" },
  { keys: ["first touch", "control", "touch"], reply: "First touch is everything! Try this:\n\n• Kick the ball against a wall and control it with different parts of your foot\n• Cushion the ball – relax your foot as it arrives\n• Take your first touch AWAY from pressure, into space\n\n10 minutes a day will make a huge difference. 👟" },
  { keys: ["nervous", "confidence", "scared", "pressure", "mental"], reply: "Feeling nervous is normal – even pros feel it!\n\n• Breathe slowly: in for 4 seconds, out for 4\n• Focus on your first simple action (a short pass or a tackle)\n• Remember: mistakes are how you learn\n• Picture yourself playing well the night before\n\nYou've got this! 🙌" },
  { keys: ["eat", "food", "diet", "drink", "water", "nutrition"], reply: "Fuel like a pro:\n\n• 2–3 hours before: pasta, rice or a sandwich\n• Drink water all day, not just during games\n• After: some protein (chicken, eggs, yoghurt) + fruit\n• Avoid lots of sweets and fizzy drinks before matches 🍝💧" },
  { keys: ["header", "heading"], reply: "Heading tips:\n\n• Use your forehead, not the top of your head\n• Keep your eyes open and mouth closed\n• Attack the ball – don't let it hit you\n• Use your arms for balance when you jump\n\nYounger players should practise with a soft/light ball. 🧠" },
  { keys: ["goalkeeper", "keeper", "save", "diving"], reply: "Goalkeeper tips:\n\n• Stay on your toes in the 'ready' position\n• Make your hands into a 'W' shape to catch\n• Narrow the angle by stepping off your line\n• Communicate loudly with your defenders!\n\nPractise diving on soft grass first. 🧤" },
  { keys: ["defend", "tackl", "defender"], reply: "Defending tips:\n\n• Stand side-on so you can turn quickly\n• Stay patient – don't dive in!\n• Watch the ball, not the player's tricks\n• Show the attacker onto their weaker foot or towards the sideline\n\nGood defenders are patient defenders. 🛡️" },
  { keys: ["injur", "hurt", "pain", "sore"], reply: "If something hurts, stop and rest – and tell a parent, coach or doctor, especially if the pain lasts more than a couple of days. For small knocks, rest and ice can help. Always warm up properly to help prevent injuries. 🩹" }
];

function fakeCoachReply(question) {
  const lower = question.toLowerCase();
  if (/^(hi|hello|hey)\b/.test(lower)) {
    return "Hey! 👋 I'm your coach. Ask me anything – shooting, passing, speed, confidence, food… whatever you want to get better at!";
  }
  const match = COACH_ANSWERS.find(a => a.keys.some(k => lower.includes(k)));
  if (match) return match.reply;
  return "Good question! 🤔 Here's my general advice:\n\n• Practise a little every day – 20 minutes beats 2 hours once a week\n• Work on your weaker foot\n• Watch pros who play your position\n• Rest well and have fun!\n\nTry asking me about shooting, passing, speed, stamina, dribbling or confidence for more specific tips.";
}

/* ==========================================================================
   HELPERS
   ========================================================================== */
const wait = ms => new Promise(r => setTimeout(r, ms));

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

function addMessage(container, sender, text) {
  const msg = document.createElement("div");
  msg.className = "fc-msg " + sender;
  msg.innerHTML = `<div class="fc-avatar">${sender === "bot" ? "⚽" : "You"}</div><div class="fc-bubble"></div>`;
  msg.querySelector(".fc-bubble").textContent = text;
  container.appendChild(msg);
  scrollToBottom(container);
  return msg;
}

function showTyping(container) {
  const msg = document.createElement("div");
  msg.className = "fc-msg bot";
  msg.innerHTML = `<div class="fc-avatar">⚽</div><div class="fc-bubble fc-typing"><span></span><span></span><span></span></div>`;
  container.appendChild(msg);
  scrollToBottom(container);
  return () => msg.remove();
}

async function botSay(container, text) {
  const stop = showTyping(container);
  await wait(500);
  stop();
  addMessage(container, "bot", text);
}

// Wires up a Send button + the Enter key. Uses plain click/keydown events
// instead of a <form>, so it still works inside sandboxed website builders.
function onSend(input, button, handler) {
  const send = () => {
    if (button.disabled) return;
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.value = "";
    handler(text);
  };
  button.addEventListener("click", send);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); send(); }
  });
}

function makeChip(label, onClick, primary) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "fc-chip" + (primary ? " primary" : "");
  chip.textContent = label;
  chip.addEventListener("click", onClick);
  return chip;
}

/* ==========================================================================
   TABS
   ========================================================================== */
document.querySelectorAll(".fc-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".fc-tab").forEach(t => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".fc-panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + tab.dataset.tab));
  });
});

/* ==========================================================================
   TAB 1: WEEKLY TRAINING PLANNER
   ========================================================================== */
const NUMBER_WORDS = { once: 1, one: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, daily: 7, everyday: 7, "every day": 7 };

const QUESTIONS = [
  { key: "position", text: "First up – what position do you play? ⚽", options: ["Goalkeeper", "Defender", "Midfielder", "Winger", "Striker"] },
  { key: "ageGroup", text: "Nice! What is your age group?", options: ["Under 10", "10-13", "14-17", "18+"] },
  { key: "foot", text: "Which is your strong foot? 👟", options: ["Left", "Right", "Both"] },
  { key: "equipment", multi: true, text: "What do you have access to when you train? Tap everything that applies, then hit Done ✅",
    options: EQUIPMENT },
  { key: "daysPerWeek", text: "How many days a week can you train? 📅", options: ["1 day", "2 days", "3 days", "4 days", "5 days", "6 days"],
    parse: text => {
      const lower = text.toLowerCase();
      const word = Object.keys(NUMBER_WORDS).find(w => lower.includes(w));
      const n = parseInt(lower.replace(/\D/g, ""), 10) || NUMBER_WORDS[word];
      if (!n) return null;
      const days = Math.min(6, Math.max(1, n)); // always keep at least one rest day
      return days + (days === 1 ? " day" : " days");
    } },
  { key: "sessionTime", text: "How much time do you usually have for each session? ⏱", options: ["15 min", "30 min", "45 min", "60 min", "90 min"],
    parse: text => {
      const lower = text.toLowerCase();
      let mins;
      if (/hour and a half|1\.5|one and a half/.test(lower)) mins = 90;
      else if (/half an hour|half hour/.test(lower)) mins = 30;
      else {
        const n = parseFloat(lower.replace(/[^\d.]/g, ""));
        if (/h(ou)?r/.test(lower)) mins = (n || 1) * 60;
        else if (n) mins = n;
      }
      if (!mins) return null;
      const snap = [15, 30, 45, 60, 90].reduce((a, b) => Math.abs(b - mins) < Math.abs(a - mins) ? b : a);
      return snap + " min";
    } },
  { key: "weaknesses", text: "What are your weaknesses? Be honest – that's how we improve! 💪", placeholder: "e.g. my left foot, I get tired quickly...", skipChip: "🤷 Nothing specific" },
  { key: "goal", text: "Last one! What do you want to work on most? 🎯", placeholder: "e.g. scoring more goals, getting faster...", skipChip: "🔄 Mix it up for me" }
];

const plannerMsgs = document.getElementById("planner-messages");
const plannerOptions = document.getElementById("planner-options");
const plannerInput = document.getElementById("planner-input");
const plannerSend = document.getElementById("planner-send");

let step = 0;
let profile = {};
let waitingForAnswer = false;

function updateProgress() {
  const done = Math.min(step, QUESTIONS.length);
  const pct = Math.round((done / QUESTIONS.length) * 100);
  document.getElementById("progress-bar").style.width = pct + "%";
  document.getElementById("progress-pct").textContent = pct + "%";
  document.getElementById("progress-label").textContent =
    done >= QUESTIONS.length ? "All done – plan ready!" : `Question ${done + 1} of ${QUESTIONS.length}`;
}

async function askQuestion() {
  const q = QUESTIONS[step];
  plannerOptions.innerHTML = "";
  waitingForAnswer = false;
  updateProgress();
  await botSay(plannerMsgs, q.text);

  if (q.multi) {
    const selected = new Set();
    q.options.forEach(o => {
      const chip = makeChip(o.label, () => {
        selected.has(o.key) ? selected.delete(o.key) : selected.add(o.key);
        chip.classList.toggle("selected", selected.has(o.key));
      });
      plannerOptions.appendChild(chip);
    });
    plannerOptions.appendChild(makeChip("✅ Done", () => handleAnswer(Array.from(selected)), true));
    plannerInput.placeholder = "Tap all that apply, or type e.g. \"a ball and a wall\"";
  } else if (q.options) {
    q.options.forEach(opt => plannerOptions.appendChild(makeChip(opt, () => handleAnswer(opt))));
    plannerInput.placeholder = "Tap an option or type your answer...";
  } else {
    plannerInput.placeholder = q.placeholder;
    if (q.skipChip) plannerOptions.appendChild(makeChip(q.skipChip, () => handleAnswer("Nothing specific")));
  }
  waitingForAnswer = true;
  plannerSend.disabled = false;
}

// Turns a typed answer like "striker", "u10" or "12" into one of the options.
function matchOption(text, options) {
  const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const typed = clean(text);
  const found = options.find(o => typed.includes(clean(o)) || (typed.length > 2 && clean(o).includes(typed)));
  if (found) return found;
  if (options.includes("Under 10")) { // age group: accept a plain age
    const age = parseInt(text.replace(/\D/g, ""), 10);
    if (!isNaN(age)) return age < 10 ? "Under 10" : age <= 13 ? "10-13" : age <= 17 ? "14-17" : "18+";
  }
  return null;
}

// Turns "a ball and my dad" into ["ball", "partner"].
function parseEquipment(text) {
  const lower = text.toLowerCase();
  return EQUIPMENT.filter(e => e.words.some(w => lower.includes(w))).map(e => e.key);
}

function equipmentLabel(keys) {
  return keys.length ? EQUIPMENT.filter(e => keys.includes(e.key)).map(e => e.label).join(", ") : "Nothing – just me";
}

function handleAnswer(answer) {
  if (!waitingForAnswer) return; // ignore clicks while the coach is "typing"
  const q = QUESTIONS[step];
  let shown = answer;
  if (q.multi) {
    const keys = Array.isArray(answer) ? answer : parseEquipment(answer);
    if (!Array.isArray(answer) && keys.length === 0 && !/nothing|none|no\b|just me/i.test(answer)) {
      addMessage(plannerMsgs, "user", answer);
      addMessage(plannerMsgs, "bot", "Hmm, I didn't catch that. Tap the things you have (ball, cones, goal, wall, a friend, a pitch or park), then Done.");
      return;
    }
    answer = keys;
    shown = equipmentLabel(keys);
  } else if (q.options) {
    const match = (q.parse && q.parse(answer)) || matchOption(answer, q.options);
    if (!match) {
      addMessage(plannerMsgs, "user", answer);
      addMessage(plannerMsgs, "bot", "Hmm, I didn't catch that. Please choose one of: " + q.options.join(", "));
      return;
    }
    answer = shown = match;
  }
  waitingForAnswer = false;
  addMessage(plannerMsgs, "user", shown);
  profile[q.key] = answer;
  plannerOptions.innerHTML = "";
  step++;
  if (step < QUESTIONS.length) askQuestion();
  else buildPlan();
}

onSend(plannerInput, plannerSend, text => {
  if (waitingForAnswer) {
    handleAnswer(text);
  } else if (step >= QUESTIONS.length) {
    addMessage(plannerMsgs, "user", text);
    addMessage(plannerMsgs, "bot", "Your plan is ready above! 👆 Tap \"Make a new plan\" to start again, or switch to \"Ask a Coach\" for questions.");
  }
});

async function buildPlan() {
  updateProgress();
  plannerInput.placeholder = "Your plan is ready!";
  profile.focusMode = hasSpecificFocus(profile) ? "targeted" : "rotating";
  await botSay(plannerMsgs, (profile.focusMode === "rotating"
    ? "No problem! I'll build you an all-round week where every training day has a different main focus. 🔄"
    : "Brilliant! Building your personal 7-day plan... 📝") +
    (aiMode === "live" ? "\nYour AI coach is thinking it through – this can take up to 30 seconds. ⏳" : ""));
  const stop = showTyping(plannerMsgs);
  let plan;
  try {
    plan = await getTrainingPlan(profile);
  } catch (err) {
    stop();
    addMessage(plannerMsgs, "bot", "Sorry, something went wrong making your plan. Please try again!");
    showRestart();
    return;
  }
  stop();
  renderPlan(plan);
  showRestart();
}

// Rotating plans only: pick a fresh set of focus days with the same answers.
let shuffling = false;
async function shufflePlan() {
  if (shuffling) return;
  shuffling = true;
  addMessage(plannerMsgs, "user", "🔀 Shuffle my focus days");
  const stop = showTyping(plannerMsgs);
  try {
    const plan = await getTrainingPlan(profile);
    stop();
    renderPlan(plan);
  } catch (err) {
    stop();
    addMessage(plannerMsgs, "bot", "Sorry, I couldn't shuffle your plan. Please try again!");
  }
  shuffling = false;
}

function formatMinutes(total) {
  const h = Math.floor(total / 60), m = total % 60;
  return h ? `${h} h${m ? " " + m + " min" : ""}` : `${m} min`;
}

function renderPlan(plan, answers = profile) {
  const profile = answers; // show the answers this plan was made from
  const wrap = document.createElement("div");
  wrap.className = "fc-plan";
  const tags = [profile.position, profile.ageGroup, profile.foot + " foot"].map(t => `<span class="fc-tag">${escapeHTML(t)}</span>`).join("") +
    (lastPlanSource === "ai" ? `<span class="fc-tag ai">✨ Made by your AI coach</span>` : "") +
    (lastPlanElite ? `<span class="fc-tag elite">💎 Elite plan</span>` : "");
  const sessions = plan.filter(d => !d.rest);
  const totalMinutes = sessions.reduce((s, d) => s + (parseInt(d.minutes, 10) || 0), 0);
  const stats = [
    ["📅", "Sessions", sessions.length],
    ["⏱", "Total time", formatMinutes(totalMinutes)],
    ["🧰", "Kit", equipmentLabel(profile.equipment || [])]
  ].map(([icon, label, value]) => `
    <div class="fc-stat"><span class="fc-stat-label">${icon} ${label}</span><strong>${escapeHTML(value)}</strong></div>`).join("");

  const rotationDays = plan.filter(d => d.rotating && !d.rest);
  const rotationSection = rotationDays.length ? `
    <div class="fc-rotation">
      <div class="fc-rotation-head">
        <h4>🔄 Rotating Focus Week</h4>
        <p>You didn't pick one thing to work on, so each training day switches to a different main focus. That way you improve all-round.</p>
      </div>
      <div class="fc-rotation-steps">
        ${rotationDays.map(d => `
          <div class="fc-rotation-step">
            <span class="fc-rotation-day">${escapeHTML(d.day.slice(0, 3))}</span>
            <span class="fc-rotation-icon">${escapeHTML(d.icon || "⚽")}</span>
            <span class="fc-rotation-name">${escapeHTML(d.focus)}</span>
          </div>`).join("")}
      </div>
    </div>` : "";
  const note = rotationDays.length
    ? `🔄 Mode: <strong>All-round – main focus changes every training day</strong><br>`
    : `🎯 Main goal: <strong>${escapeHTML(profile.goal)}</strong><br>
      💪 Working on: <strong>${escapeHTML(profile.weaknesses)}</strong><br>`;

  wrap.innerHTML = `
    <div class="fc-plan-head">
      <h3>🏆 Your 7-Day Training Plan</h3>
      <div class="fc-tags">${tags}</div>
      <div class="fc-stats">${stats}</div>
    </div>
    ${rotationSection}
    <div class="fc-days">
      ${plan.map(d => `
        <div class="fc-day ${d.rest ? "rest" : ""}">
          <div class="fc-day-top">
            <span class="fc-day-name">${escapeHTML(d.day)}</span>
            <span class="fc-day-time">${d.rest ? "😴 Rest" : "⏱ " + escapeHTML(d.minutes) + " min"}</span>
          </div>
          <span class="fc-day-focus">${d.icon ? escapeHTML(d.icon) + " " : ""}${escapeHTML(d.focus)}</span>
          ${d.why ? `<p class="fc-day-why">💡 ${escapeHTML(d.why)}</p>` : ""}
          <ul>
            ${d.drills.map(dr => `<li><div class="fc-drill-top"><strong>${escapeHTML(dr.name)}</strong>${dr.minutes ? `<em>${escapeHTML(dr.minutes)} min</em>` : ""}</div><span>${escapeHTML(dr.detail)}</span></li>`).join("")}
          </ul>
        </div>`).join("")}
    </div>
    <div class="fc-plan-note">
      ${note}
      Rest days are part of the plan – that's when your body actually gets stronger. Always warm up, drink water and stop if anything hurts.
    </div>`;
  plannerMsgs.appendChild(wrap);
  plannerMsgs.scrollTop = wrap.offsetTop - plannerMsgs.offsetTop - 12;
}

function showRestart() {
  plannerOptions.innerHTML = "";
  plannerOptions.appendChild(makeChip("🔄 Make a new plan", startPlanner, true));
  if (profile.focusMode === "rotating") plannerOptions.appendChild(makeChip("🔀 Shuffle focus days", shufflePlan));
}

async function startPlanner() {
  step = 0;
  profile = {};
  waitingForAnswer = false;
  plannerMsgs.innerHTML = "";
  plannerOptions.innerHTML = "";
  updateProgress();
  await botSay(plannerMsgs, `Hi! 👋 I'm your football coach. Answer ${QUESTIONS.length} quick questions and I'll make you a training plan for the whole week!`);
  askQuestion();
}

/* ==========================================================================
   TAB 2: ASK A COACH
   ========================================================================== */
const coachMsgs = document.getElementById("coach-messages");
const coachInput = document.getElementById("coach-input");
const coachSend = document.getElementById("coach-send");
const coachSuggestions = document.getElementById("coach-suggestions");
const coachHistory = []; // [{ role: "user" | "assistant", content }] – ready to send to a real AI

async function askCoach(question) {
  coachSuggestions.innerHTML = "";
  addMessage(coachMsgs, "user", question);
  coachHistory.push({ role: "user", content: question });
  coachSend.disabled = true;

  const stop = showTyping(coachMsgs);
  let reply;
  try {
    reply = await getCoachReply(question, coachHistory);
  } catch (err) {
    stop();
    coachHistory.pop(); // not answered, so don't send it again next time
    if (err.needLogin) addActionMessage(coachMsgs, "Create a free account to chat with your AI coach – it takes 20 seconds. ⚽", signUpActions);
    else if (err.upgrade) addActionMessage(coachMsgs, err.message, [seePlans]);
    else addMessage(coachMsgs, "bot", "Sorry, I couldn't answer that right now. Please try again in a moment!");
    coachSend.disabled = false;
    return;
  }
  stop();
  addMessage(coachMsgs, "bot", reply);
  coachHistory.push({ role: "assistant", content: reply });
  coachSend.disabled = false;
}

onSend(coachInput, coachSend, askCoach);

addMessage(coachMsgs, "bot", "Hey! 👋 Ask me anything about getting better at football – shooting, passing, speed, fitness, confidence and more.");
["How do I get faster?", "How can I shoot better?", "How do I improve my weak foot?", "What should I eat before a game?"]
  .forEach(q => coachSuggestions.appendChild(makeChip(q, () => askCoach(q))));

/* ==========================================================================
   SITE: theme toggle + buttons that open the coach
   ========================================================================== */
document.getElementById("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("pitchside-theme", next); } catch (e) {}
});

// Buttons like "Start training free" scroll to the coach and open the right tab.
document.querySelectorAll("[data-open-tab]").forEach(link => {
  link.addEventListener("click", () => {
    const tab = document.querySelector(`.fc-tab[data-tab="${link.dataset.openTab}"]`);
    if (tab) tab.click();
  });
});

/* START */
document.getElementById("saved-plans-btn").addEventListener("click", showSavedPlans);
detectAiMode();
startPlanner();
