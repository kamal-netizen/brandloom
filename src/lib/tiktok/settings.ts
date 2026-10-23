import type { CreatorInfo, PostInfo, PrivacyLevel } from "./api";

/**
 * What a person chose for a TikTok post (Post.tiktokJson), following
 * TikTok's Direct Post UX rules: privacy is picked (no default), comments /
 * duet / stitch are off unless switched on, and commercial content is
 * disclosed as "your brand" (promotional) and/or "branded content" (paid
 * partnership).
 *
 * Until Brandloom passes TikTok's app audit, an unaudited client may only
 * post SELF_ONLY: TIKTOK_PRIVATE_ONLY (on unless set to 0) forces that, and
 * branded content — which cannot be private — is refused meanwhile.
 */
export type TiktokSettings = {
  privacy: PrivacyLevel | null;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
};

export const PRIVACY_LEVELS: PrivacyLevel[] = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];

export const PRIVACY_LABEL: Record<PrivacyLevel, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  FOLLOWER_OF_CREATOR: "Followers",
  MUTUAL_FOLLOW_FRIENDS: "Friends (followers you follow back)",
  SELF_ONLY: "Only me",
};

/** API / CLI spelling. */
export const PRIVACY_ALIASES: Record<string, PrivacyLevel> = {
  public: "PUBLIC_TO_EVERYONE",
  everyone: "PUBLIC_TO_EVERYONE",
  followers: "FOLLOWER_OF_CREATOR",
  friends: "MUTUAL_FOLLOW_FRIENDS",
  self: "SELF_ONLY",
  private: "SELF_ONLY",
  only_me: "SELF_ONLY",
};

export const TIKTOK_TITLE_MAX = 2200;

export function tiktokPrivateOnly(): boolean {
  return process.env.TIKTOK_PRIVATE_ONLY !== "0" && process.env.TIKTOK_PRIVATE_ONLY !== "false";
}

export const DEFAULT_SETTINGS: TiktokSettings = {
  privacy: null,
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  yourBrand: false,
  brandedContent: false,
};

export function parseSettings(json: string): TiktokSettings {
  if (!json) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(json) as Partial<TiktokSettings>;
    return {
      privacy: raw.privacy && PRIVACY_LEVELS.includes(raw.privacy) ? raw.privacy : null,
      allowComment: Boolean(raw.allowComment),
      allowDuet: Boolean(raw.allowDuet),
      allowStitch: Boolean(raw.allowStitch),
      yourBrand: Boolean(raw.yourBrand),
      brandedContent: Boolean(raw.brandedContent),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Problems a person must fix before a TikTok post can be accepted (empty = fine). */
export function settingsProblems(s: TiktokSettings, title: string, privateOnly = tiktokPrivateOnly()): string[] {
  const out: string[] = [];
  if (title.length > TIKTOK_TITLE_MAX) out.push(`TikTok titles are at most ${TIKTOK_TITLE_MAX} characters; this one is ${title.length}.`);
  if (!privateOnly && !s.privacy) out.push("Choose who can see the TikTok post.");
  if (privateOnly && s.privacy && s.privacy !== "SELF_ONLY") out.push("Until Brandloom passes TikTok's review, TikTok posts can only be private (Only me).");
  if (s.brandedContent && privateOnly) out.push("Branded content cannot be private, and TikTok posts are private-only until Brandloom passes TikTok's review.");
  if (s.brandedContent && s.privacy === "SELF_ONLY") out.push("Branded content visibility cannot be set to private.");
  return out;
}

/** Normalises what was chosen for storage: private-only mode stores SELF_ONLY. */
export function finalSettings(s: TiktokSettings, privateOnly = tiktokPrivateOnly()): TiktokSettings {
  return { ...s, privacy: privateOnly ? "SELF_ONLY" : s.privacy };
}

export class TiktokSettingsError extends Error {}

/**
 * The post_info for /video/init/, checked against the creator's current
 * options (which can change between scheduling and publishing).
 */
export function postInfoFor(s: TiktokSettings, title: string, creator: CreatorInfo, privateOnly = tiktokPrivateOnly()): PostInfo {
  const privacy: PrivacyLevel | null = privateOnly ? "SELF_ONLY" : s.privacy;
  if (!privacy) throw new TiktokSettingsError("No TikTok privacy level was chosen for this post.");
  if (!creator.privacyOptions.includes(privacy)) {
    throw new TiktokSettingsError(
      `TikTok no longer offers "${PRIVACY_LABEL[privacy]}" for @${creator.username || creator.nickname} (offers: ${creator.privacyOptions.map((p) => PRIVACY_LABEL[p]).join(", ") || "none"}). Edit the post's privacy.`
    );
  }
  if (s.brandedContent && privacy === "SELF_ONLY") throw new TiktokSettingsError("Branded content visibility cannot be set to private.");
  return {
    title: title.slice(0, TIKTOK_TITLE_MAX),
    privacy_level: privacy,
    disable_comment: !s.allowComment || creator.commentDisabled,
    disable_duet: !s.allowDuet || creator.duetDisabled,
    disable_stitch: !s.allowStitch || creator.stitchDisabled,
    brand_content_toggle: s.brandedContent,
    brand_organic_toggle: s.yourBrand,
  };
}

/** One line for the post page / API: "Only me · comments on · promotional". */
export function describeSettings(s: TiktokSettings): string {
  const parts = [s.privacy ? PRIVACY_LABEL[s.privacy] : "privacy not chosen"];
  const on = [s.allowComment && "comments", s.allowDuet && "duet", s.allowStitch && "stitch"].filter(Boolean);
  parts.push(on.length ? `allows ${on.join(", ")}` : "no comments / duet / stitch");
  if (s.brandedContent) parts.push("Paid partnership");
  else if (s.yourBrand) parts.push("Promotional content");
  return parts.join(" · ");
}
