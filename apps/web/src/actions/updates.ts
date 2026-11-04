"use server";

import { workspace, type UpdateMode } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { ADMIN_ONLY, sessionCanManageWorkspace } from "../lib/web-scope";
import { db } from "../lib/db";

const MODES: readonly UpdateMode[] = ["off", "check", "auto"];

/**
 * Persists what this instance may do about new releases. `off` is the default
 * and the only mode that makes no outbound request at all.
 */
export async function saveUpdateModeAction(
  mode: UpdateMode,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (!(await sessionCanManageWorkspace(session))) return { ok: false, error: ADMIN_ONLY };
  if (!MODES.includes(mode)) return { ok: false, error: "Unknown update mode." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  await db()
    .update(workspace)
    .set({ updateMode: mode })
    .where(eq(workspace.id, ws.id));
  revalidatePath("/board");
  revalidatePath("/settings");
  return { ok: true };
}
