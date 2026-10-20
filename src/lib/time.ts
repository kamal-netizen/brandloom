/**
 * Asia/Dubai is UTC+4 all year (no daylight saving), so a fixed offset is
 * exact and needs no tz database. Everything is stored in UTC; these helpers
 * are the only place local wall-clock time is turned into an instant.
 */
export const APP_TZ = "Asia/Dubai";
const OFFSET = "+04:00";
const OFFSET_MS = 4 * 60 * 60 * 1000;

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses a time the way a person or the CLI writes it:
 *  - with an offset or Z ("2026-10-20T18:00+04:00", "...T14:00Z"): taken as given;
 *  - without one ("2026-10-20 18:00", "2026-10-20T18:00"): Dubai wall-clock time.
 * Returns null for anything else (no Date.parse guessing).
 */
export function parseDubai(input: string): Date | null {
  const s = input.trim();
  const local = LOCAL_RE.exec(s);
  if (local) {
    const [, y, mo, d, h, mi, sec] = local;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec ?? "00"}${OFFSET}`;
    const date = new Date(iso);
    // Reject 2026-02-30 and friends, which Date would roll over silently.
    if (Number.isNaN(date.getTime())) return null;
    const back = new Date(date.getTime() + OFFSET_MS);
    if (back.getUTCDate() !== Number(d) || back.getUTCMonth() + 1 !== Number(mo)) return null;
    return date;
  }
  if (ZONED_RE.test(s)) {
    const date = new Date(s);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** "Tue 20 Oct, 18:00" in Dubai time. */
export function formatDubai(date: Date, opts: { withYear?: boolean } = {}): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(opts.withYear ? { year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** "18:00" in Dubai time. */
export function formatDubaiTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: APP_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/** Value for <input type="datetime-local">, in Dubai wall-clock time. */
export function toDubaiInput(date: Date): string {
  return new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 16);
}

/** The Dubai calendar day of an instant, as YYYY-MM-DD. */
export function dubaiDayKey(date: Date): string {
  return new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant of Dubai midnight starting the given YYYY-MM-DD. */
export function dubaiMidnight(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00${OFFSET}`);
}

/** Earliest a new post may be scheduled: Meta needs a moment, and so do we. */
export const MIN_LEAD_MS = 2 * 60 * 1000;

/**
 * The clock, for server components. Every page here is dynamic — rendered
 * once per request, never re-rendered on the client — so reading the time
 * during render is intended; this is the one place that does it.
 */
export function requestNow(): number {
  return Date.now();
}
