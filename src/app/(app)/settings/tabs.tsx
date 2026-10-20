import Link from "next/link";
import { cn } from "@/components/ui";

export function SettingsTabs({ active }: { active: "system" | "tokens" }) {
  return (
    <div className="mb-6 flex gap-1 border-b border-line text-sm">
      {(
        [
          ["system", "System", "/settings/system"],
          ["tokens", "API tokens", "/settings/tokens"],
        ] as const
      ).map(([k, l, href]) => (
        <Link key={k} href={href} className={cn("-mb-px border-b-2 px-3 py-2", active === k ? "border-brand text-white" : "border-transparent text-muted")}>
          {l}
        </Link>
      ))}
    </div>
  );
}
