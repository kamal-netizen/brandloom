import { GraphError } from "@/lib/meta/graph";

/**
 * Thin client for TikTok's Open API (open.tiktokapis.com, v2): Login Kit
 * tokens, user info, and the Content Posting API's Direct Post with
 * FILE_UPLOAD (init -> chunked PUT -> status fetch).
 *
 * Errors are TiktokError, a GraphError, so the publisher's retry / audit
 * code treats both platforms alike; TikTok's codes are strings, kept in
 * `ttCode`. The publisher depends on the `Tiktok` interface, not on fetch,
 * so tests stand in a fake TikTok.
 */
export const TT_API = "https://open.tiktokapis.com";
const TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

const TRANSIENT = new Set(["network", "rate_limit_exceeded", "internal_error", "internal"]);
/** The login is gone or lacks a grant: only Connect again fixes it. */
const AUTH = new Set(["access_token_invalid", "scope_not_authorized", "invalid_grant", "auth_removed", "token_not_authorized_for_specified_publish_id"]);
/** The creator (or this app) has used up a daily allowance: wait, don't fail. */
export const TT_QUOTA = new Set(["spam_risk_too_many_posts", "reached_active_user_cap"]);

export class TiktokError extends GraphError {
  constructor(
    message: string,
    httpStatus: number,
    readonly ttCode: string,
    readonly logId?: string
  ) {
    super(message, httpStatus, -2, undefined, message);
  }
  override get transient() {
    return this.httpStatus >= 500 || TRANSIENT.has(this.ttCode);
  }
  override get auth() {
    return AUTH.has(this.ttCode);
  }
  get quota() {
    return TT_QUOTA.has(this.ttCode);
  }
  override get display() {
    return `TikTok: ${this.message || this.ttCode} (${this.ttCode})`;
  }
}

async function send(url: string, init: RequestInit, timeout = TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw new TiktokError(`network: ${(err as Error).message}`, 0, "network");
  }
}

/** Open API envelope: { data, error: { code: "ok" | …, message, log_id } }. */
async function openApi<T>(method: "GET" | "POST", path: string, token: string, body?: unknown): Promise<T> {
  const res = await send(`${TT_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json; charset=UTF-8" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string; log_id?: string; logid?: string } };
  const e = json.error;
  if (!res.ok || (e?.code && e.code !== "ok")) {
    throw new TiktokError(e?.message || `HTTP ${res.status}`, res.status, e?.code || (res.status >= 500 ? "internal_error" : `http_${res.status}`), e?.log_id ?? e?.logid);
  }
  return (json.data ?? {}) as T;
}

// ---------------- Login Kit ----------------

export type TokenSet = {
  openId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  scopes: string;
};

/** OAuth endpoints answer { access_token, … } or { error, error_description, log_id }, form-encoded in. */
async function tokenCall(params: Record<string, string>): Promise<TokenSet> {
  const res = await send(`${TT_API}/v2/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY ?? "", client_secret: process.env.TIKTOK_CLIENT_SECRET ?? "", ...params }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_expires_in?: number;
    open_id?: string;
    scope?: string;
    error?: string;
    error_description?: string;
    log_id?: string;
  };
  if (!res.ok || j.error || !j.access_token) {
    throw new TiktokError(j.error_description || j.error || `HTTP ${res.status}`, res.status || 400, j.error || (res.status >= 500 ? "internal_error" : "invalid_request"), j.log_id);
  }
  const now = Date.now();
  return {
    openId: j.open_id ?? "",
    accessToken: j.access_token,
    accessTokenExpiresAt: new Date(now + (j.expires_in ?? 86_400) * 1000),
    refreshToken: j.refresh_token ?? "",
    refreshTokenExpiresAt: new Date(now + (j.refresh_expires_in ?? 31_536_000) * 1000),
    scopes: j.scope ?? "",
  };
}

export function exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<TokenSet> {
  return tokenCall({ code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: codeVerifier });
}

/** The refresh token may come back different; the caller must keep the new one. */
export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function revokeToken(accessToken: string): Promise<void> {
  await send(`${TT_API}/v2/oauth/revoke/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY ?? "", client_secret: process.env.TIKTOK_CLIENT_SECRET ?? "", token: accessToken }),
  });
}

export async function userInfo(token: string): Promise<{ openId: string; displayName: string; avatarUrl?: string }> {
  const d = await openApi<{ user?: { open_id?: string; display_name?: string; avatar_url?: string } }>(
    "GET",
    "/v2/user/info/?fields=open_id,union_id,avatar_url,display_name",
    token
  );
  return { openId: d.user?.open_id ?? "", displayName: d.user?.display_name ?? "", avatarUrl: d.user?.avatar_url };
}

// ---------------- Content Posting API ----------------

export type PrivacyLevel = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

export type CreatorInfo = {
  nickname: string;
  username: string;
  avatarUrl?: string;
  privacyOptions: PrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSec: number | null;
};

export type PostInfo = {
  title: string;
  privacy_level: PrivacyLevel;
  disable_comment: boolean;
  disable_duet: boolean;
  disable_stitch: boolean;
  brand_content_toggle: boolean;
  brand_organic_toggle: boolean;
};

export type PublishState = "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED";

/** The TikTok operations the publisher needs. */
export interface Tiktok {
  creatorInfo(token: string): Promise<CreatorInfo>;
  /** Direct Post, FILE_UPLOAD. The post goes live when the last chunk lands. */
  initVideo(token: string, post: PostInfo, source: { videoSize: number; chunkSize: number; chunkCount: number }): Promise<{ publishId: string; uploadUrl: string }>;
  /** One PUT. Returns "partial" (206) or "complete" (201). */
  uploadChunk(uploadUrl: string, bytes: Uint8Array, first: number, total: number, mime: string): Promise<"partial" | "complete">;
  status(token: string, publishId: string): Promise<{ status: PublishState; failReason?: string; postIds: string[]; uploadedBytes?: number }>;
}

export const tiktok: Tiktok = {
  async creatorInfo(token) {
    const d = await openApi<{
      creator_nickname?: string;
      creator_username?: string;
      creator_avatar_url?: string;
      privacy_level_options?: PrivacyLevel[];
      comment_disabled?: boolean;
      duet_disabled?: boolean;
      stitch_disabled?: boolean;
      max_video_post_duration_sec?: number;
    }>("POST", "/v2/post/publish/creator_info/query/", token, {});
    return {
      nickname: d.creator_nickname ?? "",
      username: d.creator_username ?? "",
      avatarUrl: d.creator_avatar_url,
      privacyOptions: d.privacy_level_options ?? [],
      commentDisabled: Boolean(d.comment_disabled),
      duetDisabled: Boolean(d.duet_disabled),
      stitchDisabled: Boolean(d.stitch_disabled),
      maxDurationSec: d.max_video_post_duration_sec ?? null,
    };
  },
  async initVideo(token, post, source) {
    const d = await openApi<{ publish_id: string; upload_url: string }>("POST", "/v2/post/publish/video/init/", token, {
      post_info: post,
      source_info: { source: "FILE_UPLOAD", video_size: source.videoSize, chunk_size: source.chunkSize, total_chunk_count: source.chunkCount },
    });
    if (!d.publish_id || !d.upload_url) throw new TiktokError("TikTok did not return an upload address", 500, "internal_error");
    return { publishId: d.publish_id, uploadUrl: d.upload_url };
  },
  async uploadChunk(uploadUrl, bytes, first, total, mime) {
    const res = await send(
      uploadUrl,
      {
        method: "PUT",
        headers: {
          "content-type": mime,
          "content-length": String(bytes.byteLength),
          "content-range": `bytes ${first}-${first + bytes.byteLength - 1}/${total}`,
        },
        body: bytes as BodyInit,
      },
      UPLOAD_TIMEOUT_MS
    );
    await res.arrayBuffer().catch(() => null);
    if (res.status === 201 || res.status === 200) return "complete";
    if (res.status === 206) return "partial";
    const why: Record<number, string> = {
      400: "upload rejected (bad headers or size)",
      403: "upload address expired",
      404: "no upload task for this address",
      416: "byte range does not match the upload so far",
    };
    throw new TiktokError(why[res.status] ?? `upload failed (HTTP ${res.status})`, res.status, res.status >= 500 ? "internal_error" : `upload_${res.status}`);
  },
  async status(token, publishId) {
    const d = await openApi<{ status: PublishState; fail_reason?: string; publicaly_available_post_id?: (string | number)[]; uploaded_bytes?: number }>(
      "POST",
      "/v2/post/publish/status/fetch/",
      token,
      { publish_id: publishId }
    );
    return { status: d.status, failReason: d.fail_reason, postIds: (d.publicaly_available_post_id ?? []).map(String), uploadedBytes: d.uploaded_bytes };
  },
};

// ---------------- chunking ----------------

/** TikTok's rules: chunks 5–64 MB, the last may be up to 128 MB, under 5 MB one chunk, at most 1000. */
export const CHUNK_BYTES = 10 * 1024 * 1024;

export function chunkPlan(size: number, chunk = CHUNK_BYTES): { chunkSize: number; chunkCount: number; ranges: [number, number][] } {
  if (size <= 0) throw new Error("empty video");
  const chunkSize = size < chunk ? size : chunk;
  // Rounded down: the remainder rides on the last chunk (≤ 2 × chunk, well under 128 MB).
  const chunkCount = Math.floor(size / chunkSize);
  const ranges: [number, number][] = [];
  for (let i = 0; i < chunkCount; i++) ranges.push([i * chunkSize, i === chunkCount - 1 ? size : (i + 1) * chunkSize]);
  return { chunkSize, chunkCount, ranges };
}
