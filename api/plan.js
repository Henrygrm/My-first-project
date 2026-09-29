import { trainingPlan, isLive, toErrorResponse } from "../lib/coach-ai.js";

// POST /api/plan { profile } -> { plan: [7 days] }
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isLive()) return res.status(503).json({ error: "AI coach not configured", demo: true });
  try {
    res.status(200).json(await trainingPlan(req.body));
  } catch (err) {
    const { status, error } = toErrorResponse(err);
    res.status(status).json({ error });
  }
}
