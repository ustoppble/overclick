"use server";

import {
  project,
  task,
  validClaimTimeoutMinutes,
  workspace,
} from "@agent-board/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { invokeTool } from "../mcp/tools";

/** Human release from the card detail, using the same atomic path as MCP. */
export async function releaseClaimAction(taskId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const [found] = await db()
    .select({ workspaceId: project.workspaceId })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .where(eq(task.id, taskId))
    .limit(1);
  if (!found) return { ok: false, error: "Card not found." };

  const released = await invokeTool(
    db(),
    {
      // A signed-in human is the manage authority for this local workspace.
      // The id is only compared in task_release; it is never stored as a token.
      tokenId: session.userId,
      workspaceId: found.workspaceId,
      tokenLabel: session.email,
      canManage: true,
    },
    "task_release",
    { task_id: taskId, reason: "released by a signed-in human from the board" },
  );
  if (!released.ok) return { ok: false, error: released.error.message };

  revalidatePath("/home");
  return { ok: true };
}

/** Persists the workspace lease used by stale-claim recovery. */
export async function saveClaimTimeoutAction(
  timeoutMinutes: number,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (!validClaimTimeoutMinutes(timeoutMinutes)) {
    return { ok: false, error: "Claim timeout must be a whole number from 1 to 10080 minutes." };
  }

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };
  await db()
    .update(workspace)
    .set({ claimTimeoutMinutes: timeoutMinutes })
    .where(eq(workspace.id, ws.id));
  revalidatePath("/home");
  revalidatePath("/settings");
  return { ok: true };
}
