import type { IgConnection } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { graphCall, graphFor, GraphError, IG_GRAPH } from "./graph";
import { inspectToken, metaConfigured } from "./oauth";

/**
 * "Can Brandloom actually post here?" — answered by Meta, not assumed.
 *
 * For each of the four targets (Instagram feed / story, Facebook feed /
 * story) a check needs both: the token carries the permission Meta requires
 * for that publish call, and a harmless read with the same token succeeds
 * (so a revoked token or a lost Page role shows up now, not at 19:00).
 *
 *   Instagram via Facebook login: instagram_basic + instagram_content_publish,
 *     live: GET /{ig-user}/content_publishing_limit
 *   Instagram via Instagram login: the token itself (scopes were granted at
 *     connect), live: GET graph.instagram.com/{ig-user}/content_publishing_limit,
 *     which needs instagram_business_content_publish
 *   Facebook Page feed and story: pages_manage_posts (+ pages_read_engagement
 *     to verify an interrupted publish), live: GET /{page}?fields=id,name
 *     with the Page token
 * Stories use the same permission as the feed on each platform.
 */
export type Right = { ok: boolean; reason: string };
export type Rights = {
  checkedAt: string;
  instagram: { feed: Right; story: Right };
  facebook: { feed: Right; story: Right };
};

const OK: Right = { ok: true, reason: "ready" };

function both(r: Right) {
  return { feed: r, story: r };
}

function missing(scopes: string[], need: string[]): string[] {
  return need.filter((s) => !scopes.includes(s));
}

export async function checkRights(conn: IgConnection): Promise<Rights> {
  const token = decrypt(conn.pageTokenEnc);
  const out: Rights = {
    checkedAt: new Date().toISOString(),
    instagram: both({ ok: false, reason: "not checked" }),
    facebook: both({ ok: false, reason: "not checked" }),
  };

  if (conn.loginType === "INSTAGRAM") {
    out.facebook = both({ ok: false, reason: "No Facebook Page: this brand is connected through Instagram login." });
    try {
      await graphFor(conn).publishingLimit(conn.igUserId, token);
      // Fetch once more against the account itself, which fails on a revoked token.
      await graphCall("GET", "me", { fields: "user_id,username", access_token: token }, IG_GRAPH);
      out.instagram = both(OK);
    } catch (err) {
      out.instagram = both({ ok: false, reason: describe(err) });
    }
    return out;
  }

  // Facebook login: the Page token's grant.
  let scopes: string[] = [];
  let tokenOk = true;
  if (metaConfigured()) {
    try {
      const t = await inspectToken(token);
      tokenOk = t.valid;
      scopes = t.scopes;
    } catch (err) {
      tokenOk = false;
      out.instagram = both({ ok: false, reason: `Token check failed: ${describe(err)}` });
      out.facebook = both({ ok: false, reason: `Token check failed: ${describe(err)}` });
      return out;
    }
  }
  if (!tokenOk) {
    const r = { ok: false, reason: "The connection's token is no longer valid — Reconnect." };
    out.instagram = both(r);
    out.facebook = both(r);
    return out;
  }

  const igMissing = missing(scopes, ["instagram_basic", "instagram_content_publish"]);
  if (igMissing.length) out.instagram = both({ ok: false, reason: `Missing permission: ${igMissing.join(", ")} — Reconnect.` });
  else {
    try {
      await graphFor(conn).publishingLimit(conn.igUserId, token);
      out.instagram = both(OK);
    } catch (err) {
      out.instagram = both({ ok: false, reason: describe(err) });
    }
  }

  if (!conn.fbPageId) out.facebook = both({ ok: false, reason: "No Facebook Page linked." });
  else {
    const fbMissing = missing(scopes, ["pages_manage_posts", "pages_read_engagement"]);
    if (fbMissing.length) out.facebook = both({ ok: false, reason: `Missing permission: ${fbMissing.join(", ")} — add it to the Meta app, then Reconnect.` });
    else {
      try {
        await graphCall("GET", conn.fbPageId, { fields: "id,name", access_token: token });
        out.facebook = both(OK);
      } catch (err) {
        out.facebook = both({ ok: false, reason: describe(err) });
      }
    }
  }
  return out;
}

function describe(err: unknown): string {
  return err instanceof GraphError ? err.display : (err as Error).message;
}

/** Runs the check and stores it on the connection. */
export async function refreshRights(conn: IgConnection): Promise<Rights> {
  const rights = await checkRights(conn);
  await db.igConnection.update({ where: { id: conn.id }, data: { rightsJson: JSON.stringify(rights), rightsCheckedAt: new Date() } });
  return rights;
}

export function storedRights(conn: Pick<IgConnection, "rightsJson">): Rights | null {
  if (!conn.rightsJson) return null;
  try {
    return JSON.parse(conn.rightsJson) as Rights;
  } catch {
    return null;
  }
}
