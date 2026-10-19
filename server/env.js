// Imported first by server/index.js so .env is loaded before any module reads
// process.env. Needs Node 20.12+. A missing .env is fine: the app shows setup hints.
try {
  process.loadEnvFile();
} catch {}
