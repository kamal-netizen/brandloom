import { apiErrorResponse, authenticate, parseScopes } from "@/lib/api-auth";

export async function GET(req: Request) {
  try {
    const token = await authenticate(req);
    return Response.json({ token: { name: token.name, prefix: token.prefix, scopes: parseScopes(token.scopes) } });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
