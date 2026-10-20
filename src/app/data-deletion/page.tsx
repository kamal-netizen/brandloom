import type { Metadata } from "next";

export const metadata: Metadata = { title: "Data deletion", robots: { index: true } };

/** Public: Meta requires data deletion instructions for the app. */
export default function DataDeletionPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-14 text-sm leading-relaxed text-zinc-300">
      <h1 className="mb-6 text-2xl font-semibold text-white">Data deletion instructions</h1>
      <p className="mb-4">Brandloom stores only the access token and account id of the brand Instagram accounts that staff connect. To delete it:</p>
      <ol className="mb-4 list-decimal space-y-2 pl-5">
        <li>In Brandloom, open Brands → the brand → Disconnect. The stored token is overwritten immediately.</li>
        <li>
          Or, in Facebook: Settings &amp; privacy → Settings → Business integrations → Brandloom → Remove. The token stops working, and Brandloom marks the
          connection as needing reconnection.
        </li>
        <li>To have every record about a connected account removed, email kamal@jnknutrition.com; it is done within 30 days.</li>
      </ol>
    </main>
  );
}
