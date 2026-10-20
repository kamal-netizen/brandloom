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
  containerStatus(containerId: string, token: string): Promise<{ status: ContainerStatus; detail?: string }>;
  publish(igUserId: string, token: string, containerId: string): Promise<string>;
  permalink(mediaId: string, token: string): Promise<string | null>;
  recentMedia(igUserId: string, token: string, limit?: number): Promise<{ id: string; timestamp: string; permalink?: string }[]>;
  publishingLimit(igUserId: string, token: string): Promise<{ used: number; total: number } | null>;
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
