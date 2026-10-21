#!/usr/bin/env node
/**
 * brandloom — push posts into Brandloom from a terminal (or from Claude Code).
 * Zero dependencies, Node 20+. Reads BRANDLOOM_URL and BRANDLOOM_TOKEN from
 * the environment; the token is never printed.
 *
 *   brandloom whoami
 *   brandloom brands
 *   brandloom post --brand corechamps --type feed|story|reel --file poster.jpg|reel.mp4
 *                  (--caption "…" | --caption-file caption.txt) [--hashtags default|<set>]
 *                  [--platforms instagram|facebook|instagram,facebook]   (default instagram)
 *                  [--at "2026-10-20 19:00" | --at 2026-10-20T19:00+04:00 | --now] [--draft]
 *                  [--fit reject|crop|pad] [--ref <idempotency key>] [--json]
 *   brandloom list [--brand x] [--status pending|scheduled|published|failed|draft] [--from …] [--to …] [--json]
 *   brandloom show <id> [--json]
 *   brandloom reschedule <id> --at "2026-10-21 19:00"
 *   brandloom cancel <id>
 *   brandloom quota --brand x
 *   brandloom rights [--brand x]      (asks Meta now: can we post / story on Instagram and Facebook?)
 *
 * Times without an offset are Dubai time. Posts land as PENDING_APPROVAL:
 * someone approves them in the app before they can reach Instagram.
 * A repeated `post` with the same inputs returns the existing post
 * (the default --ref is a hash of brand, type, file bytes, caption and time).
 *
 * Exit codes: 0 ok · 2 bad arguments / validation · 3 auth · 4 server or network.
 */
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime" };

class CliError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    const flag = ["json", "now", "draft", "help"].includes(k);
    const v = inline !== undefined ? inline : flag ? true : argv[++i];
    if (v === undefined) throw new CliError(`--${k} needs a value`);
    if (k === "file") (opt.file ??= []).push(v);
    else opt[k] = v;
  }
  return { pos, opt };
}

function env() {
  const url = (process.env.BRANDLOOM_URL || "").replace(/\/+$/, "");
  const token = process.env.BRANDLOOM_TOKEN || "";
  if (!url) throw new CliError("BRANDLOOM_URL is not set (e.g. https://brandloom.srv1867587.hstgr.cloud)", 3);
  if (!token) throw new CliError("BRANDLOOM_TOKEN is not set (create one in Settings → API tokens)", 3);
  return { url, token };
}

async function call(method, route, { body, headers = {} } = {}) {
  const { url, token } = env();
  let res;
  try {
    res = await fetch(`${url}/api/v1${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new CliError(`Could not reach ${url}: ${err.message}`, 4);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CliError(`Server answered ${res.status} with non-JSON: ${text.slice(0, 200)}`, 4);
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    throw new CliError(msg, res.status === 401 || res.status === 403 ? 3 : res.status >= 500 ? 4 : 2);
  }
  return json;
}

function fmt(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function line(p) {
  const when = p.publishedAt ? `published ${fmt(p.publishedAt)}` : p.scheduledAt ? fmt(p.scheduledAt) : p.publishOnApprove ? "on approval" : "no time";
  return `${p.id}  ${p.brand.padEnd(13)} ${(p.platform ?? "instagram").padEnd(9)} ${p.type.padEnd(5)} ${p.status.padEnd(16)} ${when}${p.permalink ? `  ${p.permalink}` : ""}${p.lastError ? `  ! ${p.lastError}` : ""}`;
}

function out(opt, data, human) {
  if (opt.json) console.log(JSON.stringify(data, null, 2));
  else console.log(human(data));
}

async function cmdPost(opt) {
  if (!opt.brand) throw new CliError("--brand is required");
  const type = String(opt.type || "").toLowerCase();
  if (type !== "feed" && type !== "story" && type !== "reel") throw new CliError("--type must be feed, story or reel");
  const files = opt.file ?? [];
  if (files.length !== 1) throw new CliError("pass exactly one --file");
  if (opt.caption && opt["caption-file"]) throw new CliError("use --caption or --caption-file, not both");
  const caption = opt["caption-file"] ? await readFile(opt["caption-file"], "utf8") : opt.caption ?? "";
  if (opt.at && opt.now) throw new CliError("use --at or --now, not both");

  const form = new FormData();
  form.set("brand", opt.brand);
  form.set("type", type);
  form.set("caption", caption.replace(/\r\n/g, "\n").trim());
  if (opt.hashtags) form.set("hashtagSet", opt.hashtags);
  if (opt.at) form.set("scheduledAt", opt.at);
  if (opt.now) form.set("publishNow", "true");
  if (opt.draft) form.set("status", "draft");
  if (opt.fit) form.set("fit", opt.fit);
  if (opt.platforms) form.set("platforms", String(opt.platforms));

  // Platforms are not in the key: the server suffixes it per platform, so adding
  // facebook to a command that already ran for instagram creates only the new one.
  const hash = createHash("sha256").update(`${opt.brand}\n${type}\n${caption}\n${opt.at ?? ""}\n${opt.now ? "now" : ""}\n`);
  for (const f of files) {
    const mime = MIME[path.extname(f).toLowerCase()];
    if (!mime) throw new CliError(`${f}: only .png, .jpg, .jpeg, .webp (or .mp4 / .mov for a reel)`);
    let bytes;
    try {
      bytes = await readFile(f);
    } catch {
      throw new CliError(`${f}: cannot read file`);
    }
    hash.update(bytes);
    form.append("files", new File([await openAsBlob(f)], path.basename(f), { type: mime }));
  }
  const ref = opt.ref ?? `cli-${hash.digest("hex").slice(0, 32)}`;
  const res = await call("POST", "/posts", { body: form, headers: { "idempotency-key": ref } });
  out(opt, res, (r) =>
    (r.posts ?? [{ post: r.post, created: r.created }])
      .map((x) => `${x.created ? "created" : "already exists"}: ${line(x.post)}\nreview: ${x.post.reviewUrl}`)
      .join("\n")
  );
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const [cmd, arg] = pos;
  if (!cmd || opt.help || cmd === "help") {
    const src = await readFile(new URL(import.meta.url), "utf8");
    console.log(src.split("*/")[0].replace(/^#!.*\n\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
    return;
  }
  switch (cmd) {
    case "whoami":
      return out(opt, await call("GET", "/me"), (r) => `${r.token.name} (${r.token.prefix}…) scopes: ${r.token.scopes.join(", ")}`);
    case "brands":
      return out(opt, await call("GET", "/brands"), (r) =>
        r.brands
          .map((b) => `${b.slug.padEnd(14)} ${b.name.padEnd(18)} ${b.connection ? `@${b.connection.username} (${b.connection.status})` : "not connected"}  sets: ${b.hashtagSets.map((h) => h.name).join(", ") || "—"}`)
          .join("\n")
      );
    case "post":
      return cmdPost(opt);
    case "list": {
      const q = new URLSearchParams();
      for (const k of ["brand", "status", "from", "to", "limit", "cursor"]) if (opt[k]) q.set(k, opt[k]);
      return out(opt, await call("GET", `/posts?${q}`), (r) => (r.posts.length ? r.posts.map(line).join("\n") : "no posts") + (r.nextCursor ? `\n… more: --cursor ${r.nextCursor}` : ""));
    }
    case "show":
      if (!arg) throw new CliError("show <id>");
      return out(opt, await call("GET", `/posts/${encodeURIComponent(arg)}`), (r) =>
        [line(r.post), "", r.post.caption, "", ...r.post.media.map((m) => `image: ${m.url}`), `review: ${r.post.reviewUrl}`, ...r.post.attempts.map((a) => `  ${fmt(a.at)} ${a.step} ${a.ok ? "ok" : a.error ?? ""}`)].join("\n")
      );
    case "reschedule":
      if (!arg || !opt.at) throw new CliError("reschedule <id> --at <time>");
      return out(
        opt,
        await call("PATCH", `/posts/${encodeURIComponent(arg)}`, { body: JSON.stringify({ scheduledAt: opt.at }), headers: { "content-type": "application/json" } }),
        (r) => line(r.post)
      );
    case "cancel":
      if (!arg) throw new CliError("cancel <id>");
      return out(opt, await call("DELETE", `/posts/${encodeURIComponent(arg)}`), (r) => line(r.post));
    case "rights": {
      const q = new URLSearchParams();
      if (opt.brand) q.set("brand", opt.brand);
      q.set("refresh", "1");
      const mark = (r) => (r?.ok ? "ok " : "NO ");
      return out(opt, await call("GET", `/rights?${q}`), (r) =>
        r.brands
          .map((b) =>
            !b.connected
              ? `${b.brand.padEnd(14)} not connected`
              : `${b.brand.padEnd(14)} @${b.account} (${b.via})\n` +
                [
                  ["IG post", b.rights.instagram.feed],
                  ["IG story", b.rights.instagram.story],
                  ["FB post", b.rights.facebook.feed],
                  ["FB story", b.rights.facebook.story],
                ]
                  .map(([l, x]) => `   ${mark(x)} ${l.padEnd(9)} ${x.ok ? "" : x.reason}`)
                  .join("\n")
          )
          .join("\n")
      );
    }
    case "quota":
      if (!opt.brand) throw new CliError("quota --brand <slug>");
      return out(opt, await call("GET", `/quota?brand=${encodeURIComponent(opt.brand)}`), (r) =>
        `${r.brand}: ${r.published24h} published in 24 h (cap ${r.dailyCap})${r.instagram ? ` · Instagram: ${r.instagram.used}/${r.instagram.total}` : ""}`
      );
    default:
      throw new CliError(`unknown command ${cmd} (try: brandloom help)`);
  }
}

main().catch((err) => {
  console.error(`brandloom: ${err.message}`);
  process.exit(err instanceof CliError ? err.code : 4);
});
