import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Only same-site paths: never bounce a sign-in to another origin.
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/calendar";
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo />
          <p className="mt-3 text-sm text-muted">Five brands. One calendar.</p>
        </div>
        <LoginForm next={safeNext} />
      </div>
    </main>
  );
}

function Logo() {
  return (
    <div className="inline-flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand font-black text-ink">B</span>
      <span className="text-xl font-semibold tracking-tight">Brandloom</span>
    </div>
  );
}
