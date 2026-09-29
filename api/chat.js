import { coachReply, isLive, toErrorResponse } from "../lib/coach-ai.js";

// GET  /api/chat -> { live } (is an API key configured?)
// POST /api/chat { messages: [{ role, content }] } -> { reply }
export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ live: isLive() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isLive()) return res.status(503).json({ error: "AI coach not configured", demo: true });
  try {
    res.status(200).json(await coachReply(req.body));
  } catch (err) {
    const { status, error } = toErrorResponse(err);
    res.status(status).json({ error });
  }
}
