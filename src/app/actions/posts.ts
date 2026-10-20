"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { assertAdmin } from "@/lib/admin";
import { approvePost, cancelPost, createPost, editPost, PostError, rejectPost, retryPost, type ApproveMode } from "@/lib/posts";
import { publishNow } from "@/lib/publish/engine";
import { FITS, type Fit } from "@/lib/renditions";
import { parseDubai } from "@/lib/time";

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
  const p = await db.post.findUnique({ where: { id }, select: { status: true, lastError: true } });
  if (r === "published") return "ok=" + encodeURIComponent("Published to Instagram.");
  if (p?.status === "FAILED") return "error=" + encodeURIComponent(p.lastError ?? "Publishing failed.");
  return "ok=" + encodeURIComponent("Queued: the scheduler will finish publishing within a minute.");
}

/** Composer submit. intent = draft | schedule | now. */
export async function createPostAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  const user = await assertAdmin();
  const intent = str(f, "intent");
  const brand = await db.brand.findUnique({ where: { slug: str(f, "brand") } });
  if (!brand) return { error: "Pick a brand." };
  const type = str(f, "type") === "STORY" ? "STORY" : "FEED";
  const assetId = str(f, "assetId");
  if (!assetId) return { error: "Add an image." };
  const fit = (str(f, "fit") || "reject") as Fit;
  if (!FITS.includes(fit)) return { error: "Bad fit." };

  let scheduledAt: Date | null = null;
  if (intent === "schedule") {
    scheduledAt = parseDubai(str(f, "scheduledAt"));
    if (!scheduledAt) return { error: "Pick a date and time (Dubai)." };
  } else if (str(f, "scheduledAt")) {
    scheduledAt = parseDubai(str(f, "scheduledAt"));
  }

  let id: string;
  try {
    const { post } = await createPost({
      brand,
      type,
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
    id = post.id;
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath("/calendar");
  if (intent === "now") redirect(`/posts/${id}?${await publishOutcome(id)}`);
  redirect(`/posts/${id}?ok=${encodeURIComponent(intent === "draft" ? "Draft saved." : "Scheduled.")}`);
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
    await editPost(id, { caption: str(f, "caption"), scheduledAt: at }, { canApprove: true });
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
