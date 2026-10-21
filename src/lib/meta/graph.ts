/**
 * Thin Graph API client: plain fetch, version pinned by META_GRAPH_VERSION.
 *
 * Publishing uses the Instagram API with Facebook Login: the IG professional
 * account is reached through its Facebook Page, and every call carries that
 * Page's access token.
 *
 * The publisher depends on the `Graph` interface, not on fetch, so tests can
 * stand in a fake Instagram.
 */
export const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v24.0";
export const FB_GRAPH = "https://graph.facebook.com";
/** Instagram API with Instagram Login: same endpoints, Instagram's own host and tokens. */
export const IG_GRAPH = "https://graph.instagram.com";
const TIMEOUT_MS = 30_000;

/** Codes Meta documents as temporary / throttling, plus our own -1 for network failure. */
const TRANSIENT_CODES = new Set([-1, 1, 2, 4, 17, 32, 341, 368, 613, 9004, 2207001, 2207051]);
/** Token expired, revoked, or the user changed password. */
const AUTH_CODES = new Set([102, 190]);

export class GraphError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: number,
    readonly subcode?: number,
    readonly userMessage?: string
  ) {
    super(message);
  }
  get transient() {
    return this.httpStatus >= 500 || TRANSIENT_CODES.has(this.code);
  }
  get auth() {
    return AUTH_CODES.has(this.code);
  }
  /** What a person should read: Meta's own user-facing text when it gives one. */
  get display() {
    return this.userMessage ? `${this.userMessage} (${this.code})` : `${this.message} (${this.code})`;
  }
}

type Params = Record<string, string | number | undefined>;

export async function graphCall<T>(method: "GET" | "POST", path: string, params: Params, host = FB_GRAPH): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  // Absolute URLs (api.instagram.com's token exchange) pass through unversioned.
  const url = /^https:\/\//.test(path) ? path : `${host}/${GRAPH_VERSION}/${path.replace(/^\//, "")}`;
  let res: Response;
  try {
    res =
      method === "GET"
        ? await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        : await fetch(url, {
            method: "POST",
            body: qs,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
  } catch (err) {
    throw new GraphError(`network: ${(err as Error).message}`, 0, -1);
  }
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string };
  } & T;
  if (!res.ok || body.error) {
    const e = body.error ?? {};
    throw new GraphError(e.message ?? `HTTP ${res.status}`, res.status, e.code ?? -1, e.error_subcode, e.error_user_msg);
  }
  return body as T;
}

export type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

/** The Instagram operations the publisher needs. */
export interface Graph {
  createImageContainer(igUserId: string, token: string, args: { imageUrl: string; caption?: string; story?: boolean }): Promise<string>;
  /** Instagram reel container (media_type=REELS). Video processing can take minutes: poll containerStatus. */
  createReelContainer(igUserId: string, token: string, args: { videoUrl: string; caption?: string; shareToFeed: boolean }): Promise<string>;
  containerStatus(containerId: string, token: string): Promise<{ status: ContainerStatus; detail?: string }>;
  publish(igUserId: string, token: string, containerId: string): Promise<string>;
  permalink(mediaId: string, token: string): Promise<string | null>;
  recentMedia(igUserId: string, token: string, limit?: number): Promise<{ id: string; timestamp: string; permalink?: string }[]>;
  publishingLimit(igUserId: string, token: string): Promise<{ used: number; total: number } | null>;

  // ---- Facebook Page publishing (graph.facebook.com, Page token, pages_manage_posts) ----
  /** A photo on the Page. published=false uploads it for a story; returns the photo id and, when published, the feed post id. */
  fbPhoto(pageId: string, token: string, args: { url: string; message?: string; published: boolean }): Promise<{ photoId: string; postId?: string }>;
  /** Turns an unpublished Page photo into a Page story; returns the story's post id. */
  fbPhotoStory(pageId: string, token: string, photoId: string): Promise<string>;
  fbPermalink(postId: string, token: string): Promise<string | null>;
  /** Most recent Page feed posts or stories, for verifying an interrupted publish. */
  fbRecent(pageId: string, token: string, story: boolean): Promise<{ id: string; time: string; permalink?: string }[]>;

  // ---- Facebook Page reels: start -> upload by URL -> finish (publish) -> poll ----
  fbReelStart(pageId: string, token: string): Promise<{ videoId: string; uploadUrl: string }>;
  fbReelUpload(uploadUrl: string, token: string, fileUrl: string): Promise<void>;
  fbReelFinish(pageId: string, token: string, videoId: string, description: string): Promise<void>;
  /** complete = published on the Page; processing = ask again later; error = Facebook rejected it. */
  fbReelStatus(videoId: string, token: string): Promise<{ state: "complete" | "processing" | "error"; detail?: string; permalink?: string }>;
}

/** A Graph client bound to one host. */
export function makeGraph(host: string): Graph {
  const call = <T>(method: "GET" | "POST", path: string, params: Params): Promise<T> => graphCall<T>(method, path, params, host);
  return {
  async createImageContainer(igUserId, token, { imageUrl, caption, story }) {
    const r = await call<{ id: string }>("POST", `${igUserId}/media`, {
      image_url: imageUrl,
      // Stories take no caption; sending one is an error on some versions.
      caption: story ? undefined : caption,
      media_type: story ? "STORIES" : undefined,
      access_token: token,
    });
    return r.id;
  },
  async createReelContainer(igUserId, token, { videoUrl, caption, shareToFeed }) {
    const r = await call<{ id: string }>("POST", `${igUserId}/media`, {
      media_type: "REELS",
      video_url: videoUrl,
      caption,
      share_to_feed: shareToFeed ? "true" : "false",
      access_token: token,
    });
    return r.id;
  },
  async containerStatus(containerId, token) {
    const r = await call<{ status_code: ContainerStatus; status?: string }>("GET", containerId, {
      fields: "status_code,status",
      access_token: token,
    });
    return { status: r.status_code, detail: r.status };
  },
  async publish(igUserId, token, containerId) {
    const r = await call<{ id: string }>("POST", `${igUserId}/media_publish`, { creation_id: containerId, access_token: token });
    return r.id;
  },
  async permalink(mediaId, token) {
    const r = await call<{ permalink?: string }>("GET", mediaId, { fields: "permalink", access_token: token });
    return r.permalink ?? null;
  },
  async recentMedia(igUserId, token, limit = 10) {
    const r = await call<{ data: { id: string; timestamp: string; permalink?: string }[] }>("GET", `${igUserId}/media`, {
      fields: "id,timestamp,permalink",
      limit,
      access_token: token,
    });
    return r.data ?? [];
  },
  async fbPhoto(pageId, token, { url, message, published }) {
    const r = await call<{ id: string; post_id?: string }>("POST", `${pageId}/photos`, {
      url,
      message: published ? message : undefined,
      published: published ? "true" : "false",
      access_token: token,
    });
    return { photoId: r.id, postId: r.post_id };
  },
  async fbPhotoStory(pageId, token, photoId) {
    const r = await call<{ post_id?: string; success?: boolean }>("POST", `${pageId}/photo_stories`, { photo_id: photoId, access_token: token });
    if (!r.post_id) throw new GraphError("Facebook did not return a story id", 500, -1);
    return r.post_id;
  },
  async fbPermalink(postId, token) {
    const r = await call<{ permalink_url?: string }>("GET", postId, { fields: "permalink_url", access_token: token });
    return r.permalink_url ?? null;
  },
  async fbRecent(pageId, token, story) {
    if (story) {
      const r = await call<{ data?: { post_id: string; creation_time?: string; url?: string }[] }>("GET", `${pageId}/stories`, {
        fields: "post_id,creation_time,url",
        access_token: token,
      });
      return (r.data ?? []).map((x) => ({ id: x.post_id, time: x.creation_time ? new Date(Number(x.creation_time) * 1000 || x.creation_time).toISOString() : "", permalink: x.url }));
    }
    const r = await call<{ data?: { id: string; created_time: string; permalink_url?: string }[] }>("GET", `${pageId}/published_posts`, {
      fields: "id,created_time,permalink_url",
      limit: 10,
      access_token: token,
    });
    return (r.data ?? []).map((x) => ({ id: x.id, time: new Date(x.created_time).toISOString(), permalink: x.permalink_url }));
  },
  async fbReelStart(pageId, token) {
    const r = await call<{ video_id: string; upload_url: string }>("POST", `${pageId}/video_reels`, { upload_phase: "start", access_token: token });
    return { videoId: r.video_id, uploadUrl: r.upload_url };
  },
  async fbReelUpload(uploadUrl, token, fileUrl) {
    let res: Response;
    try {
      res = await fetch(uploadUrl, {
        method: "POST",
        headers: { Authorization: `OAuth ${token}`, file_url: fileUrl },
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new GraphError(`network: ${(err as Error).message}`, 0, -1);
    }
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; debug_info?: { message?: string } };
    if (!res.ok || body.success === false) {
      throw new GraphError(body.debug_info?.message ?? `Facebook reel upload failed (HTTP ${res.status})`, res.status, -1);
    }
  },
  async fbReelFinish(pageId, token, videoId, description) {
    await call("POST", `${pageId}/video_reels`, {
      upload_phase: "finish",
      video_id: videoId,
      video_state: "PUBLISHED",
      description,
      access_token: token,
    });
  },
  async fbReelStatus(videoId, token) {
    const r = await call<{
      status?: {
        video_status?: string;
        processing_phase?: { status?: string; error?: { message?: string } };
        publishing_phase?: { status?: string; publish_status?: string; error?: { message?: string } };
      };
      permalink_url?: string;
    }>("GET", videoId, { fields: "status,permalink_url", access_token: token });
    const s = r.status ?? {};
    const err = s.processing_phase?.error?.message ?? s.publishing_phase?.error?.message;
    const permalink = r.permalink_url ? (r.permalink_url.startsWith("http") ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`) : undefined;
    if (s.video_status === "error" || err) return { state: "error", detail: err ?? "Facebook could not process the video", permalink };
    if (s.publishing_phase?.status === "complete") return { state: "complete", permalink };
    return { state: "processing", permalink };
  },
  async publishingLimit(igUserId, token) {
    const r = await call<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(
      "GET",
      `${igUserId}/content_publishing_limit`,
      { fields: "config,quota_usage", access_token: token }
    );
    const row = r.data?.[0];
    if (!row) return null;
    return { used: row.quota_usage ?? 0, total: row.config?.quota_total ?? 100 };
  },
  };
}

export const graph: Graph = makeGraph(FB_GRAPH);
export const igGraph: Graph = makeGraph(IG_GRAPH);

/** The client for a connection: Instagram-login accounts live on graph.instagram.com. */
export function graphFor(conn: { loginType: string }): Graph {
  return conn.loginType === "INSTAGRAM" ? igGraph : graph;
}
