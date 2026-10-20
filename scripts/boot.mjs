/**
 * Container entrypoint: start the server, then drive the publish scheduler.
 *
 * Shipyard has no cron for app containers, so the scheduler lives here: every
 * ~30 s (with jitter) this process POSTs /api/internal/tick on its own server.
 * The publish engine is TypeScript inside the Next app, so the tick goes
 * through HTTP rather than a second runtime with its own Prisma pool — one
 * engine, shared with "Publish now", and no extra connections against the
 * 5-connection pin Shipyard puts on DIRECT_URL.
 *
 * During a deploy the old and new containers both tick for a few seconds.
 * That is safe by construction: the tick claims posts with FOR UPDATE SKIP
 * LOCKED (src/lib/publish/engine.ts), so each due post goes to one of them.
 *
 * `npm start` must EXEC this file (it does), or SIGTERM never reaches it and
 * the children are killed without draining.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Local runs read .env like `next start` does (existing variables win);
// in a Shipyard container there is no .env and the platform's env is used.
try {
  process.loadEnvFile(".env");
} catch {}

const root = process.cwd();
const NEXT_BIN = path.join(root, "node_modules", "next", "dist", "bin", "next");
const PORT = process.env.PORT || "3000";
const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 30_000);
const ENABLED = process.env.SCHEDULER_ENABLED !== "false";
const SECRET = process.env.SCHEDULER_SECRET || "";

if (!existsSync(NEXT_BIN)) {
  console.error(`[boot] next not found at ${NEXT_BIN}`);
  process.exit(1);
}

const server = spawn(process.execPath, [NEXT_BIN, "start", "-p", PORT], { stdio: "inherit", env: process.env });
server.on("error", (err) => {
  console.error(`[boot] could not start next — ${err.message}`);
  process.exit(1);
});

let stopping = false;
let timer = null;

async function tickOnce() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/internal/tick`, {
      method: "POST",
      headers: { "x-scheduler-secret": SECRET },
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok && res.status !== 503) console.error(`[scheduler] tick answered ${res.status}`);
  } catch (err) {
    // The server is still starting, or restarting: the next tick will do.
    if (!stopping) console.error(`[scheduler] tick failed — ${err.message}`);
  }
}

function schedule(delay) {
  if (stopping) return;
  timer = setTimeout(async () => {
    await tickOnce();
    schedule(INTERVAL_MS + Math.floor(Math.random() * 5_000));
  }, delay);
  timer.unref();
}

if (!ENABLED) console.log("[scheduler] disabled (SCHEDULER_ENABLED=false)");
else if (!SECRET) console.error("[scheduler] SCHEDULER_SECRET is not set — scheduler NOT started");
else schedule(15_000); // give next start a moment to listen

server.on("exit", (code, signal) => {
  stopping = true;
  if (timer) clearTimeout(timer);
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 0);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    // Stop ticking first, so a draining container claims nothing new.
    stopping = true;
    if (timer) clearTimeout(timer);
    if (!server.killed) server.kill(sig);
  });
}
