import { db } from "../../../lib/db";
import { exchangePairingCode } from "../../../lib/pairing";

export const dynamic = "force-dynamic";

/**
 * Public one-time pairing endpoint. The agent posts the 6-digit code the
 * human read out loud and receives the real bearer token, so the token
 * never travels through a chat. Codes are single-use with a short TTL and
 * only one is active per workspace.
 *
 * The flat delay below is not what makes guessing impractical: it is paid
 * per request, so parallel guesses wait in parallel and the ceiling is the
 * caller's connection count. What bounds the guessing is the failure
 * budget in exchangePairingCode, which burns the live codes once it runs
 * out. The delay stays because it costs an honest caller nothing.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { code?: unknown }
    | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";

  const result = await exchangePairingCode(db(), code);
  if (!result.ok) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return Response.json({ error: result.error }, { status: 404 });
  }

  return Response.json({
    token: result.token,
    label: result.label,
    url: "/mcp",
    connect:
      "Use the token as an Authorization: Bearer header on the /mcp endpoint of this host.",
  });
}
