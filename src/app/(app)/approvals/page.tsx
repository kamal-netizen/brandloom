import Link from "next/link";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { publicUrl } from "@/lib/media-store";
import { approveAction, rejectAction } from "@/app/actions/posts";
import { PhonePreview } from "@/components/phone-preview";
import { BrandDot, brandColor, Empty, Notice, PageHeader } from "@/components/ui";
import { formatDubai, toDubaiInput, requestNow } from "@/lib/time";
import { checkCaption } from "@/lib/caption";
import { platformLabel } from "@/lib/status";
import { describeSettings, parseSettings } from "@/lib/tiktok/settings";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const posts = await db.post.findMany({
    where: { status: "PENDING_APPROVAL" },
    include: { brand: { include: { connection: true } }, media: { include: { rendition: true } } },
    orderBy: [{ scheduledAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
  });
  const now = requestNow();

  return (
    <div>
      <PageHeader
        title="Approvals"
        sub="Posts pushed by automation wait here. Nothing reaches Instagram until you approve it, and an overdue post never publishes by itself."
      />
      {sp.ok && <Notice tone="ok">{sp.ok}</Notice>}
      {sp.error && <Notice tone="error">{sp.error}</Notice>}
      {posts.length === 0 ? (
        <Empty>Nothing waiting for approval.</Empty>
      ) : (
        <div className="space-y-5">
          {posts.map((p) => {
            const overdue = p.scheduledAt && p.scheduledAt.getTime() <= now;
            const img = p.media[0] ? publicUrl(p.media[0].rendition.key) : null;
            const cap = checkCaption(p.caption);
            const connected = p.brand.connection?.status === "CONNECTED";
            return (
              <article key={p.id} className="card grid gap-6 p-5 lg:grid-cols-[300px_1fr]">
                <PhonePreview type={p.type} imageUrl={img} caption={p.caption} handle={p.brand.igHandle ?? p.brand.name} />
                <div className="min-w-0 space-y-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <BrandDot color={brandColor(p.brand)} />
                    <span className="font-semibold">{p.brand.name}</span>
                    <span className="text-muted">· {platformLabel(p.platform)} {p.type === "STORY" ? "story" : p.type === "REEL" ? "reel" : "post"}{p.platform === "TIKTOK" && ` (${describeSettings(parseSettings(p.tiktokJson))})`} · from {p.source === "API" ? "automation" : "the app"}</span>
                    <Link href={`/posts/${p.id}`} className="ml-auto text-xs text-muted underline-offset-2 hover:underline">
                      Open
                    </Link>
                  </div>
                  <div className="text-sm">
                    {p.scheduledAt ? (
                      <span className={overdue ? "text-amber-300" : ""}>
                        {overdue ? "Was due " : "Goes out "} {formatDubai(p.scheduledAt)}
                      </span>
                    ) : p.publishOnApprove ? (
                      <span>Publishes as soon as approved</span>
                    ) : (
                      <span className="text-muted">No time set</span>
                    )}
                  </div>
                  {!connected && <Notice tone="warn">{p.brand.name} is not connected to Instagram yet; approving will schedule it, publishing will fail until it is connected.</Notice>}
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-ink p-3 font-sans text-sm leading-relaxed text-zinc-200">{p.caption || "(no caption)"}</pre>
                  <p className="text-xs text-muted">
                    {cap.length} / 2200 characters · {cap.hashtags} hashtags · {cap.mentions} mentions
                    {p.type === "STORY" && " · stories show no caption on Instagram"}
                  </p>

                  <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
                    {p.scheduledAt && !overdue && (
                      <form action={approveAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="mode" value="keep" />
                        <input type="hidden" name="back" value="/approvals" />
                        <button className="btn-primary">Approve for {formatDubai(p.scheduledAt)}</button>
                      </form>
                    )}
                    <form action={approveAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="mode" value="now" />
                      <input type="hidden" name="back" value="/approvals" />
                      <button className={p.scheduledAt && !overdue ? "btn-ghost" : "btn-primary"}>Approve &amp; publish now</button>
                    </form>
                    <form action={approveAction} className="flex items-end gap-2">
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="mode" value="at" />
                      <input type="hidden" name="back" value="/approvals" />
                      <input
                        type="datetime-local"
                        name="at"
                        required
                        className="field w-auto"
                        defaultValue={p.scheduledAt && !overdue ? toDubaiInput(p.scheduledAt) : undefined}
                      />
                      <button className="btn-ghost">Approve at time</button>
                    </form>
                    <form action={rejectAction} className="ml-auto flex items-end gap-2">
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="back" value="/approvals" />
                      <input name="note" placeholder="Why? (optional)" className="field w-48" />
                      <button className="btn-danger">Reject</button>
                    </form>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
