import { safeEqual } from "@/lib/crypto";
import { tick } from "@/lib/publish/scheduler";

/**
 * The scheduler tick (driven by scripts/boot.mjs every ~30 s). Guarded by
 * SCHEDULER_SECRET; with no secret configured the endpoint is closed.
 * It can also be hit from outside as a backup driver (e.g. a host cron).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const secret = process.env.SCHEDULER_SECRET ?? "";
  const given = req.headers.get("x-scheduler-secret") ?? "";
  if (!secret || !safeEqual(given, secret)) return new Response("Forbidden", { status: 403 });
  try {
    const result = await tick();
    return Response.json(result);
  } catch (err) {
    console.error("[scheduler] tick crashed", err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
