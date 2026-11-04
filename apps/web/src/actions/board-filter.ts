"use server";

import { and, eq, inArray } from "drizzle-orm";
import { organization, project, user } from "@agent-board/db";
import {
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  encodeOrganizationSelection,
  encodeProjectSelection,
  isBoardPeriod,
  isBoardPeriodField,
  type BoardFilter,
} from "../lib/board-filter";
import { EMPTY_BOARD_TOTALS, type BoardTotals } from "../lib/board-totals";
import { loadBoardTotals } from "../lib/board-totals-query";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { loadModelPrices } from "../lib/prices";
import { organizationScope, projectScope } from "../lib/scope";
import { sessionPrincipal } from "../lib/web-scope";

type Reader = { userId: string; principal: NonNullable<Awaited<ReturnType<typeof sessionPrincipal>>> };

async function reader(): Promise<Reader | null> {
  const session = await getSession();
  if (!session) return null;
  const principal = await sessionPrincipal(session);
  if (!principal) return null;
  return { userId: session.userId, principal };
}

/** The organizations and projects asked for, if the reader may see every one of them. */
async function checkScope(
  principal: Reader["principal"],
  input: { organizationIds: string[]; projectIds: string[] },
): Promise<{ ok: true; organizationIds: string[]; projectIds: string[] } | { ok: false; error: string }> {
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
  return { ok: true, organizationIds, projectIds };
}

/**
 * What the board remembers of a filter (navigation plan E4, F2): the scope
 * and the period, and nothing else. The mission, the facets and the release
 * live in the URL only; their columns stay on the user, unread and unwritten,
 * until the card that drops them.
 */
export async function setBoardFilterAction(
  input: BoardFilter,
): Promise<ActionResult> {
  const who = await reader();
  if (!who) return { ok: false, error: "Not signed in." };

  const scope = await checkScope(who.principal, input);
  if (!scope.ok) return scope;
  if (input.period !== undefined && !isBoardPeriod(input.period)) {
    return { ok: false, error: "Period not found." };
  }
  if (input.periodBy !== undefined && !isBoardPeriodField(input.periodBy)) {
    return { ok: false, error: "Period date not found." };
  }

  await db()
    .update(user)
    .set({
      // One column per dimension, same shape: "all", or the ids joined.
      boardOrganizationId: encodeOrganizationSelection(scope.organizationIds),
      // One column holds the whole selection: "all", or the ids joined.
      boardProjectId: encodeProjectSelection(scope.projectIds),
      boardPeriod: input.period ?? DEFAULT_BOARD_PERIOD,
      boardPeriodBy: input.periodBy ?? DEFAULT_BOARD_PERIOD_FIELD,
    })
    .where(eq(user.id, who.userId));

  return { ok: true };
}

/**
 * The scope picked in the global bar (E4): only the organization/project
 * pair is written, so a page that is not the board (Missões, Consumo) never
 * touches the remembered period.
 */
export async function setBoardScopeAction(input: {
  organizationIds: string[];
  projectIds: string[];
}): Promise<ActionResult> {
  const who = await reader();
  if (!who) return { ok: false, error: "Not signed in." };
  const scope = await checkScope(who.principal, input);
  if (!scope.ok) return scope;
  await db()
    .update(user)
    .set({
      boardOrganizationId: encodeOrganizationSelection(scope.organizationIds),
      boardProjectId: encodeProjectSelection(scope.projectIds),
    })
    .where(eq(user.id, who.userId));
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
