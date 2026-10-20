import type { Brand, Post } from "@prisma/client";
import { db } from "@/lib/db";
import { appendHashtags, brandRuleViolations, checkCaption } from "@/lib/caption";
import { ensureRendition, IngestError } from "@/lib/ingest";
import { purposeFor, type Fit } from "@/lib/renditions";
import { CANCELLABLE, EDITABLE, type Platform, type PostStatus, type PostType } from "@/lib/status";
import { MIN_LEAD_MS } from "@/lib/time";

/**
 * Post rules shared by the UI (server actions) and /api/v1, so the approval
 * gate cannot be bypassed by picking the other door.
 *
 * The gate: publishing to a brand's Instagram is public and can't be taken
 * back, the brands sell supplements (claims are regulated in the UAE), and
 * captions are often written by an agent. So a post only becomes SCHEDULED
 * through someone allowed to approve — an admin in the UI, or a token that
 * explicitly carries posts:approve. Everything else waits in PENDING_APPROVAL,
 * and a pending post whose time passes is never published by itself.
 */
export class PostError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
  }
}

export type CreatePostInput = {
  brand: Brand;
  type: PostType;
  platform?: Platform;
  caption: string;
  hashtagSet?: string; // a set name, or "default"
  assetIds: string[];
  fit?: Fit;
  scheduledAt?: Date | null;
  publishNow?: boolean;
  desired?: "draft" | "pending" | "scheduled";
  source: "UI" | "API";
  externalRef?: string | null;
  createdByUserId?: string | null;
  createdByTokenId?: string | null;
  canApprove: boolean;
};

/** Form posts (multipart, textareas) turn every newline into CRLF; captions are stored with LF. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export async function resolveCaption(brandId: string, rawCaption: string, hashtagSet?: string): Promise<string> {
  const caption = normaliseNewlines(rawCaption).trim();
  if (!hashtagSet) return caption;
  const set =
    hashtagSet === "default"
      ? await db.hashtagSet.findFirst({ where: { brandId, isDefault: true } })
      : await db.hashtagSet.findUnique({ where: { brandId_name: { brandId, name: hashtagSet } } });
  if (!set) throw new PostError(`No hashtag set "${hashtagSet}" for this brand.`);
  return appendHashtags(caption, set.tags);
}

function assertBrandRules(brand: Pick<Brand, "name" | "blockedTerms">, caption: string) {
  const bad = brandRuleViolations(caption, brand.blockedTerms);
  if (bad.length) {
    throw new PostError(`${brand.name} is an international brand: the caption may not mention ${bad.join(", ")}.`, 400, "brand_rule");
  }
}

function assertFuture(at: Date) {
  if (at.getTime() < Date.now() + MIN_LEAD_MS) throw new PostError("Scheduled time must be at least 2 minutes from now.");
}

export async function createPost(input: CreatePostInput): Promise<{ post: Post; created: boolean }> {
  const { brand } = input;
  if (input.externalRef) {
    const existing = await db.post.findUnique({ where: { brandId_externalRef: { brandId: brand.id, externalRef: input.externalRef } } });
    if (existing) return { post: existing, created: false };
  }
  if (input.assetIds.length !== 1) throw new PostError("Feed and story posts take exactly one image.");

  const caption = await resolveCaption(brand.id, input.caption ?? "", input.hashtagSet);
  const check = checkCaption(caption);
  if (!check.ok) throw new PostError(check.errors.join(" "), 400, "caption");
  assertBrandRules(brand, caption);

  const desired = input.desired ?? (input.source === "UI" ? "draft" : "pending");
  let status: PostStatus;
  let scheduledAt = input.scheduledAt ?? null;
  if (scheduledAt && !input.publishNow) assertFuture(scheduledAt);

  if (desired === "draft") status = "DRAFT";
  else if (desired === "scheduled") {
    if (!input.canApprove) throw new PostError("This token may not schedule directly; omit status to submit for approval.", 403, "forbidden");
    if (input.publishNow) scheduledAt = new Date();
    if (!scheduledAt) throw new PostError("A scheduled post needs a time (or publishNow).");
    status = "SCHEDULED";
  } else {
    status = scheduledAt || input.publishNow ? "PENDING_APPROVAL" : "DRAFT";
  }

  const asset = await db.asset.findFirst({ where: { id: input.assetIds[0], brandId: brand.id } });
  if (!asset) throw new PostError("Image not found for this brand.", 404, "not_found");
  let rendition;
  try {
    rendition = await ensureRendition(asset, brand, purposeFor(input.type), input.fit ?? "reject");
  } catch (err) {
    if (err instanceof IngestError) throw new PostError(err.message, err.status, "media");
    throw err;
  }

  try {
    const post = await db.post.create({
      data: {
        brandId: brand.id,
        type: input.type,
        platform: input.platform ?? "INSTAGRAM",
        status,
        caption,
        scheduledAt,
        publishOnApprove: Boolean(input.publishNow) && status === "PENDING_APPROVAL",
        source: input.source,
        externalRef: input.externalRef ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByTokenId: input.createdByTokenId ?? null,
        ...(status === "SCHEDULED" && input.createdByUserId
          ? { approvedByUserId: input.createdByUserId, approvedAt: new Date() }
          : {}),
        media: { create: [{ assetId: asset.id, renditionId: rendition.id, position: 0 }] },
      },
    });
    return { post, created: true };
  } catch (err) {
    // Two identical requests racing on the same idempotency key.
    if (input.externalRef) {
      const existing = await db.post.findUnique({ where: { brandId_externalRef: { brandId: brand.id, externalRef: input.externalRef } } });
      if (existing) return { post: existing, created: false };
    }
    throw err;
  }
}

async function load(id: string) {
  const post = await db.post.findUnique({ where: { id } });
  if (!post) throw new PostError("Post not found.", 404, "not_found");
  return post;
}

export type ApproveMode = "keep" | "now" | "at";

/**
 * Approves a pending (or draft) post. Returns whether the caller should run
 * the publisher right away.
 *  keep — use the post's own time (refused if that time has passed: an
 *         overdue post is never published without someone choosing "now");
 *  now  — publish immediately; at — publish at `at`.
 */
export async function approvePost(id: string, userId: string, mode: ApproveMode, at?: Date | null): Promise<{ publishNow: boolean }> {
  const post = await load(id);
  if (post.status !== "PENDING_APPROVAL" && post.status !== "DRAFT") throw new PostError(`Cannot approve a ${post.status} post.`, 409, "conflict");

  let when: Date;
  if (mode === "now" || (mode === "keep" && post.publishOnApprove)) when = new Date();
  else if (mode === "at") {
    if (!at) throw new PostError("Pick a time.");
    assertFuture(at);
    when = at;
  } else {
    if (!post.scheduledAt) throw new PostError("This post has no time yet: pick one or publish now.");
    if (post.scheduledAt.getTime() <= Date.now()) throw new PostError("This post's time has passed: publish now or pick a new time.", 409, "overdue");
    when = post.scheduledAt;
  }
  const r = await db.post.updateMany({
    where: { id, status: post.status },
    data: {
      status: "SCHEDULED",
      scheduledAt: when,
      approvedByUserId: userId,
      approvedAt: new Date(),
      rejectNote: null,
      nextAttemptAt: null,
      publishOnApprove: false,
    },
  });
  if (r.count === 0) throw new PostError("The post changed meanwhile; reload.", 409, "conflict");
  return { publishNow: when.getTime() <= Date.now() + 1000 };
}

export async function rejectPost(id: string, note: string) {
  const post = await load(id);
  if (post.status !== "PENDING_APPROVAL" && post.status !== "SCHEDULED") throw new PostError(`Cannot reject a ${post.status} post.`, 409, "conflict");
  await db.post.update({ where: { id }, data: { status: "DRAFT", rejectNote: note.slice(0, 500) || null, approvedAt: null, approvedByUserId: null } });
}

export async function cancelPost(id: string) {
  const post = await load(id);
  if (!CANCELLABLE.includes(post.status as PostStatus)) throw new PostError(`Cannot cancel a ${post.status} post.`, 409, "conflict");
  const r = await db.post.updateMany({ where: { id, status: post.status }, data: { status: "CANCELLED" } });
  if (r.count === 0) throw new PostError("The post changed meanwhile; reload.", 409, "conflict");
}

/** A failed post goes back to the queue now. Its publish step is kept, so a half-done publish is verified, not repeated. */
export async function retryPost(id: string) {
  const post = await load(id);
  if (post.status !== "FAILED") throw new PostError("Only failed posts can be retried.", 409, "conflict");
  await db.post.update({
    where: { id },
    data: { status: "SCHEDULED", scheduledAt: new Date(), attemptCount: 0, nextAttemptAt: null, lastError: null },
  });
}

/**
 * Edits caption / time. A change made by automation to an approved post
 * sends it back for approval: approval was given to what the person saw.
 */
export async function editPost(
  id: string,
  changes: { caption?: string; scheduledAt?: Date | null },
  by: { canApprove: boolean }
): Promise<Post> {
  const post = await load(id);
  if (!EDITABLE.includes(post.status as PostStatus)) throw new PostError(`Cannot edit a ${post.status} post.`, 409, "conflict");
  if (post.publishStep === "PUBLISH_CALLED" || post.publishStep === "DONE") throw new PostError("This post is mid-publish.", 409, "conflict");

  const data: Record<string, unknown> = {};
  if (changes.caption !== undefined) changes.caption = normaliseNewlines(changes.caption).trim();
  if (changes.caption !== undefined && changes.caption !== post.caption) {
    const check = checkCaption(changes.caption);
    if (!check.ok) throw new PostError(check.errors.join(" "), 400, "caption");
    const brand = await db.brand.findUniqueOrThrow({ where: { id: post.brandId }, select: { name: true, blockedTerms: true } });
    assertBrandRules(brand, changes.caption);
    data.caption = changes.caption;
    // An existing container carries the old caption.
    if (post.publishStep !== "NONE") Object.assign(data, { publishStep: "NONE", igContainerId: null });
  }
  if (changes.scheduledAt !== undefined) {
    if (changes.scheduledAt) assertFuture(changes.scheduledAt);
    data.scheduledAt = changes.scheduledAt;
  }
  if (!Object.keys(data).length) return post;
  if (!by.canApprove && post.status === "SCHEDULED") Object.assign(data, { status: "PENDING_APPROVAL", approvedAt: null, approvedByUserId: null });
  const r = await db.post.updateMany({ where: { id, status: post.status, updatedAt: post.updatedAt }, data });
  if (r.count === 0) throw new PostError("The post changed meanwhile; reload.", 409, "conflict");
  return load(id);
}
