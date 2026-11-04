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
  type BoardPeriod,
  type BoardPeriodField,
} from "../lib/board-filter";
import { EMPTY_BOARD_TOTALS, type BoardTotals } from "../lib/board-totals";
import { loadBoardTotals } from "../lib/board-totals-query";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { loadModelPrices } from "../lib/prices";
import {
  loadVisiblePeople,
  PERSON_ALL,
  PERSON_ME,
  resolvePersonChoice,
} from "../lib/person-filter";
import { looksLikeUuid } from "../mcp/map";
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
 * The period the board's filter line picked (E4 review h-ipv, item 5): only
 * the period and its date are written. The line never writes the scope — the
 * global bar does, with setBoardScopeAction — so a link's scope is not made
 * the reader's own by a click on a type, a priority or a mission.
 */
export async function setBoardPeriodAction(input: {
  period: BoardPeriod;
  periodBy: BoardPeriodField;
}): Promise<ActionResult> {
  const who = await reader();
  if (!who) return { ok: false, error: "Not signed in." };
  if (!isBoardPeriod(input?.period)) return { ok: false, error: "Period not found." };
  if (!isBoardPeriodField(input?.periodBy)) {
    return { ok: false, error: "Period date not found." };
  }
  await db()
    .update(user)
    .set({ boardPeriod: input.period, boardPeriodBy: input.periodBy })
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
 * The person picked in the global bar (person-filter.ts), remembered beside
 * the scope and the period. `all` clears it; `me` is stored as the word, so it
 * stays the reader whoever they are; any other id must be a person the reader
 * can see on a card, and anything else is "not found", one answer for all.
 */
export async function setBoardPersonAction(choice: string): Promise<ActionResult> {
  const who = await reader();
  if (!who) return { ok: false, error: "Not signed in." };
  const notFound = { ok: false as const, error: "Person not found." };
  if (typeof choice !== "string") return notFound;
  let stored: string | null;
  if (choice === PERSON_ALL) stored = null;
  else if (choice === PERSON_ME || choice === who.userId) stored = PERSON_ME;
  else {
    const ws = await db().query.workspace.findFirst({ columns: { id: true } });
    if (!ws) return notFound;
    const people = looksLikeUuid(choice)
      ? await loadVisiblePeople(db(), ws.id, who.principal)
      : [];
    const resolved = resolvePersonChoice(choice, who.principal, people);
    if (resolved.userId !== choice) return notFound;
    stored = choice;
  }
  await db().update(user).set({ boardPerson: stored }).where(eq(user.id, who.userId));
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
