# Brandloom

Social media manager for five Instagram accounts — Core Champs, JNK Nutrition,
Muscle Rulz, Scoops Monster and ProScience Nutra — on one calendar.

- **Calendar + scheduler**: month/week calendar in Dubai time, per-brand filter,
  drafts → approval → scheduled → published, with a publish log per post.
- **Brand kits + asset library**: colours, handle, voice notes, hashtag sets,
  uploads turned into exact Instagram JPEGs (feed 4:5 1080×1350, story 9:16
  1080×1920), and a profile-grid preview.
- **Automation in, approval out**: captions are written outside the app (in a
  Claude Code chat) and pushed with the `brandloom` CLI or `/api/v1`. Everything
  pushed lands in **Approvals**; nothing reaches Instagram until a person approves it.
- Publishes through Meta's official Instagram Graph API (Facebook Login for Business).

## Stack

Next 16 (App Router) · React 19 · Prisma 6 on Postgres · Better Auth · Tailwind 4 ·
sharp. Deployed on Shipyard like the shop apps; conventions copied from
`../Corechamps` (storage, auth, boot).

| Path | What |
|---|---|
| `src/lib/publish/engine.ts` | Publisher step machine + `claimDue` (FOR UPDATE SKIP LOCKED) |
| `src/lib/publish/scheduler.ts` | One tick: stale-lock recovery, claim, publish, daily token health |
| `scripts/boot.mjs` | Container entrypoint: `next start` + a tick every ~30 s |
| `src/lib/posts.ts` | Status rules / approval gate shared by UI and API |
| `src/lib/meta/*` | Graph client, OAuth, connection binding |
| `src/lib/ingest.ts`, `renditions.ts`, `media-store.ts` | Uploads, Instagram JPEGs, storage |
| `src/app/api/v1/*` | Token API (CLI) |
| `bin/brandloom.mjs` | Zero-dependency CLI |

### Publishing safety

- Each due post is claimed by exactly one process (`FOR UPDATE SKIP LOCKED`), so the
  overlap of two containers during a Shipyard deploy can't double-post.
- Every publish step is saved before the next Graph call. Once `media_publish` has
  been called, a resumed run *asks Instagram* what happened to the container
  instead of publishing again.
- Transient errors retry after 1, 5 and 15 minutes; an expired token marks the
  brand **Needs reconnect**; a per-brand daily cap (25) sits under Meta's 100/24 h.
- Pending posts whose time passes are never published by themselves.

## Local development

```powershell
npm install
npm run db:dev            # private Postgres on :5441 (needs scoop's postgresql)
copy .env.example .env    # then fill the <random> values
npx prisma migrate deploy # schema + the five brands
npm run dev
```

Create your local login: `pwsh -File scripts/set-admin.ps1 -Local` (or sign up at
/login with an address in `ALLOWED_SIGNUP_EMAILS`).

Publishing from a laptop needs a public HTTPS `PUBLIC_BASE_URL` (Meta downloads the
image), e.g. `cloudflared tunnel --url http://localhost:3000`.

### Tests

```powershell
npm test          # unit: crypto, Dubai time, caption limits, renditions, tokens, OAuth state
npm run test:db   # against brandloom_test: concurrent claims, crash-at-publish recovery,
                  # approval gate, idempotency, uploads
```

## CLI

Create a token in **Settings → API tokens**, then once per PC:

```powershell
setx BRANDLOOM_URL "https://brandloom.srv1867587.hstgr.cloud"
setx BRANDLOOM_TOKEN "bl_…"
```

```powershell
node bin/brandloom.mjs brands
node bin/brandloom.mjs post --brand corechamps --type feed  --file poster_4x5.jpg  --caption-file caption.txt --hashtags default --at "2026-10-20 19:00"
node bin/brandloom.mjs post --brand corechamps --type story --file story_9x16.jpg --caption "story note" --at "2026-10-20 19:30"
node bin/brandloom.mjs list --status pending
node bin/brandloom.mjs show <id>
node bin/brandloom.mjs reschedule <id> --at "2026-10-21 19:00"
node bin/brandloom.mjs cancel <id>
```

Times without an offset are Dubai time. Repeating a `post` with the same inputs
returns the same post. Images must be 4:5 (feed) or 9:16 (story) unless `--fit crop|pad`.
Add `--json` for machine-readable output.

## Deploying (Shipyard)

1. GitHub repo `kamal-netizen/brandloom` → import it in the Shipyard dashboard
   (port 3000, branch `main`).
2. Provision the backend with direct DB access (injects `DATABASE_URL`, `DIRECT_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`).
3. Env vars: `MEDIA_STORAGE_URL=http://sb-storage-brandloom:5000`, `BETTER_AUTH_SECRET`,
   `BETTER_AUTH_URL`, `NEXT_PUBLIC_SITE_URL` and `PUBLIC_BASE_URL` (all
   `https://brandloom.srv1867587.hstgr.cloud`), `ALLOWED_SIGNUP_EMAILS`,
   `TOKEN_ENCRYPTION_KEY` (keep an off-box copy), `SCHEDULER_SECRET`, `META_GRAPH_VERSION`.
4. Deploy. `npm start` runs the migrations (schema + brands) and `scripts/boot.mjs`.
5. `pwsh -File scripts/set-admin.ps1` creates your live login.
6. Meta: follow [docs/META_SETUP.md](docs/META_SETUP.md), paste `META_APP_ID`,
   `META_APP_SECRET`, `META_CONFIG_ID`, redeploy, then **Connect** each brand.
