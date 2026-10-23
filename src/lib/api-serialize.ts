import type { Brand, Post, PostMedia, Rendition } from "@prisma/client";
import { publicUrl } from "@/lib/media-store";
import { parseSettings } from "@/lib/tiktok/settings";

type PostWithMedia = Post & { brand?: Pick<Brand, "slug">; media?: (PostMedia & { rendition: Rendition })[] };

/** The /api/v1 shape of a post. Times are ISO-8601 UTC. */
export function serializePost(p: PostWithMedia) {
  const app = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return {
    id: p.id,
    brand: p.brand?.slug,
    type: p.type.toLowerCase(),
    platform: p.platform.toLowerCase(),
    status: p.status.toLowerCase(),
    caption: p.caption,
    scheduledAt: p.scheduledAt?.toISOString() ?? null,
    publishOnApprove: p.publishOnApprove,
    externalRef: p.externalRef,
    source: p.source.toLowerCase(),
    approvedAt: p.approvedAt?.toISOString() ?? null,
    rejectNote: p.rejectNote,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    permalink: p.igPermalink,
    ...(p.platform === "TIKTOK" ? { tiktok: { ...parseSettings(p.tiktokJson), publishId: p.igContainerId, step: p.publishStep.toLowerCase() } } : {}),
    lastError: p.lastError,
    media: (p.media ?? []).map((m) => ({ assetId: m.assetId, url: publicUrl(m.rendition.key), width: m.rendition.width, height: m.rendition.height })),
    reviewUrl: `${app}/posts/${p.id}`,
    createdAt: p.createdAt.toISOString(),
  };
}
