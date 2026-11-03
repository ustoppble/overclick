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
  DEFAULT_BOARD_PERIOD,
  NO_MISSION,
  periodDays,
  projectsInOrganizations,
  type BoardFilter,
  type BoardPeriod,
} from "./board-filter";
import {
  COLUMN_STATUSES,
  type ColumnCounts,
  type ColumnStatus,
} from "./board-columns";
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
 * How far back the board reaches without being asked, by a card's last
 * activity (updated_at), for the periods that name no days: all time keeps
 * live work (open and running) whatever its age and the finished columns
 * (done, validated, discarded) only from this many days. Done is among the
 * finished ones because in production it is where cards pile up unreviewed
 * (2.672 of 3.580, none touched in 30 days), and a window that always carried
 * them was 97% of the board.
 */
export const BOARD_WINDOW_DAYS = 7;
export { BOARD_PAGE_SIZE };

export const LIVE_STATUSES = ["aberto", "em_execucao"] as const;

/** Any column can be paged: with a period, the cards past it come the same way. */
export function isColumnStatus(value: string): value is ColumnStatus {
  return (COLUMN_STATUSES as readonly string[]).includes(value);
}

/**
 * Where the window starts: the period back from now, or for all time the
 * week the finished columns keep.
 */
export function boardWindowStart(
  now: Date,
  period: BoardPeriod = DEFAULT_BOARD_PERIOD,
): Date {
  const days = periodDays(period) ?? BOARD_WINDOW_DAYS;
  return new Date(now.getTime() - days * 86_400_000);
}

export type { OlderCursor, ColumnStatus };

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
 * The board's cards with everything the card line and detail panel read: the
 * ones that changed inside the period, whatever their column. All time is the
 * v0.4.2 window: every live card, and the finished ones from the last week.
 */
export async function loadBoardTasks(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  options: { now?: Date; period?: BoardPeriod } = {},
) {
  if (projectIds.length === 0) return [];
  const period = options.period ?? DEFAULT_BOARD_PERIOD;
  const since = boardWindowStart(options.now ?? new Date(), period);
  return queryBoardTasks(
    database,
    principal,
    and(
      inArray(task.projectId, projectIds),
      period === "all"
        ? or(inArray(task.status, [...LIVE_STATUSES]), gte(task.updatedAt, since))
        : gte(task.updatedAt, since),
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
    status: ColumnStatus;
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

export type BoardColumnCounts = {
  /** Each column inside the period; for all time, the whole column. */
  counts: ColumnCounts;
  /** Each column past the period: what "show older" has to give. Zero for all time. */
  older: ColumnCounts;
};

function emptyCounts(): ColumnCounts {
  return { aberto: 0, em_execucao: 0, feito: 0, validado: 0, descartado: 0 };
}

/**
 * How many cards each column holds under the filter, loaded or not: the
 * number on a column head is the column inside the period, not what this tab
 * fetched of it, and what lies past the period is counted apart so the head
 * can say so.
 */
export async function countBoardColumns(
  database: Database,
  projects: BoardProject[],
  principal: MaybePrincipal,
  filter: BoardFilter,
  options: { now?: Date } = {},
): Promise<BoardColumnCounts> {
  const result: BoardColumnCounts = { counts: emptyCounts(), older: emptyCounts() };
  const inFilter = boardFilterWhere(projects, filter, principal);
  if (!inFilter) return result;
  const period = filter.period ?? DEFAULT_BOARD_PERIOD;
  const since = boardWindowStart(options.now ?? new Date(), period);
  const rows = await database
    .select({
      status: task.status,
      n: count(),
      recent: sql<number>`count(*) filter (where ${task.updatedAt} >= ${since.toISOString()}::timestamptz)`,
    })
    .from(task)
    .where(and(inFilter, taskScope(principal)))
    .groupBy(task.status);
  for (const row of rows) {
    if (!isColumnStatus(row.status)) continue;
    const total = Number(row.n);
    if (period === "all") {
      result.counts[row.status] = total;
    } else {
      result.counts[row.status] = Number(row.recent);
      result.older[row.status] = total - Number(row.recent);
    }
  }
  return result;
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
