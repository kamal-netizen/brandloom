import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, authenticate, hasScope } from "@/lib/api-auth";
import { serializePost } from "@/lib/api-serialize";
import { cancelPost, editPost, PostError } from "@/lib/posts";
import { parseDubai } from "@/lib/time";

type Ctx = { params: Promise<{ id: string }> };

async function full(id: string) {
  const post = await db.post.findUnique({
    where: { id },
    include: {
      brand: { select: { slug: true } },
      media: { include: { rendition: true } },
      attempts: { orderBy: { startedAt: "desc" }, take: 20 },
    },
  });
  if (!post) throw new ApiError(404, "not_found", "Post not found.");
  return post;
}

function wrap(err: unknown) {
  if (err instanceof PostError) return apiErrorResponse(new ApiError(err.status, err.code, err.message));
  return apiErrorResponse(err);
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    await authenticate(req, "posts:read");
    const post = await full((await params).id);
    return Response.json({
      post: {
        ...serializePost(post),
        attempts: post.attempts.map((a) => ({ step: a.step, ok: a.ok, at: a.startedAt.toISOString(), error: a.error, code: a.igErrorCode })),
      },
    });
  } catch (err) {
    return wrap(err);
  }
}

/** JSON { caption?, scheduledAt? }. Editing an approved post without posts:approve sends it back for approval. */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const token = await authenticate(req, "posts:write");
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { caption?: unknown; scheduledAt?: unknown } | null;
    if (!body) throw new ApiError(400, "invalid", "Body must be JSON.");
    const changes: { caption?: string; scheduledAt?: Date | null } = {};
    if (typeof body.caption === "string") changes.caption = body.caption;
    if (body.scheduledAt === null) changes.scheduledAt = null;
    else if (typeof body.scheduledAt === "string") {
      const at = parseDubai(body.scheduledAt);
      if (!at) throw new ApiError(400, "invalid", "scheduledAt must be an ISO time (Dubai if no offset).");
      changes.scheduledAt = at;
    }
    await editPost(id, changes, { canApprove: hasScope(token, "posts:approve") });
    return Response.json({ post: serializePost(await full(id)) });
  } catch (err) {
    return wrap(err);
  }
}

/** Soft delete: the post becomes CANCELLED. */
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    await authenticate(req, "posts:write");
    const { id } = await params;
    await cancelPost(id);
    return Response.json({ post: serializePost(await full(id)) });
  } catch (err) {
    return wrap(err);
  }
}
