import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms of service", robots: { index: true } };

/** Public: TikTok requires a terms of service URL for the app. */
export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-14 text-sm leading-relaxed text-zinc-300">
      <h1 className="mb-6 text-2xl font-semibold text-white">Brandloom terms of service</h1>
      <p className="mb-4">
        Brandloom is an internal publishing tool operated by JNK Nutrition for its own brands (Core Champs, JNK Nutrition, Muscle Rulz, Scoops Monster and
        ProScience Nutra). It is not offered to the public: only JNK Nutrition staff accounts can sign in, and only accounts owned by these brands can be
        connected.
      </p>
      <h2 className="mb-2 mt-6 font-semibold text-white">Use</h2>
      <p className="mb-4">
        Staff use Brandloom to plan, approve and publish the brands&apos; own photos and videos to the brands&apos; Instagram, Facebook and TikTok accounts.
        Every post is reviewed and approved by staff before it is published. Content must follow the rules of each platform, including the TikTok Community
        Guidelines and Terms of Service.
      </p>
      <h2 className="mb-2 mt-6 font-semibold text-white">Connected accounts</h2>
      <p className="mb-4">
        Connecting a social account lets Brandloom publish on that account&apos;s behalf. The account owner can disconnect it in Brandloom or revoke access
        in the platform&apos;s own settings at any time. See the{" "}
        <a href="/privacy" className="underline">
          privacy policy
        </a>{" "}
        for what data Brandloom stores.
      </p>
      <h2 className="mb-2 mt-6 font-semibold text-white">No warranty</h2>
      <p className="mb-4">Brandloom is provided as is for internal use. JNK Nutrition may change or stop the service at any time.</p>
      <p className="mt-8 text-muted">Contact: kamal@jnknutrition.com</p>
    </main>
  );
}
