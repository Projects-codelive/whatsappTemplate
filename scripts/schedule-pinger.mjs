// Local scheduled-broadcast pinger. The cron dispatcher at
// /api/whatsapp/broadcast/cron is driven by an external hit on a
// schedule, so while developing locally (or on any host without a
// platform cron) this script pings it every minute with the shared
// AUTOMATION_CRON_SECRET. Every hit is incremental + idempotent, so a
// missing beat just leaves work for the next one.
//
// Run it in its own terminal while the dev server is up:
//
//   npm run cron:pinger
//
// For deployed hosts, replace this with a real scheduler (e.g. Vercel
// Cron / cron-job.org) hitting the same URL + header instead.

const BASE = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
const SECRET = process.env.AUTOMATION_CRON_SECRET;
const INTERVAL_MS = 60_000;

// Only the broadcast sweep is wired by default. The automations and
// flows crons use the same secret if you ever want them drained from
// here too:
//   '/api/automations/cron',
//   '/api/flows/cron',
const ENDPOINTS = ['/api/whatsapp/broadcast/cron'];

if (!SECRET) {
  console.error('[pinger] AUTOMATION_CRON_SECRET is not set in .env.local');
  process.exit(1);
}

async function ping() {
  const stamp = new Date().toLocaleTimeString();
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(`${BASE}${ep}`, {
        headers: { 'x-cron-secret': SECRET },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.text();
      console.log(`[${stamp}] ${ep} -> ${res.status} ${body.slice(0, 140)}`);
    } catch (err) {
      console.error(`[${stamp}] ${ep} -> ERROR ${err.message}`);
    }
  }
}

console.log(
  `[pinger] every ${INTERVAL_MS / 1000}s against ${BASE} (Ctrl+C to stop)`,
);
await ping();
setInterval(ping, INTERVAL_MS);