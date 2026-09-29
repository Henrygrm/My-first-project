// Local dev server: serves /public and runs the /api functions, like Vercel does.
//   ANTHROPIC_API_KEY=sk-ant-... npm run dev   ->  http://localhost:3000
// Without a key the site still works using the built-in demo answers.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chat from "./api/chat.js";
import plan from "./api/plan.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const routes = { "/api/chat": chat, "/api/plan": plan };
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = routes[url.pathname];
  if (route) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    // Minimal version of Vercel's res.status().json() helpers.
    res.status = code => { res.statusCode = code; return res; };
    res.json = data => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
    return route(req, res);
  }
  const file = path.join(root, path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(process.env.PORT || 3000, () => {
  console.log(`CoachAI running at http://localhost:${process.env.PORT || 3000}`);
  console.log(process.env.ANTHROPIC_API_KEY ? "AI coach: LIVE (Claude)" : "AI coach: demo mode (set ANTHROPIC_API_KEY to go live)");
});
