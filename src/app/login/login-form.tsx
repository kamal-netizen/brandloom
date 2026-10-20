"use client";

import { useState } from "react";
import { signIn, signUp } from "@/lib/auth-client";

export function LoginForm({ next }: { next: string }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    const res =
      mode === "in"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: String(f.get("name") || email.split("@")[0]) });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Could not sign in.");
      return;
    }
    window.location.assign(next);
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-6">
      {mode === "up" && (
        <div>
          <label className="label" htmlFor="name">Name</label>
          <input id="name" name="name" className="field" autoComplete="name" />
        </div>
      )}
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required className="field" autoComplete="email" />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={mode === "up" ? 10 : undefined}
          className="field"
          autoComplete={mode === "in" ? "current-password" : "new-password"}
        />
      </div>
      {error && <p className="rounded-lg bg-red-950/50 px-3 py-2 text-sm text-red-200">{error}</p>}
      <button className="btn-primary w-full" disabled={busy}>
        {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
      </button>
      <button
        type="button"
        className="w-full text-center text-xs text-muted hover:text-zinc-300"
        onClick={() => {
          setMode(mode === "in" ? "up" : "in");
          setError(null);
        }}
      >
        {mode === "in" ? "First time here? Create the admin account" : "Have an account? Sign in"}
      </button>
    </form>
  );
}
