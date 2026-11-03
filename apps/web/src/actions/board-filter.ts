"use server";

import { and, eq, inArray } from "drizzle-orm";
import { mission, organization, project, task, user } from "@agent-board/db";
import { isReleaseVersion } from "@agent-board/mcp-core";
import {
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  NO_MISSION,
  encodeFacetSelection,
  encodeOrganizationSelection,
  encodeProjectSelection,
  encodeReleaseSelection,
  isBoardPeriod,
  isBoardPeriodField,
  isTaskPriority,
  isTaskType,
  type BoardFilter,
} from "../lib/board-filter";
import { EMPTY_BOARD_TOTALS, type BoardTotals } from "../lib/board-totals";
import { loadBoardTotals } from "../lib/board-totals-query";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { loadModelPrices } from "../lib/prices";
import {
  missionScope,
  organizationScope,
  projectScope,
  taskScope,
} from "../lib/scope";
import { sessionPrincipal } from "../lib/web-scope";

export async function setBoardFilterAction(
  input: BoardFilter,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Not signed in." };
  const principal = await sessionPrincipal(session);
  if (!principal) return { ok: false, error: "Not signed in." };

  const organizationIds = [...new Set(input.organizationIds)];
  if (organizationIds.length > 0) {
    const found = await db()
      .select({ id: organization.id })
      .from(organization)
      .where(and(inArray(organization.id, organizationIds), organizationScope(principal)));
    if (found.length !== organizationIds.length) {
      return { ok: false, error: "Organization not found." };
    }
  }

  const projectIds = [...new Set(input.projectIds)];
  if (projectIds.length > 0) {
    const found = await db()
      .select({ id: project.id })
      .from(project)
      .where(and(inArray(project.id, projectIds), projectScope(principal)));
    if (found.length !== projectIds.length) {
      return { ok: false, error: "Project not found." };
    }
  }

  if (input.missionId && input.missionId !== NO_MISSION) {
    const [miss] = await db()
      .select({ id: mission.id })
      .from(mission)
      .where(and(eq(mission.id, input.missionId), missionScope(principal)))
      .limit(1);
    if (!miss) return { ok: false, error: "Mission not found." };
  }

  if (!input.types.every(isTaskType)) {
    return { ok: false, error: "Task type not found." };
  }
  if (!input.priorities.every(isTaskPriority)) {
    return { ok: false, error: "Task priority not found." };
  }
  if (input.period !== undefined && !isBoardPeriod(input.period)) {
    return { ok: false, error: "Period not found." };
  }
  if (input.periodBy !== undefined && !isBoardPeriodField(input.periodBy)) {
    return { ok: false, error: "Period date not found." };
  }
  if (typeof input.resolvedIn === "string") {
    // The filter offers releases only, so only a release can be stored as
    // one — a branch name in resolved_in is not a selection (OCL-128).
    if (!isReleaseVersion(input.resolvedIn)) {
      return { ok: false, error: "Release not found." };
    }
    const ws = await db().query.workspace.findFirst({ columns: { id: true } });
    if (!ws) return { ok: false, error: "Workspace not found." };
    const [release] = await db()
      .select({ value: task.resolvedIn })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .where(
        and(
          eq(project.workspaceId, ws.id),
          eq(task.resolvedIn, input.resolvedIn),
          projectScope(principal),
          taskScope(principal),
        ),
      )
      .limit(1);
    if (!release) return { ok: false, error: "Release not found." };
  }

  await db()
    .update(user)
    .set({
      // One column per dimension, same shape: "all", or the ids joined.
      boardOrganizationId: encodeOrganizationSelection(organizationIds),
      // One column holds the whole selection: "all", or the ids joined.
      boardProjectId: encodeProjectSelection(projectIds),
      boardMissionId: input.missionId,
      boardTaskTypes: encodeFacetSelection([...new Set(input.types)]),
      boardPriorities: encodeFacetSelection([...new Set(input.priorities)]),
      boardResolvedIn: encodeReleaseSelection(input.resolvedIn),
      boardPeriod: input.period ?? DEFAULT_BOARD_PERIOD,
      boardPeriodBy: input.periodBy ?? DEFAULT_BOARD_PERIOD_FIELD,
    })
    .where(eq(user.id, session.userId));

  return { ok: true };
}

/**
 * What the current filter consumed, for the topbar total. It runs the same
 * aggregation the Insights page runs, over the same rows, so the number on the
 * board is the number Insights reports for that filter and not a second
 * arithmetic that drifts from it.
 */
export async function boardTotalsAction(
  input: BoardFilter,
): Promise<BoardTotals> {
  const session = await getSession();
  if (!session) return EMPTY_BOARD_TOTALS;

  const principal = await sessionPrincipal(session);
  if (!principal) return EMPTY_BOARD_TOTALS;

  const ws = await db().query.workspace.findFirst();
  if (!ws) return EMPTY_BOARD_TOTALS;

  const prices = ws.pricingEnabled ? await loadModelPrices(db(), ws.id) : [];
  return loadBoardTotals(
    db(),
    ws.id,
    ws.pricingEnabled,
    prices,
    input,
    principal,
  );
}
