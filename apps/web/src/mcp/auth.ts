import { mcpToken } from "@agent-board/db";
import type { ErrorCode } from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { hashToken, parseBearerToken } from "./token";
import type { AuthContext, McpDatabase } from "./types";

export type AuthSuccess = { ok: true; ctx: AuthContext };
export type AuthFailure = {
  ok: false;
  status: 401;
  code: ErrorCode;
  message: string;
};
export type AuthResult = AuthSuccess | AuthFailure;

function fail(code: ErrorCode, message: string): AuthFailure {
  return { ok: false, status: 401, code, message };
}

export async function authenticateBearer(
  db: McpDatabase,
  authorization: string | null | undefined,
): Promise<AuthResult> {
  const secret = parseBearerToken(authorization ?? null);
  if (!secret) {
    return fail(
      "TOKEN_MISSING",
      "Authorization: Bearer <token> is required.",
    );
  }

  const hash = hashToken(secret);
  const [row] = await db
    .select()
    .from(mcpToken)
    .where(eq(mcpToken.hash, hash))
    .limit(1);

  if (!row) {
    return fail("UNAUTHORIZED", "Invalid MCP token.");
  }
  if (row.revoked) {
    return fail("TOKEN_REVOKED", "MCP token was revoked.");
  }

  await db
    .update(mcpToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(mcpToken.id, row.id));

  return {
    ok: true,
    ctx: {
      tokenId: row.id,
      workspaceId: row.workspaceId,
      tokenLabel: row.label,
      canManage: row.canManage,
    },
  };
}
