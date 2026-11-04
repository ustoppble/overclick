"use server";

import { project, task } from "@agent-board/db";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { MAX_BULK_CARDS } from "../lib/bulk";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { authContextForUser, projectScope, taskScope } from "../lib/scope";
import { CARD_NOT_FOUND, sessionPrincipal, visibleCardWorkspace } from "../lib/web-scope";
import { looksLikeUuid } from "../mcp/map";
import { invokeTool } from "../mcp/tools";
import type { AuthContext } from "../mcp/types";

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

/** A card the batch left where it was, and the reason, as the tool gave it. */
export type KeptCard = { id: string; error: string };

/**
 * Descartar em lote, from the selection bar (navigation plan E6). A loop of the
 * single discard: the same task_update for each card, so the board refuses in
 * a batch exactly what it refuses one at a time, and what an agent would be
 * refused. The reason is required and lands on every card's trail. There is no
 * undo: a discarded card is reopened through the path that already exists.
 *
 * Nothing the client sent is trusted: every id is looked up again under the
 * caller's scope before the tool sees it. Someone else's card, an id that
 * matches nothing and a non-uuid get one answer, so a member learns nothing
 * from the batch about cards that are not theirs. A partial failure says which
 * cards stayed; when none moved, the answer is a refusal that still lists them.
 */
export async function discardCardsAction(
  taskIds: string[],
  reason: string,
): Promise<
  | { ok: true; discarded: string[]; kept: KeptCard[] }
  | { ok: false; error: string; kept?: KeptCard[] }
> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (typeof reason !== "string" || !reason.trim()) {
    return { ok: false, error: "Say why the cards are being discarded." };
  }
  const requested = Array.isArray(taskIds)
    ? [...new Set(taskIds.filter((id) => typeof id === "string" && id.trim()))]
    : [];
  if (requested.length === 0) return { ok: false, error: "Select at least one card." };
  if (requested.length > MAX_BULK_CARDS) {
    return { ok: false, error: `Select at most ${MAX_BULK_CARDS} cards at a time.` };
  }

  const principal = await sessionPrincipal(session);
  if (!principal) return { ok: false, error: "Session expired. Sign in again." };
  const uuidIds = requested.filter(looksLikeUuid);
  const visible =
    uuidIds.length === 0
      ? []
      : await db()
          .select({ id: task.id, workspaceId: project.workspaceId })
          .from(task)
          .innerJoin(project, eq(task.projectId, project.id))
          .where(
            and(inArray(task.id, uuidIds), projectScope(principal), taskScope(principal)),
          );
  const workspaceOf = new Map(visible.map((row) => [row.id, row.workspaceId]));

  const discarded: string[] = [];
  const kept: KeptCard[] = [];
  const acting = new Map<string, AuthContext | null>();
  for (const id of requested) {
    const workspaceId = workspaceOf.get(id);
    if (!workspaceId) {
      kept.push({ id, error: CARD_NOT_FOUND });
      continue;
    }
    if (!acting.has(workspaceId)) {
      acting.set(workspaceId, await authContextForUser(db(), session, workspaceId));
    }
    const ctx = acting.get(workspaceId);
    if (!ctx) return { ok: false, error: "Session expired. Sign in again." };
    const result = await invokeTool(db(), ctx, "task_update", {
      task_id: id,
      status: "descartado",
      comment: reason.trim(),
    });
    if (result.ok) discarded.push(id);
    else {
      kept.push({
        id,
        error: result.error.code === "NOT_FOUND" ? CARD_NOT_FOUND : result.error.message,
      });
    }
  }

  if (discarded.length > 0) revalidatePath("/board");
  if (discarded.length === 0) return { ok: false, error: kept[0]!.error, kept };
  return { ok: true, discarded, kept };
}
