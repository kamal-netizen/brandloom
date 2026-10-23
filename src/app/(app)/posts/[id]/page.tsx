import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { publicUrl } from "@/lib/media-store";
import {
  approveAction,
  cancelAction,
  editPostAction,
  publishNowAction,
  rejectAction,
  retryAction,
  scheduleDraftAction,
} from "@/app/actions/posts";
import { PhonePreview } from "@/components/phone-preview";
import { BrandDot, brandColor, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { CANCELLABLE, EDITABLE, platformLabel, type PostStatus } from "@/lib/status";
import { describeSettings, parseSettings, PRIVACY_LABEL, PRIVACY_LEVELS, tiktokPrivateOnly } from "@/lib/tiktok/settings";
import { formatDubai, toDubaiInput, requestNow } from "@/lib/time";

export const metadata: Metadata = { title: "Post" };

export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const post = await db.post.findUnique({
    where: { id },
    include: {
      brand: { include: { connection: true, tiktok: true } },
      media: { include: { rendition: true, asset: true } },
      attempts: { orderBy: { startedAt: "desc" }, take: 30 },
    },
  });
  if (!post) notFound();
  const status = post.status as PostStatus;
  const img = post.media[0] ? publicUrl(post.media[0].rendition.key) : null;
  const editable = EDITABLE.includes(status) && post.publishStep !== "PUBLISH_CALLED";
  const overdue = post.scheduledAt && post.scheduledAt.getTime() <= requestNow();
  const isTiktok = post.platform === "TIKTOK";
  const tt = isTiktok ? parseSettings(post.tiktokJson) : null;
  const connected = isTiktok ? post.brand.tiktok?.status === "CONNECTED" : post.brand.connection?.status === "CONNECTED";
  const kind = post.type === "STORY" ? "story" : post.type === "REEL" ? "reel" : "post";

  return (
    <div>
      <PageHeader
        title={`${post.brand.name} · ${platformLabel(post.platform)} ${kind}`}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <BrandDot color={brandColor(post.brand)} />
            <StatusBadge status={post.status} />
            {post.scheduledAt && <span>{post.status === "PUBLISHED" ? "Planned" : "Scheduled"} {formatDubai(post.scheduledAt, { withYear: true })}</span>}
            {post.publishedAt && <span>· Published {formatDubai(post.publishedAt)}</span>}
            <span>· from {post.source === "API" ? "automation" : "the app"}</span>
          </span>
        }
        actions={
          post.igPermalink && (
            <a href={post.igPermalink} target="_blank" rel="noreferrer" className="btn-primary">
              View on {platformLabel(post.platform)}
            </a>
          )
        }
      />
      {sp.ok && <Notice tone="ok">{sp.ok}</Notice>}
      {sp.error && <Notice tone="error">{sp.error}</Notice>}
      {post.lastError && post.status !== "PUBLISHED" && <Notice tone={post.status === "FAILED" ? "error" : "warn"}>{post.lastError}</Notice>}
      {post.rejectNote && post.status === "DRAFT" && <Notice tone="warn">Rejected: {post.rejectNote}</Notice>}
      {isTiktok && status === "PUBLISHED" && !post.igPermalink && (
        <Notice tone="ok">
          Published to TikTok{tt?.privacy === "SELF_ONLY" ? " as a private video (Only me)" : ""}. TikTok gives no link for it until it is public and has passed
          moderation; find it on the account&apos;s profile in the TikTok app.
        </Notice>
      )}
      {!connected && !["PUBLISHED", "CANCELLED"].includes(status) && (
        <Notice tone="warn">
          {post.brand.name} is not connected to {isTiktok ? "TikTok" : "Instagram"}.{" "}
          <Link href={`/brands/${post.brand.slug}`} className="underline">
            Connect it
          </Link>{" "}
          before this post&apos;s time.
        </Notice>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          {editable ? (
            <form action={editPostAction} className="card space-y-4 p-5">
              <input type="hidden" name="id" value={post.id} />
              <div>
                <label className="label" htmlFor="caption">Caption</label>
                <textarea id="caption" name="caption" rows={10} defaultValue={post.caption} className="field leading-relaxed" />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                {tt && (
                  <div>
                    <label className="label" htmlFor="ttPrivacy">TikTok: who can view</label>
                    <select id="ttPrivacy" name="ttPrivacy" defaultValue={tt.privacy ?? ""} className="field w-auto">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {PRIVACY_LEVELS.map((o) => (
                        <option key={o} value={o} disabled={tiktokPrivateOnly() && o !== "SELF_ONLY"}>
                          {PRIVACY_LABEL[o]}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="label" htmlFor="scheduledAt">Time (Dubai)</label>
                  <input
                    id="scheduledAt"
                    name="scheduledAt"
                    type="datetime-local"
                    className="field w-auto"
                    defaultValue={post.scheduledAt && !overdue ? toDubaiInput(post.scheduledAt) : ""}
                  />
                </div>
                <button className="btn-ghost">Save changes</button>
              </div>
            </form>
          ) : (
            <pre className="card whitespace-pre-wrap p-5 font-sans text-sm leading-relaxed">{post.caption || "(no caption)"}</pre>
          )}

          <div className="card flex flex-wrap items-end gap-2 p-5">
            {status === "PENDING_APPROVAL" && (
              <>
                {post.scheduledAt && !overdue && (
                  <form action={approveAction}>
                    <input type="hidden" name="id" value={post.id} />
                    <input type="hidden" name="mode" value="keep" />
                    <button className="btn-primary">Approve</button>
                  </form>
                )}
                <form action={approveAction}>
                  <input type="hidden" name="id" value={post.id} />
                  <input type="hidden" name="mode" value="now" />
                  <button className="btn-ghost">Approve &amp; publish now</button>
                </form>
                <form action={rejectAction} className="flex items-end gap-2">
                  <input type="hidden" name="id" value={post.id} />
                  <input name="note" placeholder="Reason (optional)" className="field w-44" />
                  <button className="btn-danger">Reject</button>
                </form>
              </>
            )}
            {status === "DRAFT" && (
              <form action={scheduleDraftAction} className="flex items-end gap-2">
                <input type="hidden" name="id" value={post.id} />
                <div>
                  <label className="label" htmlFor="at">Schedule for</label>
                  <input id="at" name="at" type="datetime-local" className="field w-auto" />
                </div>
                <button className="btn-primary">Schedule (empty = now)</button>
              </form>
            )}
            {status === "SCHEDULED" && (
              <form action={publishNowAction}>
                <input type="hidden" name="id" value={post.id} />
                <button className="btn-primary">Publish now</button>
              </form>
            )}
            {status === "FAILED" && (
              <form action={retryAction}>
                <input type="hidden" name="id" value={post.id} />
                <button className="btn-primary">Retry now</button>
              </form>
            )}
            {CANCELLABLE.includes(status) && (
              <form action={cancelAction} className="ml-auto">
                <input type="hidden" name="id" value={post.id} />
                <button className="btn-danger">Cancel post</button>
              </form>
            )}
            {(status === "PUBLISHED" || status === "CANCELLED" || status === "PUBLISHING") && (
              <p className="text-sm text-muted">{status === "PUBLISHING" ? "Publishing right now…" : "Nothing left to do with this post."}</p>
            )}
          </div>

          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">Publish log</h2>
            {post.attempts.length === 0 ? (
              <p className="text-sm text-muted">No calls to {platformLabel(post.platform)} yet.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <tbody>
                  {post.attempts.map((a) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="py-1.5 pr-3 text-muted">{formatDubai(a.startedAt)}</td>
                      <td className="pr-3 font-medium">{a.step}</td>
                      <td className={a.ok ? "text-emerald-300" : "text-red-300"}>{a.ok ? "ok" : a.error ?? "…"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-xs text-muted">
              Step {post.publishStep}
              {post.attemptCount > 0 && ` · ${post.attemptCount} retr${post.attemptCount === 1 ? "y" : "ies"}`}
              {tt && ` · TikTok: ${describeSettings(tt)}${post.igContainerId ? ` · publish id ${post.igContainerId}` : ""}`}
              {post.media[0] && ` · image ${post.media[0].asset.originalName} (${post.media[0].rendition.fit})`}
            </p>
          </section>
        </div>
        <div className="lg:sticky lg:top-8 lg:self-start">
          <PhonePreview type={post.type} imageUrl={img} caption={post.caption} handle={post.brand.igHandle ?? post.brand.name} />
          {img && (
            <a href={img} target="_blank" rel="noreferrer" className="mt-3 block text-center text-xs text-muted hover:text-zinc-300">
              Open the exact file {platformLabel(post.platform)} receives
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
