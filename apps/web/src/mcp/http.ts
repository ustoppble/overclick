import { loginFailure } from "@agent-board/db";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { chargeBudget } from "../lib/attempt-budget";
import { BODY_LIMITS, declaredTooLarge, readBodyCapped } from "../lib/body-limit";
import { clientOrigin } from "../lib/client-origin";
import { db } from "../lib/db";
import { authenticateBearer } from "./auth";
import { createOverclickMcpServer } from "./server";
import type { McpDatabase } from "./types";

/**
 * Invalid tokens one origin may present inside the window before the door
 * answers 429 instead of 401. Only failures are charged: a good token is
 * never spent against this, so an honest agent sharing an address (or the one
 * shared bucket of a deploy that names no proxy) keeps working.
 */
const MCP_AUTH_FAILURES = 30;
const MCP_AUTH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Same bucket table and accounting as the sign-in budgets
 * (`loginFailure`, swept by `sweepLoginRows`), under a scope of its own.
 */
function authFailureScope(request: Request): string {
  const origin = clientOrigin(request.headers)?.trim().slice(0, 100);
  return `mcp-auth:origin:${origin || "unknown"}`;
}

function tooLarge(status: 400 | 413): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: status === 413 ? "Request body too large." : "Invalid Content-Length.",
      },
      id: null,
    },
    { status },
  );
}

export async function handleMcpRequest(
  request: Request,
  deps?: { db: McpDatabase },
): Promise<Response> {
  // OCL-214: this route runs without sessions, so it has no event stream to
  // offer. The transport used to answer GET with a stream that closed at once,
  // and every live client reopened it in a loop (about 12 GETs a second in
  // production, each rebuilding the whole server). 405 is the spec's way to
  // say "no stream here"; clients stop asking.
  if (request.method === "GET") {
    return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
  }
  // A declared length over the ceiling is refused before anything else is
  // spent on the caller, the token lookup included.
  const declared = declaredTooLarge(request, BODY_LIMITS.mcp);
  if (declared && !declared.ok) return tooLarge(declared.status);

  const database = deps?.db ?? db();
  const auth = await authenticateBearer(
    database,
    request.headers.get("authorization"),
  );
  if (!auth.ok) {
    const charge = await chargeBudget(
      database,
      loginFailure,
      authFailureScope(request),
      MCP_AUTH_FAILURES,
      MCP_AUTH_WINDOW_MS,
    );
    if (!charge.ok) {
      return Response.json(
        { error: { code: "RATE_LIMITED", message: "Too many invalid tokens. Try again later." } },
        { status: 429, headers: { "Retry-After": String(MCP_AUTH_WINDOW_MS / 1000) } },
      );
    }
    return Response.json(
      { error: { code: auth.code, message: auth.message } },
      { status: 401 },
    );
  }

  // The body is read by us, under the ceiling, and handed to the transport
  // parsed: a chunked upload has no Content-Length to refuse up front.
  let parsedBody: unknown;
  if (request.method === "POST") {
    const read = await readBodyCapped(request, BODY_LIMITS.mcp);
    if (!read.ok) return tooLarge(read.status);
    try {
      parsedBody = JSON.parse(read.text);
    } catch {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null },
        { status: 400 },
      );
    }
    if (Array.isArray(parsedBody) && parsedBody.length > BODY_LIMITS.mcpBatch) {
      return tooLarge(413);
    }
  }

  const server = await createOverclickMcpServer({ db: database, ctx: auth.ctx });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await transport.close();
    await server.close();
  }
}
