// Local dev server: serves /public and runs the /api functions the same way Vercel does
// (each file in /api exports GET/POST handlers that take a Request and return a Response).
//   npm run dev   ->  http://localhost:3000   (reads keys from .env)
// Missing keys just switch those parts of the site to demo mode.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "public");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function runApi(name, req, res) {
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(here, "api", `${name}.js`)).href);
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") console.error(err);
    res.statusCode = 404;
    return res.end("Not found");
  }
  const handler = mod[req.method];
  if (!handler) { res.statusCode = 405; return res.end("Method not allowed"); }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks)
  });
  const response = await handler(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const api = /^\/api\/([a-z-]+)$/.exec(url.pathname);
    if (api) return await runApi(api[1], req, res);

    const file = path.join(root, path.normalize(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
    const data = await fs.readFile(file);
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.end(data);
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "EISDIR") console.error(err);
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(process.env.PORT || 3000, () => {
  const on = key => (process.env[key] ? "on" : "demo");
  console.log(`Pitchside Coaching AI running at http://localhost:${process.env.PORT || 3000}`);
  console.log(`AI coach: ${on("ANTHROPIC_API_KEY")} · accounts: ${on("SUPABASE_URL")} · payments: ${on("STRIPE_SECRET_KEY")}`);
});
