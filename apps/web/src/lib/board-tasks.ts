import { mission, project, task, type Database } from "@agent-board/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  NO_MISSION,
  projectsInOrganizations,
  type BoardFilter,
} from "./board-filter";
import { COLUMN_STATUSES, type ColumnCounts } from "./board-columns";
import { BOARD_PAGE_SIZE, type OlderCursor } from "./board-window";
import {
  canSeeMission,
  canSeeTask,
  isAdmin,
  projectScope,
  taskScope,
  type MaybePrincipal,
} from "./scope";
import { invokeTool } from "../mcp/tools";

/**
 * How far back the board reaches for finished cards on its own. Live work
 * (open, running, done and waiting review) is always on the board, whatever
 * its age: a card that sat open for a month is exactly the one that must not
 * disappear. Validated and discarded cards are history, and the board keeps
 * only the ones that changed this week; the rest come in by column, a page at
 * a time, or through the search.
 */
export const BOARD_WINDOW_DAYS = 7;
export { BOARD_PAGE_SIZE };

export const LIVE_STATUSES = ["aberto", "em_execucao", "feito"] as const;
export const ARCHIVED_STATUSES = ["validado", "descartado"] as const;
export type ArchivedStatus = (typeof ARCHIVED_STATUSES)[number];

export function isArchivedStatus(value: string): value is ArchivedStatus {
  return (ARCHIVED_STATUSES as readonly string[]).includes(value);
}

export function boardWindowStart(now: Date): Date {
  return new Date(now.getTime() - BOARD_WINDOW_DAYS * 86_400_000);
}

export type { OlderCursor };

type BoardProject = { id: string; organizationId: string };

/**
 * The cursor travels as an ISO string, which stops at the millisecond while
 * Postgres keeps microseconds. Paging compares and orders at the cursor's own
 * precision, or a card a few microseconds older than the cursor would be
 * skipped as if it were newer.
 */
const updatedAtMs = sql<Date>`date_trunc('milliseconds', ${task.updatedAt})`;

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
  options: { newestChangeFirst?: boolean; limit?: number } = {},
) {
  const rows = await database.query.task.findMany({
    where: and(where, taskScope(principal)),
    orderBy: options.newestChangeFirst
      ? [desc(updatedAtMs), desc(task.id)]
      : asc(task.createdAt),
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
 * The board's cards with everything the card line and detail panel read:
 * every live card, and the finished ones that changed inside the window.
 */
export async function loadBoardTasks(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  options: { now?: Date } = {},
) {
  if (projectIds.length === 0) return [];
  const since = boardWindowStart(options.now ?? new Date());
  return queryBoardTasks(
    database,
    principal,
    and(
      inArray(task.projectId, projectIds),
      or(inArray(task.status, [...LIVE_STATUSES]), gte(task.updatedAt, since)),
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
  const [row] = await queryBoardTasks(
    database,
    principal,
    and(
      inArray(task.projectId, projectIds),
      or(
        sql`upper(${task.shortId}) = ${wanted}`,
        sql`${task.previousShortIds} @> ${JSON.stringify([wanted])}::jsonb`,
      ),
    ),
    { limit: 1 },
  );
  return row ?? null;
}

/**
 * The board filter as SQL, so a page of older cards and a column count answer
 * the same selection the client applies to the cards it holds
 * (`filterBoardCards`). Null when the selection leaves no project at all.
 */
export function boardFilterWhere(
  projects: BoardProject[],
  filter: BoardFilter,
  principal: MaybePrincipal,
): SQL | null {
  const projectIds = projectsInOrganizations(projects, filter.organizationIds)
    .map((item) => item.id)
    .filter(
      (id) => filter.projectIds.length === 0 || filter.projectIds.includes(id),
    );
  if (projectIds.length === 0) return null;
  const conditions: (SQL | undefined)[] = [inArray(task.projectId, projectIds)];
  if (filter.missionId === NO_MISSION) {
    // A member's card in someone else's mission reads as loose on the board,
    // because the mission is not theirs to see (OCL-227).
    conditions.push(
      isAdmin(principal) || !principal
        ? isNull(task.missionId)
        : or(
            isNull(task.missionId),
            notInArray(task.missionId, missionsAuthoredBy(principal.userId)),
          ),
    );
  } else if (filter.missionId) {
    conditions.push(eq(task.missionId, filter.missionId));
  }
  if (filter.types.length > 0) conditions.push(inArray(task.tipo, filter.types));
  if (filter.priorities.length > 0) {
    conditions.push(inArray(task.priority, filter.priorities));
  }
  if (filter.resolvedIn === null) conditions.push(isNull(task.resolvedIn));
  else if (filter.resolvedIn !== undefined) {
    conditions.push(eq(task.resolvedIn, filter.resolvedIn));
  }
  return and(...conditions) ?? null;
}

/** The ids of the missions a member authored, as a subquery. */
function missionsAuthoredBy(userId: string) {
  return sql`(select ${mission.id} from ${mission} where ${mission.createdByUserId} = ${userId})`;
}

/**
 * A page of the finished cards of one column, newest change first, starting
 * below the cursor: the oldest card of that column the board already holds.
 */
export async function loadOlderBoardTasks(
  database: Database,
  projects: BoardProject[],
  principal: MaybePrincipal,
  input: {
    status: ArchivedStatus;
    filter: BoardFilter;
    before: OlderCursor | null;
    limit?: number;
  },
) {
  const limit = input.limit ?? BOARD_PAGE_SIZE;
  const inFilter = boardFilterWhere(projects, input.filter, principal);
  if (!inFilter) return { tasks: [], hasMore: false };
  const parsed = input.before ? new Date(input.before.updatedAt) : null;
  // Bound as text with a cast: a Date compared to an expression (not to a
  // column) reaches the driver unmapped, and postgres-js refuses it.
  const before =
    parsed && !Number.isNaN(parsed.getTime())
      ? sql`${parsed.toISOString()}::timestamptz`
      : null;
  const rows = await queryBoardTasks(
    database,
    principal,
    and(
      inFilter,
      eq(task.status, input.status),
      before && input.before
        ? or(
            lt(updatedAtMs, before),
            and(eq(updatedAtMs, before), lt(task.id, input.before.id)),
          )
        : undefined,
    ),
    // One more than asked says whether the button stays.
    { newestChangeFirst: true, limit: limit + 1 },
  );
  return { tasks: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * How many cards each column holds under the filter, loaded or not: the
 * number on a column head is the column, not what this tab fetched of it.
 */
export async function countBoardColumns(
  database: Database,
  projects: BoardProject[],
  principal: MaybePrincipal,
  filter: BoardFilter,
): Promise<ColumnCounts> {
  const counts: ColumnCounts = {
    aberto: 0,
    em_execucao: 0,
    feito: 0,
    validado: 0,
    descartado: 0,
  };
  const inFilter = boardFilterWhere(projects, filter, principal);
  if (!inFilter) return counts;
  const rows = await database
    .select({ status: task.status, n: count() })
    .from(task)
    .where(and(inFilter, taskScope(principal)))
    .groupBy(task.status);
  for (const row of rows) {
    if ((COLUMN_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status] = Number(row.n);
    }
  }
  return counts;
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
