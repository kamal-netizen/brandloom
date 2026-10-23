# TikTok setup (Login Kit + Content Posting API, Direct Post)

Brandloom publishes reels to a brand's TikTok account with TikTok's official
APIs: **Login Kit** to connect the account, the **Content Posting API**
(Direct Post, `FILE_UPLOAD`) to post. Code: `src/lib/tiktok/*`, the TikTok
branch of `src/lib/publish/engine.ts`, `src/app/api/tiktok/*`.

## The TikTok app

TikTok for Developers → app **brandloom** (id 7699744000614418452):

- Products: Login Kit, Content Posting API with **Direct Post** on.
- Scopes: `user.info.basic`, `video.publish`, `video.upload`.
- Web redirect URI: `https://brandloom.srv1867587.hstgr.cloud/api/tiktok/callback`
  (must match `PUBLIC_BASE_URL` + `/api/tiktok/callback` exactly).
- URL prefix `https://brandloom.srv1867587.hstgr.cloud/` verified (signature file in `public/`).
- Terms: `/terms`, privacy: `/privacy` (both public, see `src/proxy.ts`).

## Environment (Shipyard → brandloom → Environment)

| Variable | What |
|---|---|
| `TIKTOK_CLIENT_KEY` | Client key — the **Sandbox** one while testing, the Production one after approval |
| `TIKTOK_CLIENT_SECRET` | Client secret for the same environment. Paste it yourself; never in chat, git or logs |
| `TIKTOK_PRIVATE_ONLY` | `1` (default when unset): every TikTok post goes out `SELF_ONLY` (Only me). Set `0` only after TikTok has approved the app |

Env changes apply on the next deploy. Sandbox and Production keys are
different apps to TikTok: tokens from one do not work with the other, so
**reconnect every brand after switching keys**.

## Sandbox test (needed for the first review's demo video)

1. TikTok for Developers → brandloom → **Sandbox** → create/open the sandbox,
   add the same products and scopes, and the same redirect URI.
2. Sandbox → **Target users**: add the TikTok accounts that will connect (the
   Core Champs and JNK accounts, or a test account). Only target users can log in.
3. Unaudited apps can only post to **private** accounts: in the TikTok app set
   the target account to *Private account* for the test (switch back after).
4. Paste the sandbox client key + secret into Shipyard, redeploy.
5. Brandloom → Brands → Core Champs → **Connect TikTok** → log in as the target
   user → allow.
6. New post → Reel → pick a 9:16 MP4 → tick TikTok → choose *Only me* → Publish now.
   The post page shows the publish log (`TT_CREATOR_INFO`, `TT_INIT`,
   `TT_UPLOAD n/m`, `TT_STATUS`) and ends *Published*; the video is on the
   account's profile as a private video.

## How a post is published

1. `creator_info/query` — fresh each time (privacy options, max duration, whether it can post now).
2. `video/init` with `post_info` (title = caption, chosen privacy — forced
   `SELF_ONLY` while `TIKTOK_PRIVATE_ONLY` — interactions, disclosure) and
   `source_info` `FILE_UPLOAD`, 10 MB chunks (the remainder rides on the last).
3. `PUT` each chunk to the upload URL. `PUBLISH_CALLED` is saved before the last
   chunk; after that a resumed run only polls, never re-inits.
4. `status/fetch` until `PUBLISH_COMPLETE` (or `FAILED`), across scheduler ticks.

Access tokens last 24 h; the scheduler refreshes them 2 h ahead. The refresh
token lasts a year from the first login, so each brand reconnects about once a
year (the brand page warns 14 days ahead). Disconnect revokes the login at
TikTok and erases both tokens.

## App review

TikTok checks the posting UI against its Direct Post rules. The composer
implements them: the account's nickname, a privacy dropdown with no default
(options from `creator_info`), Comment / Duet / Stitch off by default and greyed
out where the account disables them, the commercial-content disclosure (Your
brand / Branded content with their labels), the Music Usage Confirmation /
Branded Content Policy declaration, a preview, and the post status.
Record the demo video in the Sandbox, end to end: connect → compose (show each
control) → publish → status → the private video in the TikTok app.
