// Imported first by server/index.js so .env is loaded before any module reads
// process.env. Always the .env in the project folder, wherever Cutline is
// started from. Needs Node 20.12+. A missing .env is fine.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.resolve(root, process.env.ENV_FILE || '.env'));
} catch {}

console.log('\n  Starting Cutline…');
