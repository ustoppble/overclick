"use server";

import { mcpToken } from "@agent-board/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { createPairingCode, pairingStatus } from "../lib/pairing";
import { generateTokenSecret, hashToken } from "../mcp/token";
import type { ActionResult } from "../lib/action-result";

export type CreateTokenResult =
  | { ok: true; id: string; secret: string }
  | { ok: false; error: string };

/**
 * Generates a real MCP token. The secret is only returned in this response, once.
 * `canManage` opens the configuration tools (harness_set, executors_update) to
 * that token and is off unless the owner asks for it.
 */
export async function createTokenAction(
  label: string,
  canManage = false,
): Promise<CreateTokenResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  const name = label.trim();
  if (!name) return { ok: false, error: "Give the token a name (e.g. Claude Code on this machine)." };

  const secret = generateTokenSecret();
  try {
    const [row] = await db()
      .insert(mcpToken)
      .values({
        workspaceId: ws.id,
        label: name,
        hash: hashToken(secret),
        tokenPrefix: secret.slice(0, 12),
        canManage,
        createdByUserId: session.userId,
      })
      .returning({ id: mcpToken.id });
    if (!row) return { ok: false, error: "Could not create the token." };
    revalidatePath("/settings");
    return { ok: true, id: row.id, secret };
  } catch {
    return { ok: false, error: "A token with that name already exists." };
  }
}

/**
 * Grants or takes back the manage capability on a token that already exists.
 *
 * Without this the flag could only be decided at creation time, on the manual
 * "generate token" form — and a token created by pairing, which is how the
 * plugin installs, always landed with it off and no way up. The MCP refusal
 * then asked for a permission the UI had no control for (OCL-136, issue #71).
 * Revoked tokens are left alone: reviving one by capability is not a thing.
 */
export async function setTokenManageAction(
  tokenId: string,
  canManage: boolean,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  const [row] = await db()
    .update(mcpToken)
    .set({ canManage })
    .where(
      and(
        eq(mcpToken.id, tokenId),
        eq(mcpToken.workspaceId, ws.id),
        eq(mcpToken.revoked, false),
      ),
    )
    .returning({ id: mcpToken.id });
  if (!row) return { ok: false, error: "Token not found, or it was revoked." };

  revalidatePath("/settings");
  return { ok: true };
}

export async function revokeTokenAction(tokenId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  await db()
    .update(mcpToken)
    .set({ revoked: true, revokedAt: new Date() })
    .where(and(eq(mcpToken.id, tokenId), eq(mcpToken.workspaceId, ws.id)));
  revalidatePath("/settings");
  return { ok: true };
}

export type CreatePairingResult =
  | { ok: true; id: string; code: string; expiresAt: string }
  | { ok: false; error: string };

/**
 * One-time pairing code: the human reads the 6 digits to the agent and the
 * agent exchanges them on the public /api/pair endpoint for the real token.
 * The bearer value never appears in a conversation.
 */
export async function createPairingCodeAction(
  label: string,
): Promise<CreatePairingResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  const created = await createPairingCode(db(), {
    workspaceId: ws.id,
    label: label.trim() || "paired agent",
    userId: session.userId,
  });
  return {
    ok: true,
    id: created.id,
    code: created.code,
    expiresAt: created.expiresAt.toISOString(),
  };
}

/** Wizard polling for the pairing path: lit once the code was exchanged. */
export async function pollPairingAction(id: string): Promise<{ paired: boolean }> {
  const session = await getSession();
  if (!session) return { paired: false };
  return pairingStatus(db(), id);
}

/** Polling for the "waiting for the first connection" indicator (wizard T3). */
export async function pollTokenAction(
  tokenId: string,
): Promise<{ used: boolean; usedAt: string | null }> {
  const session = await getSession();
  if (!session) return { used: false, usedAt: null };

  const row = await db().query.mcpToken.findFirst({
    where: eq(mcpToken.id, tokenId),
    columns: { lastUsedAt: true },
  });
  return {
    used: row?.lastUsedAt != null,
    usedAt: row?.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * Has any agent ever reached this workspace? The wizard asks this on mount,
 * because the human leaves the page to paste the command in a terminal: the
 * token id lives in React state and does not survive a reload, so an indicator
 * that only polls what the tab remembers waits forever for a connection that
 * already happened.
 */
export async function workspaceEverConnectedAction(): Promise<{
  connected: boolean;
  at: string | null;
}> {
  const session = await getSession();
  if (!session) return { connected: false, at: null };

  const rows = await db()
    .select({ lastUsedAt: mcpToken.lastUsedAt })
    .from(mcpToken)
    .where(isNotNull(mcpToken.lastUsedAt))
    .orderBy(desc(mcpToken.lastUsedAt))
    .limit(1);

  const at = rows[0]?.lastUsedAt ?? null;
  return { connected: at != null, at: at ? at.toISOString() : null };
}
