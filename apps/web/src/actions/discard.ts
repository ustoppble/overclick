"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { authContextForUser } from "../lib/scope";
import { CARD_NOT_FOUND, sessionPrincipal, visibleCardWorkspace } from "../lib/web-scope";
import { invokeTool } from "../mcp/tools";

/**
 * Human discard from the card detail (OCL-203). It goes through task_update,
 * the same path MCP uses, so the board and an agent follow one rule: what one
 * of them can discard, the other can too, and a refusal reads the same.
 */
export async function discardTaskAction(
  taskId: string,
  reason: string,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (!reason.trim()) {
    return { ok: false, error: "Say why the card is being discarded." };
  }

  const workspaceId = await visibleCardWorkspace(await sessionPrincipal(session), taskId);
  if (!workspaceId) return { ok: false, error: CARD_NOT_FOUND };

  const acting = await authContextForUser(db(), session, workspaceId);
  if (!acting) return { ok: false, error: "Session expired. Sign in again." };
  const discarded = await invokeTool(
    db(),
    acting,
    "task_update",
    { task_id: taskId, status: "descartado", comment: reason.trim() },
  );
  if (!discarded.ok) {
    // The tool's own not-found text differs from ours; one answer only.
    const error = discarded.error.code === "NOT_FOUND" ? CARD_NOT_FOUND : discarded.error.message;
    return { ok: false, error };
  }

  revalidatePath("/board");
  return { ok: true };
}
