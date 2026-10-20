import { describe, expect, it } from "vitest";
import { decrypt, encrypt, safeEqual } from "@/lib/crypto";

const KEY = "ab".repeat(32);

describe("crypto", () => {
  it("round-trips a token", () => {
    const sealed = encrypt("EAAG-page-token", KEY);
    expect(sealed).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(sealed).not.toContain("EAAG");
    expect(decrypt(sealed, KEY)).toBe("EAAG-page-token");
  });

  it("uses a fresh IV every time", () => {
    expect(encrypt("same", KEY)).not.toBe(encrypt("same", KEY));
  });

  it("fails loudly on a tampered row", () => {
    const [v, iv, tag, ct] = encrypt("secret", KEY).split(":");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64url")].join(":"), KEY)).toThrow(/unable to decrypt/);
  });

  it("fails with the wrong key", () => {
    expect(() => decrypt(encrypt("secret", KEY), "cd".repeat(32))).toThrow(/unable to decrypt/);
  });

  it("rejects short keys and unknown formats", () => {
    expect(() => encrypt("x", "abcd")).toThrow(/64 hex/);
    expect(() => encrypt("x", "")).toThrow(/not set/);
    expect(() => decrypt("v2:a:b:c", KEY)).toThrow(/malformed/);
  });

  it("compares in constant time without throwing on length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
