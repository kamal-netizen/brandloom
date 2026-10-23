import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy", robots: { index: true } };

/** Public: Meta requires a privacy policy URL for the app. */
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-14 text-sm leading-relaxed text-zinc-300">
      <h1 className="mb-6 text-2xl font-semibold text-white">Brandloom privacy policy</h1>
      <p className="mb-4">
        Brandloom is an internal publishing tool operated by JNK Nutrition for its own brands (Core Champs, JNK Nutrition, Muscle Rulz, Scoops Monster and
        ProScience Nutra). It is not offered to the public, and only staff accounts can sign in.
      </p>
      <h2 className="mb-2 mt-6 font-semibold text-white">What we access from Meta</h2>
      <p className="mb-4">
        When a staff member connects a brand&apos;s Instagram professional account, Brandloom receives an access token for the linked Facebook Page and the
        Instagram account&apos;s id, username and profile picture. It uses them only to publish posts and stories that staff have approved, and to read the
        publishing quota and the permalink of published posts.
      </p>
      <h2 className="mb-2 mt-6 font-semibold text-white">What we access from TikTok</h2>
      <p className="mb-4">
        When a staff member connects a brand&apos;s TikTok account (Login Kit), Brandloom receives an access token and the account&apos;s open id, display name
        and avatar (user.info.basic). It uses video.upload and video.publish only to post videos that staff have approved to that brand&apos;s own TikTok
        profile, and to check their publishing status.
      </p>
      <h2 className="mb-2 mt-6 font-semibold text-white">Storage</h2>
      <p className="mb-4">
        Tokens are stored encrypted (AES-256-GCM). Brandloom does not read, store or process data about Instagram or TikTok users, followers, comments or
        messages, and shares nothing with third parties.
      </p>
      <h2 className="mb-2 mt-6 font-semibold text-white">Removing access</h2>
      <p className="mb-4">
        Disconnecting a brand in Brandloom erases its token. Access can also be removed at any time from Facebook Settings → Business integrations, or in the TikTok app
        under Settings → Security → Manage app permissions. See the{" "}
        <a href="/data-deletion" className="underline">
          data deletion instructions
        </a>
        .
      </p>
      <p className="mt-8 text-muted">Contact: kamal@jnknutrition.com</p>
    </main>
  );
}
