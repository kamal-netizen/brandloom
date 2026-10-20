import { describe, expect, it } from "vitest";
import { appendHashtags, captionLength, checkCaption, hashtagsIn, mentionsIn, normaliseTags } from "@/lib/caption";

describe("caption limits", () => {
  it("accepts a normal caption", () => {
    const c = checkCaption("Fuel the grind 💪 @corechamps\n\n#whey #gym");
    expect(c).toMatchObject({ ok: true, hashtags: 2, mentions: 1 });
  });

  it("counts code points, not UTF-16 units", () => {
    expect(captionLength("💪💪")).toBe(2);
    expect(checkCaption("💪".repeat(2200)).ok).toBe(true);
    expect(checkCaption("💪".repeat(2201)).ok).toBe(false);
  });

  it("enforces 30 hashtags and 20 mentions (distinct)", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    expect(checkCaption(tags).errors[0]).toMatch(/31 hashtags/);
    expect(checkCaption("#a #a #a").hashtags).toBe(1);
    const at = Array.from({ length: 21 }, (_, i) => `@user${i}`).join(" ");
    expect(checkCaption(at).errors[0]).toMatch(/21 mentions/);
  });

  it("does not count emails or URL fragments as mentions/hashtags", () => {
    expect(mentionsIn("mail kamal@jnknutrition.com")).toEqual([]);
    expect(hashtagsIn("see https://x.com/a#section and AT&#39;")).toEqual([]);
    expect(hashtagsIn("Arabic #بروتين works")).toEqual(["#بروتين"]);
  });
});

describe("hashtag sets", () => {
  it("normalises messy input", () => {
    expect(normaliseTags("gym, #Whey  ##protein whey bad-tag")).toBe("#gym #Whey #protein");
  });

  it("appends without duplicating tags already in the caption", () => {
    expect(appendHashtags("New flavour! #whey", "#whey #gym")).toBe("New flavour! #whey\n\n#gym");
    expect(appendHashtags("Done #gym", "#GYM")).toBe("Done #gym");
    expect(appendHashtags("", "#a #b")).toBe("#a #b");
  });
});
