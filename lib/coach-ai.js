// Shared Claude logic for the CoachAI site.
// Used by the Vercel functions in /api and by the local dev server (server.js).
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

const MODEL = "claude-opus-5-5";
// If Claude declines a request, the API re-runs it on a recommended fallback model.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const MAX_HISTORY = 20;          // messages of chat history sent per request
const MAX_MESSAGE_CHARS = 2000;  // longest single message accepted

// True when a key is configured. The SDK reads ANTHROPIC_API_KEY from the environment.
export const isLive = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client;
const getClient = () => (client ??= new Anthropic());

export class CoachError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Ask a Coach                                                          */
/* ------------------------------------------------------------------ */

const COACH_SYSTEM = `You are CoachAI, a friendly, encouraging football (soccer) coach on a training website.
Most people asking are young players (roughly 8–18) and their parents, plus some adult amateurs.

How to answer:
- Give practical, specific advice a player can use in their next session: drills with reps or times, coaching cues, what "good" looks like.
- Keep it short: a sentence or two of context, then up to about 6 short points. No long essays.
- Write plain text only. No markdown: no headings, bold, tables or asterisks. For lists, start lines with "• " or "1. ".
- Use British football vocabulary (pitch, boots, match, training session).
- Stay on football, fitness, recovery, nutrition basics and the mental side of the game. If asked about something unrelated, say briefly that you're a football coach and steer back.
- For pain, injuries, concussion or medical questions: give only general safety advice and tell them to stop and speak to a parent, coach, physio or doctor. Never diagnose.
- Be age-appropriate and positive. Never suggest supplements, extreme diets or training through pain.`;

export async function coachReply(body) {
  const history = Array.isArray(body?.messages) ? body.messages : [];
  const messages = history
    .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
  // The API needs the conversation to start with the player and end with the player.
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new CoachError("Send at least one question from the player.", 400);
  }

  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: COACH_SYSTEM,
    output_config: { effort: "low" }, // chat answers don't need deep reasoning
    messages,
    ...FALLBACK
  });

  if (response.stop_reason === "refusal") {
    return { reply: "Sorry, I can't help with that one. Ask me anything about improving your football! ⚽" };
  }
  const reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  if (!reply) throw new CoachError("The coach didn't return an answer.", 502);
  return { reply };
}

/* ------------------------------------------------------------------ */
/* Weekly Training Planner                                              */
/* ------------------------------------------------------------------ */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const AGE_CAP = { "Under 10": 45, "10-13": 60, "14-17": 75, "18+": 90 };
const EQUIPMENT_NAMES = { ball: "a ball", cones: "cones", goal: "a goal", wall: "a wall to kick against", partner: "a friend to train with", space: "a pitch or park" };

const PlanSchema = z.object({
  days: z.array(z.object({
    day: z.enum(DAYS),
    focus: z.string().describe("Main focus of the day, e.g. 'Shooting & Finishing' or 'Rest & recovery'"),
    icon: z.string().describe("One emoji for the focus"),
    rest: z.boolean(),
    rotating: z.boolean().describe("true on training days when focusMode is 'rotating'"),
    minutes: z.number().int().describe("Total session length; 0 on rest days"),
    why: z.string().describe("One sentence on why this session is this long; empty on rest days"),
    drills: z.array(z.object({
      name: z.string(),
      detail: z.string().describe("Reps, sets or coaching cue"),
      minutes: z.number().int().describe("0 on rest days")
    }))
  }))
});

const PLAN_SYSTEM = `You are CoachAI, an expert youth and amateur football (soccer) coach. You write safe, realistic 7-day training plans.

Rules every plan must follow:
- Exactly 7 days, Monday to Sunday, in order.
- Exactly the number of training days the player asked for. Spread them out so hard days are separated by rest where possible. Every other day is a rest day (rest: true, minutes: 0, 1–2 short recovery tips as drills with minutes 0).
- Never exceed the player's session time or the age cap you're given. Sessions should NOT all be the same length: skill days can use the full time; speed/agility work stays short (about 30 min max, full rest between sprints); conditioning about 40 min max; strength about 30 min max; a third training day in a row should be a lighter recovery session.
- Every training session: a warm-up first, a cool-down last (skip both only on a light recovery day), and drill minutes that add up exactly to the session's minutes.
- Only use drills that need equipment the player actually has. With no ball, use running, footwork, strength and game-intelligence work.
- Target the player's weaknesses and goal (focusMode "targeted"), and include position-specific and weaker-foot work where it fits.
- If focusMode is "rotating", the player has nothing specific to work on: give every training day a different main focus and set rotating: true on training days.
- Keep drill names short and details concrete (reps, distances, times). Suit the player's age: younger players get more game-like, fun drills.`;

export async function trainingPlan(body) {
  const p = body?.profile;
  if (!p || typeof p !== "object") throw new CoachError("Missing player profile.", 400);

  const clip = (v, n = 300) => String(v ?? "").slice(0, n);
  const daysPerWeek = Math.min(6, Math.max(1, parseInt(p.daysPerWeek, 10) || 3));
  const sessionTime = parseInt(p.sessionTime, 10) || 45;
  const ageCap = AGE_CAP[p.ageGroup] ?? 60;
  const equipment = (Array.isArray(p.equipment) ? p.equipment : []).filter(k => k in EQUIPMENT_NAMES);

  const brief = [
    `Position: ${clip(p.position, 40)}`,
    `Age group: ${clip(p.ageGroup, 20)} (age cap: ${ageCap} min per session)`,
    `Strong foot: ${clip(p.foot, 20)}`,
    `Equipment: ${equipment.length ? equipment.map(k => EQUIPMENT_NAMES[k]).join(", ") : "nothing – no ball or kit"}`,
    `Training days per week: ${daysPerWeek}`,
    `Time available per session: ${sessionTime} min (never go over ${Math.min(sessionTime, ageCap)} min)`,
    `Weaknesses (player's words): ${clip(p.weaknesses)}`,
    `Wants to work on (player's words): ${clip(p.goal)}`,
    `focusMode: ${p.focusMode === "rotating" ? "rotating" : "targeted"}`
  ].join("\n");

  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: PLAN_SYSTEM,
    output_config: { effort: "medium", format: betaZodOutputFormat(PlanSchema) },
    messages: [{ role: "user", content: `Write this player's 7-day plan.\n\n${brief}` }],
    ...FALLBACK
  });

  if (response.stop_reason === "refusal") throw new CoachError("The coach couldn't make that plan.", 422);
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new CoachError("The plan came back incomplete.", 502);
  }
  return { plan: response.parsed_output.days };
}

/* ------------------------------------------------------------------ */
/* Shared error handling                                                */
/* ------------------------------------------------------------------ */

// Turns any error into { status, error } without leaking internal details to the browser.
export function toErrorResponse(err) {
  if (err instanceof CoachError) return { status: err.status, error: err.message };
  if (err instanceof Anthropic.AuthenticationError) {
    console.error("Anthropic API key is invalid:", err.message);
    return { status: 503, error: "The AI coach isn't configured correctly." };
  }
  if (err instanceof Anthropic.RateLimitError) return { status: 429, error: "The coach is busy – try again in a minute." };
  if (err instanceof Anthropic.APIError) {
    console.error(`Anthropic API error (${err.status ?? "no connection"}):`, err.message);
    return { status: 502, error: "The AI coach had a problem answering." };
  }
  console.error(err);
  return { status: 500, error: "Something went wrong." };
}
