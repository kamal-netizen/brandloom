import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { Nav } from "./nav";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdmin();
  const [pending, failed, reconnect] = await Promise.all([
    db.post.count({ where: { status: "PENDING_APPROVAL" } }),
    db.post.count({ where: { status: "FAILED" } }),
    db.igConnection.count({ where: { status: "NEEDS_RECONNECT" } }),
  ]);
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Nav user={user} pending={pending} failed={failed} reconnect={reconnect} />
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
