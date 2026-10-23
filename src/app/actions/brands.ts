"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { assertAdmin } from "@/lib/admin";
import { brandRuleViolations, normaliseTags } from "@/lib/caption";
import { bindPage, ConnectError, openPick, PICK_COOKIE } from "@/lib/meta/connections";
import { pagesWithInstagram } from "@/lib/meta/oauth";
import { GraphError } from "@/lib/meta/graph";
import { refreshRights } from "@/lib/meta/rights";
import { disconnectTiktok } from "@/lib/tiktok/connections";

const HEX = /^#[0-9a-fA-F]{6}$/;

function str(f: FormData, k: string) {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
}

export async function saveBrandAction(f: FormData) {
  await assertAdmin();
  const slug = str(f, "slug");
  const colors = ["primaryColor", "secondaryColor", "accentColor"].map((k) => str(f, k));
  if (!colors.every((c) => HEX.test(c))) redirect(`/brands/${slug}?error=${encodeURIComponent("Colours must be #rrggbb.")}`);
  await db.brand.update({
    where: { slug },
    data: {
      name: str(f, "name") || undefined,
      igHandle: str(f, "igHandle").replace(/^@/, "") || null,
      website: str(f, "website") || null,
      primaryColor: colors[0],
      secondaryColor: colors[1],
      accentColor: colors[2],
      voiceNotes: str(f, "voiceNotes").slice(0, 2000),
      logoAssetId: str(f, "logoAssetId") || null,
    },
  });
  redirect(`/brands/${slug}?ok=${encodeURIComponent("Brand kit saved.")}`);
}

export async function saveHashtagSetAction(f: FormData) {
  await assertAdmin();
  const slug = str(f, "slug");
  const brand = await db.brand.findUniqueOrThrow({ where: { slug } });
  const name = str(f, "name").toLowerCase().replace(/[^a-z0-9-_ ]/g, "").slice(0, 40);
  const tags = normaliseTags(str(f, "tags"));
  if (!name || !tags) redirect(`/brands/${slug}?error=${encodeURIComponent("A set needs a name and at least one tag.")}`);
  const bad = brandRuleViolations(tags, brand.blockedTerms);
  if (bad.length) redirect(`/brands/${slug}?error=${encodeURIComponent(`${brand.name} is an international brand: no ${bad.join(", ")} in its hashtags.`)}#hashtags`);
  const isDefault = str(f, "isDefault") === "on";
  if (isDefault) await db.hashtagSet.updateMany({ where: { brandId: brand.id }, data: { isDefault: false } });
  await db.hashtagSet.upsert({
    where: { brandId_name: { brandId: brand.id, name } },
    create: { brandId: brand.id, name, tags, isDefault },
    update: { tags, ...(isDefault ? { isDefault } : {}) },
  });
  redirect(`/brands/${slug}?ok=${encodeURIComponent(`Hashtag set "${name}" saved.`)}#hashtags`);
}

export async function deleteHashtagSetAction(f: FormData) {
  await assertAdmin();
  const slug = str(f, "slug");
  await db.hashtagSet.delete({ where: { id: str(f, "id") } }).catch(() => {});
  redirect(`/brands/${slug}#hashtags`);
}

export async function disconnectAction(f: FormData) {
  await assertAdmin();
  const slug = str(f, "slug");
  const brand = await db.brand.findUniqueOrThrow({ where: { slug } });
  // The encrypted token is overwritten, not just flagged.
  await db.igConnection.updateMany({ where: { brandId: brand.id }, data: { status: "DISCONNECTED", pageTokenEnc: "v1:x:x:x" } });
  redirect(`/brands/${slug}?ok=${encodeURIComponent("Disconnected.")}`);
}

/** Page picker submit (after the OAuth callback found several Pages). */
export async function pickPageAction(f: FormData) {
  const user = await assertAdmin();
  const slug = str(f, "slug");
  const jar = await cookies();
  const pick = openPick(jar.get(PICK_COOKIE)?.value, slug);
  if (!pick) redirect(`/brands/${slug}?error=${encodeURIComponent("That login has expired; Connect again.")}`);
  const brand = await db.brand.findUniqueOrThrow({ where: { slug } });
  let q: string;
  try {
    const pages = await pagesWithInstagram(pick.token);
    const page = pages.find((p) => p.pageId === str(f, "pageId"));
    if (!page) throw new ConnectError("That Page is no longer available to this login.");
    await bindPage(brand.id, page, pick.expiresAt ? new Date(pick.expiresAt) : null, user.id);
    jar.delete(PICK_COOKIE);
    q = "connected=1";
  } catch (err) {
    q = "error=" + encodeURIComponent(err instanceof ConnectError ? err.message : err instanceof GraphError ? err.display : "Connecting failed.");
  }
  redirect(`/brands/${slug}?${q}`);
}

export async function checkRightsAction(f: FormData) {
  await assertAdmin();
  const slug = str(f, "slug");
  const brand = await db.brand.findUniqueOrThrow({ where: { slug }, include: { connection: true } });
  if (brand.connection) await refreshRights(brand.connection);
  redirect(`/brands/${slug}?ok=${encodeURIComponent("Publishing rights checked.")}`);
}

/** Revokes the TikTok login and erases its tokens. */
export async function disconnectTiktokAction(f: FormData) {
  await assertAdmin();
  const slug = str(f, "slug");
  const brand = await db.brand.findUniqueOrThrow({ where: { slug } });
  await disconnectTiktok(brand.id);
  redirect(`/brands/${slug}?ok=${encodeURIComponent("TikTok disconnected; its tokens are erased.")}#tiktok`);
}
