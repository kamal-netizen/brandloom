import { describe, expect, it } from "vitest";
import { DEFAULT_SCOPES, generateToken, hasScope, parseScopes } from "@/lib/api-auth";
import { sha256Hex } from "@/lib/crypto";
import { autoPick } from "@/lib/meta/connections";
import { makeState, readState } from "@/lib/meta/oauth";

describe("API tokens", () => {
  it("generates bl_ tokens and stores only the hash", () => {
    const { token, prefix, hash } = generateToken();
    expect(token).toMatch(/^bl_[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(prefix)).toBe(true);
    expect(hash).toBe(sha256Hex(token));
    expect(hash).not.toContain(token.slice(3));
  });

  it("parses scopes and ignores unknown ones", () => {
    expect(parseScopes("posts:read, posts:write,admin:*")).toEqual(["posts:read", "posts:write"]);
  });

  it("does not grant posts:approve by default", () => {
    expect(DEFAULT_SCOPES).not.toContain("posts:approve");
    expect(hasScope({ scopes: DEFAULT_SCOPES.join(",") }, "posts:approve")).toBe(false);
    expect(hasScope({ scopes: "posts:read,posts:approve" }, "posts:approve")).toBe(true);
  });
});

describe("OAuth state", () => {
  it("accepts its own state with the matching nonce", () => {
    const { state, nonce } = makeState("corechamps");
    expect(readState(state, nonce)).toBe("corechamps");
  });

  it("rejects a forged brand, a wrong nonce and a missing cookie", () => {
    const { state, nonce } = makeState("corechamps");
    expect(readState(state.replace("corechamps", "jnk"), nonce)).toBeNull();
    expect(readState(state, "other")).toBeNull();
    expect(readState(state, undefined)).toBeNull();
  });
});

describe("page auto-pick", () => {
  const page = (id: string, user: string | null) => ({
    pageId: id,
    pageName: `Page ${id}`,
    pageToken: "t",
    ig: user ? { id: `ig${id}`, username: user } : null,
  });
  it("binds the only Page with Instagram", () => {
    expect(autoPick([page("1", null), page("2", "corechamps")], null)?.pageId).toBe("2");
  });
  it("matches the brand handle when there are several", () => {
    expect(autoPick([page("1", "jnknutrition"), page("2", "CoreChamps")], "@corechamps")?.pageId).toBe("2");
  });
  it("asks when it cannot tell", () => {
    expect(autoPick([page("1", "a"), page("2", "b")], null)).toBeNull();
  });
});
