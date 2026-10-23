"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { assertAdmin } from "@/lib/admin";
import { approvePost, cancelPost, createPost, editPost, PostError, rejectPost, retryPost, type ApproveMode } from "@/lib/posts";
import { publishNow } from "@/lib/publish/engine";
import { FITS, type Fit } from "@/lib/renditions";
import { parseDubai } from "@/lib/time";
import { platformLabel, type Platform } from "@/lib/status";
import { DEFAULT_SETTINGS, parseSettings, PRIVACY_LEVELS, type TiktokSettings } from "@/lib/tiktok/settings";
import type { PrivacyLevel } from "@/lib/tiktok/api";

export type ActionState = { error?: string; ok?: string } | null;

function str(f: FormData, k: string) {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
}

function message(err: unknown): string {
  if (err instanceof PostError) return err.message;
  console.error("[action]", err);
  return "Something went wrong.";
}

/** After a publish-now: say what happened. */
async function publishOutcome(id: string) {
  const r = await publishNow(id);
  const p = await db.post.findUnique({ where: { id }, select: { status: true, lastError: true, platform: true } });
  if (r === "published") return "ok=" + encodeURIComponent(`Published to ${platformLabel(p?.platform ?? "INSTAGRAM")}.`);
  if (p?.status === "FAILED") return "error=" + encodeURIComponent(p.lastError ?? "Publishing failed.");
  return "ok=" + encodeURIComponent("Queued: the scheduler will finish publishing within a minute.");
}

/** Composer submit. intent = draft | schedule | now. */
export async function createPostAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const user = await assertAdmin();
  const intent = str(f, "intent");
  const brand = await db.brand.findUnique({ where: { slug: str(f, "brand") } });
  if (!brand) return { error: "Pick a brand." };
  const rawType = str(f, "type");
  const type = rawType === "STORY" ? "STORY" : rawType === "REEL" ? "REEL" : "FEED";
  const assetId = str(f, "assetId");
  if (!assetId) return { error: type === "REEL" ? "Add a video." : "Add an image." };
  const fit = (str(f, "fit") || "reject") as Fit;
  if (!FITS.includes(fit)) return { error: "Bad fit." };

  let scheduledAt: Date | null = null;
  if (intent === "schedule") {
    scheduledAt = parseDubai(str(f, "scheduledAt"));
    if (!scheduledAt) return { error: "Pick a date and time (Dubai)." };
  } else if (str(f, "scheduledAt")) {
    scheduledAt = parseDubai(str(f, "scheduledAt"));
  }

  const platforms = f.getAll("platforms").map(String).filter((p): p is Platform => p === "INSTAGRAM" || p === "FACEBOOK" || p === "TIKTOK");
  if (!platforms.length) return { error: "Pick at least one of Instagram, Facebook and TikTok." };
  const privacy = str(f, "ttPrivacy");
  const tiktok: TiktokSettings = {
    ...DEFAULT_SETTINGS,
    privacy: PRIVACY_LEVELS.includes(privacy as PrivacyLevel) ? (privacy as PrivacyLevel) : null,
    allowComment: str(f, "ttComment") === "1",
    allowDuet: str(f, "ttDuet") === "1",
    allowStitch: str(f, "ttStitch") === "1",
    yourBrand: str(f, "ttYourBrand") === "1",
    brandedContent: str(f, "ttBranded") === "1",
  };

  const ids: string[] = [];
  try {
    for (const platform of platforms) {
    const { post } = await createPost({
      brand,
      type,
      platform,
      tiktok: platform === "TIKTOK" ? tiktok : undefined,
      caption: str(f, "caption"),
      assetIds: [assetId],
      fit,
      scheduledAt: intent === "now" ? null : scheduledAt,
      publishNow: intent === "now",
      desired: intent === "draft" ? "draft" : "scheduled",
      source: "UI",
      createdByUserId: user.id,
      canApprove: true, // an admin in the UI is the approver
    });
    ids.push(post.id);
    }
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath("/calendar");
  const id = ids[0];
  if (intent === "now") {
    const outcomes = [];
    for (const each of ids) outcomes.push(await publishOutcome(each));
    redirect(`/posts/${id}?${outcomes[0]}`);
  }
  const what = intent === "draft" ? "Draft saved" : "Scheduled";
  const names = platforms.map(platformLabel);
  redirect(`/posts/${id}?ok=${encodeURIComponent(ids.length > 1 ? `${what} for ${names.slice(0, -1).join(", ")} and ${names.at(-1)} (${ids.length} posts).` : `${what}.`)}`);
}

export async function approveAction(f: FormData) {
  const user = await assertAdmin();
  const id = str(f, "id");
  const mode = (str(f, "mode") || "keep") as ApproveMode;
  const back = str(f, "back") || `/posts/${id}`;
  let q: string;
  try {
    const at = mode === "at" ? parseDubai(str(f, "at")) : null;
    const { publishNow: now } = await approvePost(id, user.id, mode, at);
    q = now ? await publishOutcome(id) : "ok=" + encodeURIComponent("Approved and scheduled.");
  } catch (err) {
    q = "error=" + encodeURIComponent(message(err));
  }
  revalidatePath("/approvals");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${q}`);
}

export async function rejectAction(f: FormData) {
  await assertAdmin();
  const id = str(f, "id");
  const back = str(f, "back") || `/posts/${id}`;
  let q = "ok=" + encodeURIComponent("Sent back to drafts.");
  try {
    await rejectPost(id, str(f, "note"));
  } catch (err) {
    q = "error=" + encodeURIComponent(message(err));
  }
  revalidatePath("/approvals");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${q}`);
}

export async function cancelAction(f: FormData) {
  await assertAdmin();
  const id = str(f, "id");
  let q = "ok=" + encodeURIComponent("Cancelled.");
  try {
    await cancelPost(id);
  } catch (err) {
    q = "error=" + encodeURIComponent(message(err));
  }
  redirect(`/posts/${id}?${q}`);
}

export async function retryAction(f: FormData) {
  await assertAdmin();
  const id = str(f, "id");
  let q: string;
  try {
    await retryPost(id);
    q = await publishOutcome(id);
  } catch (err) {
    q = "error=" + encodeURIComponent(message(err));
  }
  redirect(`/posts/${id}?${q}`);
}

export async function publishNowAction(f: FormData) {
  await assertAdmin();
  const id = str(f, "id");
  const post = await db.post.findUnique({ where: { id } });
  let q: string;
  if (post?.status !== "SCHEDULED") q = "error=" + encodeURIComponent("Only scheduled posts can be published now.");
  else q = await publishOutcome(id);
  redirect(`/posts/${id}?${q}`);
}

export async function editPostAction(f: FormData) {
  await assertAdmin();
  const id = str(f, "id");
  let q = "ok=" + encodeURIComponent("Saved.");
  try {
    const raw = str(f, "scheduledAt");
    const at = raw ? parseDubai(raw) : null;
    if (raw && !at) throw new PostError("Bad date.");
    const privacy = str(f, "ttPrivacy");
    let tiktok: TiktokSettings | undefined;
    if (privacy) {
      const post = await db.post.findUnique({ where: { id }, select: { tiktokJson: true } });
      if (!PRIVACY_LEVELS.includes(privacy as PrivacyLevel)) throw new PostError("Bad TikTok privacy.");
      tiktok = { ...parseSettings(post?.tiktokJson ?? ""), privacy: privacy as PrivacyLevel };
    }
    await editPost(id, { caption: str(f, "caption"), scheduledAt: at, tiktok }, { canApprove: true });
  } catch (err) {
    q = "error=" + encodeURIComponent(message(err));
  }
  redirect(`/posts/${id}?${q}`);
}

/** Draft → schedule (admin is the approver). */
export async function scheduleDraftAction(f: FormData) {
  const user = await assertAdmin();
  const id = str(f, "id");
  let q: string;
  try {
    const at = parseDubai(str(f, "at"));
    const { publishNow: now } = await approvePost(id, user.id, at ? "at" : "now", at);
    q = now ? await publishOutcome(id) : "ok=" + encodeURIComponent("Scheduled.");
  } catch (err) {
    q = "error=" + encodeURIComponent(message(err));
  }
  redirect(`/posts/${id}?${q}`);
}
