"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CalendarBlank, CheckCircle, GearSix, ImagesSquare, Plus, SignOut, Storefront } from "@phosphor-icons/react";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/components/ui";

export function Nav({
  user,
  pending,
  failed,
  reconnect,
}: {
  user: { email: string; name: string };
  pending: number;
  failed: number;
  reconnect: number;
}) {
  const path = usePathname();
  const router = useRouter();
  const items = [
    { href: "/calendar", label: "Calendar", icon: CalendarBlank, badge: failed ? { n: failed, tone: "bg-red-500" } : null },
    { href: "/approvals", label: "Approvals", icon: CheckCircle, badge: pending ? { n: pending, tone: "bg-amber-500" } : null },
    { href: "/brands", label: "Brands", icon: Storefront, badge: reconnect ? { n: reconnect, tone: "bg-red-500" } : null },
    { href: "/assets", label: "Assets", icon: ImagesSquare, badge: null },
    { href: "/settings/system", label: "Settings", icon: GearSix, badge: null },
  ];
  return (
    <aside className="sticky top-0 z-10 flex shrink-0 flex-row items-center gap-1 border-b border-line bg-panel px-3 py-2 md:h-screen md:w-56 md:flex-col md:items-stretch md:border-b-0 md:border-r md:px-3 md:py-5">
      <Link href="/calendar" className="mr-2 flex items-center gap-2 px-2 md:mb-6 md:mr-0">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-sm font-black text-ink">B</span>
        <span className="hidden font-semibold tracking-tight md:inline">Brandloom</span>
      </Link>
      <Link href="/posts/new" className="btn-primary mb-1 hidden md:mb-4 md:inline-flex">
        <Plus weight="bold" /> New post
      </Link>
      <nav className="flex flex-1 flex-row gap-1 overflow-x-auto md:flex-col">
        {items.map(({ href, label, icon: Icon, badge }) => {
          const active = path === href || path.startsWith(href.replace(/\/system$/, "") + "/") || path === href.replace(/\/system$/, "");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition",
                active ? "bg-panel-2 text-white" : "text-muted hover:bg-panel-2/60 hover:text-zinc-200"
              )}
            >
              <Icon size={18} weight={active ? "fill" : "regular"} />
              <span className="hidden sm:inline">{label}</span>
              {badge && <span className={cn("ml-auto rounded-full px-1.5 text-[11px] font-semibold text-black", badge.tone)}>{badge.n}</span>}
            </Link>
          );
        })}
        <Link href="/posts/new" className="flex items-center rounded-lg px-2.5 py-2 text-brand md:hidden" aria-label="New post">
          <Plus size={18} weight="bold" />
        </Link>
      </nav>
      <div className="hidden border-t border-line pt-4 text-xs text-muted md:block">
        <div className="truncate px-2">{user.email}</div>
        <button
          onClick={() => signOut().then(() => router.replace("/login"))}
          className="mt-2 flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-panel-2 hover:text-zinc-200"
        >
          <SignOut size={14} /> Sign out
        </button>
      </div>
    </aside>
  );
}
