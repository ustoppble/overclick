import { clientOrigin } from "../../../lib/client-origin";
import { db } from "../../../lib/db";
import { exchangePairingCode } from "../../../lib/pairing";

export const dynamic = "force-dynamic";

/**
 * Who is guessing, as far as this deployment can honestly tell: see
 * `clientOrigin`. Undeclared, everyone shares one bucket. That still refuses
 * a burst and still destroys nothing; what it loses is the ability to tell
 * the guesser apart from the honest agent, which is why the hosted overlay
 * sets the flag and the quickstart, which nobody should expose, does not.
 */
function guessOrigin(request: Request): string | null {
  return clientOrigin(request.headers);
}

/**
 * Public one-time pairing endpoint. The agent posts the 6-digit code the
 * human read out loud and receives the real bearer token, so the token
 * never travels through a chat. Codes are single-use with a short TTL and
 * only one is active per workspace.
 *
 * The flat delay below is not what makes guessing impractical: it is paid
 * per request, so parallel guesses wait in parallel and the ceiling is the
 * caller's connection count. What bounds the guessing is the attempt budget
 * in exchangePairingCode, which stops evaluating codes for an origin that
 * has spent it. The delay stays because it costs an honest caller nothing
 * and because paying it on every refusal is what keeps the two kinds of
 * refusal — wrong code, and no budget left to look — indistinguishable.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { code?: unknown }
    | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";

  const result = await exchangePairingCode(db(), code, guessOrigin(request));
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
