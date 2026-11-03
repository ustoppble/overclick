"use server";

import { and, eq } from "drizzle-orm";
import { project, workspace } from "@agent-board/db";
import type { BoardCard } from "../app/home/board";
import { toBoardCards } from "../lib/board-card";
import type { BoardFilter } from "../lib/board-filter";
import type { ColumnCounts } from "../lib/board-columns";
import {
  countBoardColumns,
  isArchivedStatus,
  loadBoardTasksByIds,
  loadOlderBoardTasks,
  searchBoardTaskIds,
  type OlderCursor,
} from "../lib/board-tasks";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { dict } from "../lib/i18n";
import { loadUsageRecipes } from "../lib/recipes";
import { projectScope, type Principal } from "../lib/scope";
import { sessionPrincipal } from "../lib/web-scope";

/**
 * The cards the board's window leaves out, fetched on demand: a page of older
 * finished cards per column, the hits of a search, and the real size of each
 * column. Every one of them reads through the same scope as the page itself,
 * so a member gets their own cards here and nothing else.
 */

type BoardReader = {
  principal: Principal;
  session: { userId: string };
  ws: typeof workspace.$inferSelect;
  projects: { id: string; organizationId: string }[];
};

async function boardReader(): Promise<BoardReader | null> {
  const session = await getSession();
  if (!session) return null;
  const principal = await sessionPrincipal(session);
  if (!principal) return null;
  const ws = await db().query.workspace.findFirst();
  if (!ws) return null;
  const projects = await db()
    .select({ id: project.id, organizationId: project.organizationId })
    .from(project)
    .where(and(eq(project.workspaceId, ws.id), projectScope(principal)));
  return { principal, session, ws, projects };
}

async function asCards(
  reader: BoardReader,
  rows: Parameters<typeof toBoardCards>[0],
): Promise<BoardCard[]> {
  if (rows.length === 0) return [];
  return toBoardCards(rows, {
    tr: dict(reader.ws.language),
    pricingEnabled: reader.ws.pricingEnabled,
    recipes: await loadUsageRecipes(db(), reader.ws.id),
    viewerId: reader.session.userId,
    claimTimeoutMinutes: reader.ws.claimTimeoutMinutes,
  });
}

/** One "show older" click on a validated or discarded column. */
export async function loadOlderBoardCardsAction(input: {
  status: string;
  filter: BoardFilter;
  before: OlderCursor | null;
}): Promise<{ cards: BoardCard[]; hasMore: boolean }> {
  const reader = await boardReader();
  if (!reader || !isArchivedStatus(input.status)) {
    return { cards: [], hasMore: false };
  }
  const page = await loadOlderBoardTasks(db(), reader.projects, reader.principal, {
    status: input.status,
    filter: input.filter,
    before: input.before,
  });
  return { cards: await asCards(reader, page.tasks), hasMore: page.hasMore };
}

/**
 * The board search on the server: what task_search finds for the reader,
 * as board cards, so a card the window left out still answers its words.
 */
export async function searchBoardCardsAction(
  query: string,
): Promise<{ query: string; cards: BoardCard[] }> {
  const reader = await boardReader();
  if (!reader || !query.trim()) return { query, cards: [] };
  const ids = await searchBoardTaskIds(db(), reader.ws.id, reader.principal, query);
  const rows = await loadBoardTasksByIds(
    db(),
    reader.projects.map((item) => item.id),
    reader.principal,
    ids,
  );
  return { query, cards: await asCards(reader, rows) };
}

/** How many cards each column holds under a filter the client just picked. */
export async function boardColumnCountsAction(
  filter: BoardFilter,
): Promise<ColumnCounts | null> {
  const reader = await boardReader();
  if (!reader) return null;
  return countBoardColumns(db(), reader.projects, reader.principal, filter);
}
