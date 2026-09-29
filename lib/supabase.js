// Accounts (Supabase Auth) and the database tables in supabase/schema.sql.
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "./http.js";

export const authEnabled = () =>
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);

let admin;
// Server-only client with the service-role key: bypasses row-level security, never sent to browsers.
export function getAdmin() {
  admin ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return admin;
}
export function _setAdminForTests(client) { admin = client; }

// Returns { user, profile } for the signed-in visitor, or null.
export async function getSignedInUser(request) {
  const token = bearerToken(request);
  if (!token) return null;
  const db = getAdmin();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const user = data.user;
  let { data: profile } = await db.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!profile) {
    // Normally created by the signup trigger; create it here as a safety net.
    ({ data: profile } = await db.from("profiles").upsert({ id: user.id, email: user.email }).select("*").single());
  }
  return { user, profile: profile || { id: user.id, email: user.email, plan: "free" } };
}

export async function updateProfile(userId, fields) {
  const { error } = await getAdmin().from("profiles").update(fields).eq("id", userId);
  if (error) throw error;
}
