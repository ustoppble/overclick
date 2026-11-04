"use server";

import { validClaimTimeoutMinutes, workspace } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { authContextForUser } from "../lib/scope";
import {
  ADMIN_ONLY,
  CARD_NOT_FOUND,
  sessionCanManageWorkspace,
  sessionPrincipal,
  visibleCardWorkspace,
} from "../lib/web-scope";
import { invokeTool } from "../mcp/tools";

/** Human release from the card detail, using the same atomic path as MCP. */
export async function releaseClaimAction(taskId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const workspaceId = await visibleCardWorkspace(await sessionPrincipal(session), taskId);
  if (!workspaceId) return { ok: false, error: CARD_NOT_FOUND };

  const acting = await authContextForUser(db(), session, workspaceId);
  if (!acting) return { ok: false, error: "Session expired. Sign in again." };
  const released = await invokeTool(
    db(),
    acting,
    "task_release",
    { task_id: taskId, reason: "released by a signed-in human from the board" },
  );
  if (!released.ok) {
    // The tool's own not-found text differs from ours; one answer only.
    const error = released.error.code === "NOT_FOUND" ? CARD_NOT_FOUND : released.error.message;
    return { ok: false, error };
  }

  revalidatePath("/board");
  return { ok: true };
}

/** Persists the workspace lease used by stale-claim recovery. */
export async function saveClaimTimeoutAction(
  timeoutMinutes: number,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  // The claim lease is workspace configuration: the admin's.
  if (!(await sessionCanManageWorkspace(session))) return { ok: false, error: ADMIN_ONLY };
  if (!validClaimTimeoutMinutes(timeoutMinutes)) {
    return { ok: false, error: "Claim timeout must be a whole number from 1 to 10080 minutes." };
  }

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };
  await db()
    .update(workspace)
    .set({ claimTimeoutMinutes: timeoutMinutes })
    .where(eq(workspace.id, ws.id));
  revalidatePath("/board");
  revalidatePath("/settings");
  return { ok: true };
}
