import { project, task, type Database } from "@agent-board/db";
import { and, asc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  periodDays,
  type BoardPeriod,
  type BoardPeriodField,
} from "./board-filter";
import {
  canSeeMission,
  canSeeTask,
  projectScope,
  taskScope,
  type MaybePrincipal,
} from "./scope";
import { invokeTool } from "../mcp/tools";

/**
 * Where the window starts: the period back from now. Null for all time, which
 * has no start: every card of every column.
 */
export function boardWindowStart(
  now: Date,
  period: BoardPeriod = DEFAULT_BOARD_PERIOD,
): Date | null {
  const days = periodDays(period);
  return days === null ? null : new Date(now.getTime() - days * 86_400_000);
}

/**
 * The cards themselves are filtered by scope in the query. What they point at
 * is filtered here (OCL-227): an admin can put a member's card in one of their
 * missions, or continue it in a card of theirs, and the member's card would
 * otherwise carry that mission's title or that card's id and short id along
 * with it. A reference the reader may not see reads as no reference at all.
 */
async function queryBoardTasks(
  database: Database,
  principal: MaybePrincipal,
  where: SQL | undefined,
  options: { limit?: number } = {},
) {
  const rows = await database.query.task.findMany({
    where: and(where, taskScope(principal)),
    orderBy: asc(task.createdAt),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    with: {
      mission: { columns: { id: true, title: true, createdByUserId: true } },
      project: { columns: { name: true, repoUrl: true, organizationId: true } },
      createdBy: { columns: { email: true } },
      reviewer: { columns: { email: true } },
      attempts: true,
      handoffs: true,
      comments: true,
      supersedes: { columns: { id: true, shortId: true, createdByUserId: true } },
      supersededBy: { columns: { id: true, shortId: true, createdByUserId: true } },
    },
  });
  return rows.map((row) => {
    const mission = row.mission && canSeeMission(principal, row.mission) ? row.mission : null;
    const supersedes =
      row.supersedes && canSeeTask(principal, row.supersedes) ? row.supersedes : null;
    const supersededBy =
      row.supersededBy && canSeeTask(principal, row.supersededBy) ? row.supersededBy : null;
    return {
      ...row,
      mission,
      missionId: mission ? row.missionId : null,
      supersedes,
      supersedesId: supersedes ? row.supersedesId : null,
      supersededBy,
      supersededById: supersededBy ? row.supersededById : null,
    };
  });
}

export type BoardTaskRow = Awaited<ReturnType<typeof queryBoardTasks>>[number];

/**
 * The board's cards with everything the card line and detail panel read: the
 * ones inside the period, whatever their column, by the date the reader picked
 * (last activity unless they asked for the creation date). All time is every
 * card. Nothing else decides what a column holds; the search reaches past it.
 */
export async function loadBoardTasks(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  options: { now?: Date; period?: BoardPeriod; periodBy?: BoardPeriodField } = {},
) {
  if (projectIds.length === 0) return [];
  const since = boardWindowStart(options.now ?? new Date(), options.period);
  const column =
    (options.periodBy ?? DEFAULT_BOARD_PERIOD_FIELD) === "created"
      ? task.createdAt
      : task.updatedAt;
  return queryBoardTasks(
    database,
    principal,
    and(
      inArray(task.projectId, projectIds),
      since ? gte(column, since) : undefined,
    ),
  );
}

/** Cards by id, for the ones a search or a link brings in from outside the window. */
export async function loadBoardTasksByIds(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  ids: string[],
) {
  if (projectIds.length === 0 || ids.length === 0) return [];
  return queryBoardTasks(
    database,
    principal,
    and(inArray(task.projectId, projectIds), inArray(task.id, ids)),
  );
}

/**
 * One card by the short id a link carries, also when it moved project and the
 * link still has the old one. Null for anything the reader may not see.
 */
export async function findBoardTaskByShortId(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  shortId: string,
) {
  const wanted = shortId.trim().toUpperCase();
  if (projectIds.length === 0 || !wanted) return null;
  // The card that owns the short id now comes first; a card that only had it
  // once answers an old link when nobody owns it.
  for (const match of [
    sql`upper(${task.shortId}) = ${wanted}`,
    sql`${task.previousShortIds} @> ${JSON.stringify([wanted])}::jsonb`,
  ]) {
    const [row] = await queryBoardTasks(
      database,
      principal,
      and(inArray(task.projectId, projectIds), match),
      { limit: 1 },
    );
    if (row) return row;
  }
  return null;
}

/** A query that reads as a card's short id ("OCL-12"), not as words. */
const SHORT_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * The board's search on the server, so it reaches the cards the window left
 * out. It is task_search itself, run as the signed-in person, so ranking and
 * scope are the ones an agent gets; a short id is also looked up directly,
 * since the full-text search reads titles and bodies, not ids.
 */
export async function searchBoardTaskIds(
  database: Database,
  workspaceId: string,
  principal: MaybePrincipal,
  query: string,
): Promise<string[]> {
  const q = query.trim();
  if (!principal || !q) return [];
  const ids: string[] = [];
  if (SHORT_ID.test(q)) {
    const [row] = await database
      .select({ id: task.id })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .where(
        and(
          eq(project.workspaceId, workspaceId),
          projectScope(principal),
          taskScope(principal),
          or(
            sql`upper(${task.shortId}) = ${q.toUpperCase()}`,
            sql`${task.previousShortIds} @> ${JSON.stringify([q.toUpperCase()])}::jsonb`,
          ),
        ),
      )
      .limit(1);
    if (row) ids.push(row.id);
  }
  const found = await invokeTool(
    database,
    {
      tokenId: principal.userId,
      workspaceId,
      tokenLabel: "board-search",
      userId: principal.userId,
      role: principal.role,
      organizationId: principal.organizationId,
      canManage: false,
    },
    "task_search",
    { q, limit: 20, include: ["ids"] },
  );
  if (found.ok) {
    const value = found.value as { tasks: { id?: string }[] };
    for (const hit of value.tasks) {
      if (hit.id && !ids.includes(hit.id)) ids.push(hit.id);
    }
  }
  return ids;
}
