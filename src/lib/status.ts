/**
 * Post lifecycle. Strings in the database (no Prisma enums, see schema), so
 * this file is the one definition of what a valid value is.
 *
 *   DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ SCHEDULED ──tick──▶ PUBLISHING ──▶ PUBLISHED
 *     ▲                     │ reject                  ▲    │                │
 *     └─────────────────────┘                         │    └── edit ──▶ PENDING_APPROVAL
 *                                                     └──── retry ◀── FAILED
 *   DRAFT / PENDING_APPROVAL / SCHEDULED / FAILED ──cancel──▶ CANCELLED
 */
export const POST_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const POST_TYPES = ["FEED", "STORY"] as const; // REEL / CAROUSEL: later phase
export type PostType = (typeof POST_TYPES)[number];

export const PUBLISH_STEPS = ["NONE", "CONTAINER_CREATED", "CONTAINER_READY", "PUBLISH_CALLED", "DONE"] as const;
export type PublishStep = (typeof PUBLISH_STEPS)[number];

/** States in which caption / time / media may still change. */
export const EDITABLE: PostStatus[] = ["DRAFT", "PENDING_APPROVAL", "SCHEDULED", "FAILED"];
export const CANCELLABLE: PostStatus[] = ["DRAFT", "PENDING_APPROVAL", "SCHEDULED", "FAILED"];

export function isPostStatus(s: string): s is PostStatus {
  return (POST_STATUSES as readonly string[]).includes(s);
}

export const STATUS_LABEL: Record<PostStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Needs approval",
  SCHEDULED: "Scheduled",
  PUBLISHING: "Publishing",
  PUBLISHED: "Published",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const STATUS_TONE: Record<PostStatus, string> = {
  DRAFT: "bg-zinc-700/60 text-zinc-200",
  PENDING_APPROVAL: "bg-amber-500/20 text-amber-300",
  SCHEDULED: "bg-sky-500/20 text-sky-300",
  PUBLISHING: "bg-violet-500/20 text-violet-300",
  PUBLISHED: "bg-emerald-500/20 text-emerald-300",
  FAILED: "bg-red-500/20 text-red-300",
  CANCELLED: "bg-zinc-800 text-zinc-500 line-through",
};
