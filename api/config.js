import { json } from "../lib/http.js";
import { isLive } from "../lib/coach-ai.js";
import { authEnabled } from "../lib/supabase.js";
import { paymentsEnabled } from "../lib/billing.js";

// GET /api/config -> which parts of the site are switched on.
// The anon key is designed to be public; the service-role key never leaves the server.
export function GET() {
  return json({
    ai: isLive(),
    auth: authEnabled() ? { url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY } : null,
    payments: authEnabled() && paymentsEnabled()
  });
}
