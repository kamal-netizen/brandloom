import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chunkPlan, TiktokError, type CreatorInfo } from "@/lib/tiktok/api";
import { authorizeUrl, challengeFor, makeVerifier, openLogin, sealLogin } from "@/lib/tiktok/oauth";
import { DEFAULT_SETTINGS, finalSettings, postInfoFor, settingsProblems, TiktokSettingsError } from "@/lib/tiktok/settings";

process.env.TOKEN_ENCRYPTION_KEY ||= "0".repeat(63) + "1";
const MB = 1024 * 1024;

describe("chunkPlan (TikTok FILE_UPLOAD rules)", () => {
  it("sends a file under 5 MB as one chunk of its own size", () => {
    expect(chunkPlan(4 * MB)).toMatchObject({ chunkSize: 4 * MB, chunkCount: 1, ranges: [[0, 4 * MB]] });
  });

  it("rounds the count down and puts the remainder on the last chunk", () => {
    const size = 50_000_123;
    const p = chunkPlan(size, 10_000_000);
    expect(p.chunkCount).toBe(5);
    expect(p.ranges.at(-1)).toEqual([40_000_000, size]);
    expect(p.ranges.reduce((n, [a, b]) => n + (b - a), 0)).toBe(size);
  });

  it("keeps every chunk within 5–64 MB and the last under 128 MB, for any reel size", () => {
    for (const size of [5 * MB, 10 * MB - 1, 10 * MB, 19.9 * MB, 64 * MB, 299 * MB].map(Math.floor)) {
      const p = chunkPlan(size);
      const lens = p.ranges.map(([a, b]) => b - a);
      expect(p.ranges[0][0]).toBe(0);
      expect(p.ranges.at(-1)![1]).toBe(size);
      for (const l of lens.slice(0, -1)) expect(l).toBe(p.chunkSize);
      expect(lens.at(-1)!).toBeLessThanOrEqual(128 * MB);
      if (p.chunkCount > 1) expect(p.chunkSize).toBeGreaterThanOrEqual(5 * MB);
      expect(p.chunkSize).toBeLessThanOrEqual(64 * MB);
    }
  });
});

describe("Login Kit", () => {
  it("uses a hex SHA-256 PKCE challenge, as TikTok computes it", () => {
    const v = makeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challengeFor(v)).toBe(createHash("sha256").update(v).digest("hex"));
  });

  it("asks for the three scopes with state and PKCE", () => {
    process.env.TIKTOK_CLIENT_KEY = "ck";
    process.env.PUBLIC_BASE_URL = "https://brandloom.example";
    const u = new URL(authorizeUrl("st", "verifier-verifier-verifier-verifier-verifier"));
    expect(u.origin + u.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_key: "ck",
      response_type: "code",
      scope: "user.info.basic,video.publish,video.upload",
      redirect_uri: "https://brandloom.example/api/tiktok/callback",
      state: "st",
      code_challenge_method: "S256",
    });
  });

  it("seals the nonce and verifier in the login cookie", () => {
    const sealed = sealLogin("n1", "the-verifier");
    expect(sealed).not.toContain("the-verifier");
    expect(openLogin(sealed)).toMatchObject({ nonce: "n1", verifier: "the-verifier" });
    expect(openLogin("garbage")).toBeNull();
  });
});

const creator: CreatorInfo = {
  nickname: "Core Champs",
  username: "corechamps",
  privacyOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: true,
  stitchDisabled: false,
  maxDurationSec: 600,
};

describe("TikTok post settings", () => {
  it("forces SELF_ONLY while the app is unaudited, and refuses branded content then", () => {
    const s = { ...DEFAULT_SETTINGS, privacy: null };
    expect(settingsProblems(s, "t", true)).toEqual([]);
    expect(finalSettings(s, true).privacy).toBe("SELF_ONLY");
    expect(postInfoFor({ ...s, privacy: "PUBLIC_TO_EVERYONE" }, "t", creator, true).privacy_level).toBe("SELF_ONLY");
    expect(settingsProblems({ ...s, brandedContent: true }, "t", true).join(" ")).toMatch(/Branded content cannot be private/);
  });

  it("requires a chosen privacy once audited, from the creator's options", () => {
    expect(settingsProblems(DEFAULT_SETTINGS, "t", false)).toEqual(["Choose who can see the TikTok post."]);
    expect(() => postInfoFor({ ...DEFAULT_SETTINGS, privacy: "FOLLOWER_OF_CREATOR" }, "t", creator, false)).toThrow(TiktokSettingsError);
  });

  it("turns interactions off unless chosen, and off where the creator disabled them", () => {
    const info = postInfoFor({ ...DEFAULT_SETTINGS, privacy: "SELF_ONLY", allowComment: true, allowDuet: true, yourBrand: true }, "Cracked.", creator, true);
    expect(info).toEqual({
      title: "Cracked.",
      privacy_level: "SELF_ONLY",
      disable_comment: false,
      disable_duet: true, // creator has duet off
      disable_stitch: true, // not chosen
      brand_content_toggle: false,
      brand_organic_toggle: true,
    });
  });

  it("checks the 2200-character title", () => {
    expect(settingsProblems(DEFAULT_SETTINGS, "x".repeat(2201), true)[0]).toMatch(/2200/);
  });
});

describe("TiktokError", () => {
  it("classifies TikTok's string codes", () => {
    expect(new TiktokError("x", 429, "rate_limit_exceeded").transient).toBe(true);
    expect(new TiktokError("x", 503, "whatever").transient).toBe(true);
    expect(new TiktokError("x", 401, "access_token_invalid").auth).toBe(true);
    expect(new TiktokError("x", 403, "spam_risk_too_many_posts").quota).toBe(true);
    expect(new TiktokError("x", 403, "privacy_level_option_mismatch").transient).toBe(false);
  });
});
