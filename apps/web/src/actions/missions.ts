"use server";

import { mission, organization, project, task, workspace } from "@agent-board/db";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { MAX_BULK_CARDS } from "../lib/bulk";
import { looksLikeUuid } from "../mcp/map";
import { planMissionAssignment, planMissionRestore } from "../lib/mission-assign";
import { missionScope, taskScope, type Principal } from "../lib/scope";
import { sessionPrincipal } from "../lib/web-scope";

type MissionStatus = "ativa" | "pausada" | "concluida";

const MISSION_STATUSES = new Set<MissionStatus>([
  "ativa",
  "pausada",
  "concluida",
]);

async function boardWorkspaceId(): Promise<string | null> {
  const [row] = await db()
    .select({ id: workspace.id })
    .from(workspace)
    .limit(1);
  return row?.id ?? null;
}

function cleanMissionTitle(value: string): string | null {
  const title = value.trim();
  return title.length >= 1 && title.length <= 200 ? title : null;
}

/**
 * The organization a new mission is filed under: the one asked for when the
 * caller knows it, the only one when the instance has a single business, and
 * otherwise the oldest — a board that never split has exactly one answer, and
 * one that did gets the mission moved with mission_update rather than guessed
 * at from a form that never asked.
 */
async function resolveMissionOrganization(
  workspaceId: string,
  requested: string | null | undefined,
  principal: Principal,
): Promise<string | null> {
  // A member files missions only in their own organization, whatever the form
  // asked for.
  if (principal.role !== "admin") return principal.organizationId;
  if (requested) {
    const [found] = await db()
      .select({ id: organization.id })
      .from(organization)
      .where(
        and(
          eq(organization.id, requested),
          eq(organization.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (found) return found.id;
  }
  const [first] = await db()
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.workspaceId, workspaceId))
    .orderBy(asc(organization.createdAt))
    .limit(1);
  return first?.id ?? null;
}

export async function createMissionAction(input: {
  title: string;
  objective: string;
  context: string;
  /** The business the board was filtered to when the mission was created. */
  organizationId?: string | null;
}): Promise<
  | { ok: true; mission: { id: string } }
  | { ok: false; error: string }
> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const principal = await sessionPrincipal(session);
  if (!principal) return { ok: false, error: "Session expired. Sign in again." };
  const workspaceId = await boardWorkspaceId();
  if (!workspaceId) return { ok: false, error: "Workspace not found." };
  const title = cleanMissionTitle(input.title);
  if (!title) {
    return { ok: false, error: "Mission title must be 1 to 200 characters." };
  }

  // A mission belongs to a business like a project does. The board creates it
  // where the work already is: the only organization when there is one, and
  // otherwise the one the current board filter is pointing at.
  const organizationId = await resolveMissionOrganization(
    workspaceId,
    input.organizationId,
    principal,
  );
  if (!organizationId) {
    return { ok: false, error: "No organization to create the mission in." };
  }

  const [created] = await db()
    .insert(mission)
    .values({
      workspaceId,
      organizationId,
      title,
      objective: input.objective.trim(),
      context: input.context.trim(),
      status: "ativa",
      createdByUserId: session.userId,
    })
    .returning({ id: mission.id });
  if (!created) return { ok: false, error: "Could not create the mission." };

  revalidatePath("/board");
  return { ok: true, mission: created };
}

export async function updateMissionAction(input: {
  missionId: string;
  title: string;
  objective: string;
  context: string;
  status: MissionStatus;
}): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const principal = await sessionPrincipal(session);
  if (!principal) return { ok: false, error: "Session expired. Sign in again." };
  const workspaceId = await boardWorkspaceId();
  if (!workspaceId) return { ok: false, error: "Workspace not found." };
  const title = cleanMissionTitle(input.title);
  if (!title) {
    return { ok: false, error: "Mission title must be 1 to 200 characters." };
  }
  if (!MISSION_STATUSES.has(input.status)) {
    return { ok: false, error: "Mission status is invalid." };
  }

  const [updated] = await db()
    .update(mission)
    .set({
      title,
      objective: input.objective.trim(),
      context: input.context.trim(),
      status: input.status,
    })
    .where(
      and(
        eq(mission.id, input.missionId),
        eq(mission.workspaceId, workspaceId),
        missionScope(principal),
      ),
    )
    .returning({ id: mission.id });
  if (!updated) return { ok: false, error: "Mission not found." };

  revalidatePath("/board");
  return { ok: true };
}

export async function deleteEmptyMissionAction(
  missionId: string,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const principal = await sessionPrincipal(session);
  if (!principal) return { ok: false, error: "Session expired. Sign in again." };
  const workspaceId = await boardWorkspaceId();
  if (!workspaceId) return { ok: false, error: "Workspace not found." };

  const database = db();
  return database.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: mission.id })
      .from(mission)
      .where(
        and(
          eq(mission.id, missionId),
          eq(mission.workspaceId, workspaceId),
          missionScope(principal),
        ),
      )
      .limit(1);
    if (!current) return { ok: false, error: "Mission not found." } as const;

    // Only the cards the user may see count (OCL-227): an admin's card in a
    // member's mission is not the member's to know about. A mission that is
    // empty to them is deleted, and any such card is left with no mission.
    const [cards] = await tx
      .select({ n: count() })
      .from(task)
      .where(and(eq(task.missionId, current.id), taskScope(principal)));
    const taskCount = Number(cards?.n ?? 0);
    if (taskCount > 0) {
      return {
        ok: false,
        error: `This mission still holds ${taskCount} card${taskCount === 1 ? "" : "s"}. Move them before deleting it.`,
      } as const;
    }

    await tx.update(task).set({ missionId: null }).where(eq(task.missionId, current.id));
    await tx.delete(mission).where(eq(mission.id, current.id));
    revalidatePath("/board");
    return { ok: true } as const;
  });
}

/** Where a card was before a move: what the undo sends it back to. */
export type CardMissionBefore = { taskId: string; missionId: string | null };

/**
 * Moves cards between missions from the board: one card from its detail
 * panel, or a whole selection from the selection bar. `missionId: null`
 * detaches. The same rule the MCP `task_update` follows applies here, so a
 * human and an agent can never leave the board in states the other one cannot
 * produce. Every id is checked against the caller's scope on the server; one
 * out of reach refuses the whole move.
 *
 * The answer carries where each card was — read here, not taken from the
 * client — so "N cards movidos · Desfazer" can put every one of them back
 * (navigation plan E6).
 */
export async function assignCardsToMissionAction(
  taskIds: string[],
  missionId: string | null,
): Promise<
  | { ok: true; previous: CardMissionBefore[] }
  | { ok: false; error: string }
> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const principal = await sessionPrincipal(session);
  if (!principal) return { ok: false, error: "Session expired. Sign in again." };

  const requested = [...new Set(taskIds.filter((id) => id.trim()))];
  if (requested.length > MAX_BULK_CARDS) {
    return { ok: false, error: `Select at most ${MAX_BULK_CARDS} cards at a time.` };
  }
  // A non-uuid matches no card (Postgres would refuse it in the comparison);
  // the plan answers it as not found, like any other unknown id.
  const uuidIds = requested.filter(looksLikeUuid);
  const rows =
    uuidIds.length === 0
      ? []
      : await db()
          .select({
            id: task.id,
            workspaceId: project.workspaceId,
            missionId: task.missionId,
          })
          .from(task)
          .innerJoin(project, eq(task.projectId, project.id))
          .where(
            and(inArray(task.id, uuidIds), taskScope(principal)),
          );

  const target = missionId
    ? !looksLikeUuid(missionId)
      ? ("missing" as const)
      : ((
        await db()
          .select({ id: mission.id, workspaceId: mission.workspaceId })
          .from(mission)
          .where(and(eq(mission.id, missionId), missionScope(principal)))
          .limit(1)
      )[0] ?? ("missing" as const))
    : null;

  const plan = planMissionAssignment({
    requestedIds: requested,
    cards: rows,
    mission: target,
  });
  if (!plan.ok) return { ok: false, error: plan.error };

  // Subtasks were created inside the parent's mission; they follow it out
  // too, so the undo has to know where they were as well.
  const children = await db()
    .select({ id: task.id, missionId: task.missionId })
    .from(task)
    .where(and(inArray(task.parentId, plan.taskIds), taskScope(principal)));
  const previous = new Map<string, string | null>();
  for (const row of [...rows, ...children]) {
    if (!previous.has(row.id)) previous.set(row.id, row.missionId);
  }

  await db()
    .update(task)
    .set({ missionId: plan.missionId })
    .where(inArray(task.id, plan.taskIds));
  if (children.length > 0) {
    await db()
      .update(task)
      .set({ missionId: plan.missionId })
      .where(inArray(task.id, children.map((row) => row.id)));
  }

  revalidatePath("/board");
  return {
    ok: true,
    previous: [...previous].map(([taskId, before]) => ({ taskId, missionId: before })),
  };
}

/**
 * The bulk move's Desfazer (navigation plan E6): each card back to the
 * mission it had, "Sem missão" included. The list comes from the client, so
 * nothing in it is trusted: every card and every mission is checked against
 * the caller's scope again, exactly as a move would be.
 */
export async function restoreCardMissionsAction(
  moves: CardMissionBefore[],
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const principal = await sessionPrincipal(session);
  if (!principal) return { ok: false, error: "Session expired. Sign in again." };
  if (!Array.isArray(moves) || moves.length > MAX_BULK_CARDS * 2) {
    return { ok: false, error: "Nothing to undo." };
  }

  const clean = moves.filter(
    (move): move is CardMissionBefore =>
      typeof move?.taskId === "string" &&
      (move.missionId === null || typeof move.missionId === "string"),
  );
  if (clean.length !== moves.length) return { ok: false, error: "Nothing to undo." };
  // Postgres refuses a non-uuid in a uuid comparison; such an id is simply
  // one that matches nothing, and the plan answers it as not found.
  const taskIds = [...new Set(clean.map((move) => move.taskId))].filter(looksLikeUuid);
  const missionIds = [
    ...new Set(clean.flatMap((move) => (move.missionId ? [move.missionId] : []))),
  ].filter(looksLikeUuid);

  const cards =
    taskIds.length === 0
      ? []
      : await db()
          .select({ id: task.id, workspaceId: project.workspaceId })
          .from(task)
          .innerJoin(project, eq(task.projectId, project.id))
          .where(and(inArray(task.id, taskIds), taskScope(principal)));
  const missions =
    missionIds.length === 0
      ? []
      : await db()
          .select({ id: mission.id, workspaceId: mission.workspaceId })
          .from(mission)
          .where(and(inArray(mission.id, missionIds), missionScope(principal)));

  const plan = planMissionRestore({
    moves: clean,
    cards,
    missions: new Map(missions.map((row) => [row.id, { workspaceId: row.workspaceId }])),
  });
  if (!plan.ok) return { ok: false, error: plan.error };

  await db().transaction(async (tx) => {
    for (const group of plan.groups) {
      await tx
        .update(task)
        .set({ missionId: group.missionId })
        .where(inArray(task.id, group.taskIds));
    }
  });

  revalidatePath("/board");
  return { ok: true };
}
