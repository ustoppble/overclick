import {
  executionAttempt,
  handoff,
  mission,
  project,
  task,
  type Database,
  type TaskPriority,
  type TaskType,
} from "@agent-board/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  NO_MISSION,
  periodDays,
  type BoardPeriod,
  type BoardPeriodField,
} from "./board-filter";
import { COLUMN_STATUSES, type ColumnCounts, type ColumnStatus } from "./board-columns";
import { personCondition } from "./person-filter";
import {
  isAdmin,
  missionScope,
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
 * missions, or continue it in a card of a project the member is not linked to,
 * and the member's card would otherwise carry that mission's title or that
 * card's id and short id along with it. A reference the reader may not see
 * reads as no reference at all. Null means the reader sees every reference.
 */
type VisibleReferences = { missions: Set<string>; tasks: Set<string> } | null;

type ReferencingRow = {
  missionId: string | null;
  supersedesId: string | null;
  supersededById: string | null;
};

/** Which of the rows' missions and continuation cards the reader may see, by the scope in SQL. */
async function visibleReferences(
  database: Database,
  principal: MaybePrincipal,
  rows: ReferencingRow[],
): Promise<VisibleReferences> {
  if (isAdmin(principal)) return null;
  const missionIds = [...new Set(rows.flatMap((row) => (row.missionId ? [row.missionId] : [])))];
  const taskIds = [
    ...new Set(rows.flatMap((row) => [row.supersedesId, row.supersededById].filter((id): id is string => Boolean(id)))),
  ];
  const [missions, tasks] = await Promise.all([
    missionIds.length === 0
      ? []
      : database
          .select({ id: mission.id })
          .from(mission)
          .where(and(inArray(mission.id, missionIds), missionScope(principal))),
    taskIds.length === 0
      ? []
      : database
          .select({ id: task.id })
          .from(task)
          .where(and(inArray(task.id, taskIds), taskScope(principal))),
  ]);
  return {
    missions: new Set(missions.map((row) => row.id)),
    tasks: new Set(tasks.map((row) => row.id)),
  };
}

function withVisibleReferences<
  Row extends ReferencingRow & {
    mission: { id: string; title: string; createdByUserId: string | null } | null;
    supersedes: { id: string; shortId: string; createdByUserId: string | null } | null;
    supersededBy: { id: string; shortId: string; createdByUserId: string | null } | null;
  },
>(visible: VisibleReferences, row: Row) {
  const sees = (set: "missions" | "tasks", id: string) => visible === null || visible[set].has(id);
  const mission = row.mission && sees("missions", row.mission.id) ? row.mission : null;
  const supersedes =
    row.supersedes && sees("tasks", row.supersedes.id) ? row.supersedes : null;
  const supersededBy =
    row.supersededBy && sees("tasks", row.supersededBy.id) ? row.supersededBy : null;
  return {
    ...row,
    mission,
    missionId: mission ? row.missionId : null,
    supersedes,
    supersedesId: supersedes ? row.supersedesId : null,
    supersededBy,
    supersededById: supersededBy ? row.supersededById : null,
  };
}

const CARD_REFERENCES = {
  mission: { columns: { id: true, title: true, createdByUserId: true } },
  project: { columns: { name: true, repoUrl: true, organizationId: true } },
  createdBy: { columns: { email: true } },
  reviewer: { columns: { email: true } },
  supersedes: { columns: { id: true, shortId: true, createdByUserId: true } },
  supersededBy: { columns: { id: true, shortId: true, createdByUserId: true } },
} as const;

/**
 * The board's list: each card with only what its line draws. Handoffs,
 * comments and attempts stay in the database; the query hands over the
 * newest attempt's numbers, the newest handoff's usage and the CLIs that ever
 * ran the card, and the rest comes when the card is opened
 * (loadBoardTaskDetail). On "all time" that is the difference between a few
 * hundred bytes a card and every evidence, comment and transcript ever written.
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
    // The contract is the card's body: the panel reads it, the line does not.
    columns: { oQue: false, porQue: false, comoConfirmo: false, validationTicks: false },
    extras: {
      // Every executor that ever claimed the card, raw; the CLI is read from
      // each one in board-card, as it always was. The inner table is spelled
      // out: the relational query would qualify its columns with "task".
      attemptExecutors: sql<string[] | null>`(select json_agg(distinct ea.executor) from execution_attempt ea where ea.task_id = ${task.id} and ea.executor is not null)`.as(
        "attempt_executors",
      ),
    },
    with: {
      ...CARD_REFERENCES,
      attempts: {
        columns: {
          executor: true,
          model: true,
          modelSource: true,
          startedAt: true,
          lastActivityAt: true,
          tokensIn: true,
          tokensOut: true,
          tokensCache: true,
          usageSegments: true,
          usageEstimated: true,
          usageSuspect: true,
          costUsd: true,
          costSource: true,
          costStatus: true,
          costUnpricedModels: true,
          durationMs: true,
          serverDurationMs: true,
          turns: true,
        },
        orderBy: desc(executionAttempt.startedAt),
        limit: 1,
      },
      handoffs: {
        columns: { usage: true },
        orderBy: desc(handoff.createdAt),
        limit: 1,
      },
    },
  });
  const visible = await visibleReferences(database, principal, rows);
  return rows.map(({ attempts, handoffs, attemptExecutors, ...row }) => ({
    ...withVisibleReferences(visible, row),
    latestAttempt: attempts[0] ?? null,
    latestHandoffUsage: handoffs[0]?.usage ?? null,
    attemptExecutors: attemptExecutors ?? [],
  }));
}

export type BoardTaskRow = Awaited<ReturnType<typeof queryBoardTasks>>[number];

/**
 * One card with everything its detail panel reads: the contract, every
 * attempt and comment, and the handoffs without their evidences and
 * artifacts, which the board never shows. Scoped like the list: a card the
 * reader may not see, or that is not in their projects, is null.
 */
export async function loadBoardTaskDetail(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  id: string,
) {
  if (projectIds.length === 0) return null;
  const row = await database.query.task.findFirst({
    where: and(eq(task.id, id), inArray(task.projectId, projectIds), taskScope(principal)),
    with: {
      ...CARD_REFERENCES,
      attempts: true,
      handoffs: { columns: { evidences: false, artifacts: false } },
      comments: true,
    },
  });
  if (!row) return null;
  return withVisibleReferences(await visibleReferences(database, principal, [row]), row);
}

export type BoardTaskDetailRow = NonNullable<Awaited<ReturnType<typeof loadBoardTaskDetail>>>;

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
  options: {
    now?: Date;
    period?: BoardPeriod;
    periodBy?: BoardPeriodField;
    /** Only the cards linked to this person (person-filter.ts); null is everyone. */
    personUserId?: string | null;
  } = {},
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
      options.personUserId ? personCondition(options.personUserId) : undefined,
    ),
  );
}

/**
 * How many cards a column hands over at a time: its newest, and the next ones
 * when the reader scrolls it to its end. Enough to fill a tall screen twice,
 * so the next page is on its way long before the column runs out.
 */
export const BOARD_COLUMN_PAGE = 40;

/** What the board shows, read on the server: the bar's scope, the person, the period and the filters. */
export type BoardQuery = {
  now?: Date;
  period?: BoardPeriod;
  periodBy?: BoardPeriodField;
  /** Only the cards linked to this person (person-filter.ts); null is everyone. */
  personUserId?: string | null;
  /** A mission's id, NO_MISSION for the loose cards, null for any. */
  missionId?: string | null;
  types?: readonly TaskType[];
  priorities?: readonly TaskPriority[];
  /** Undefined is every release; null only the cards without one. */
  resolvedIn?: string | null;
};

/**
 * Where the next page of a column starts: the last card handed over, by the
 * exact date the column is ordered on (as the database writes it, so no
 * precision is lost on the way) and its id, which breaks the ties.
 */
export type BoardCursor = { at: string; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

export function encodeBoardCursor(cursor: BoardCursor): string {
  return `${cursor.at}|${cursor.id}`;
}

/** Null for anything that is not a cursor this board wrote. */
export function decodeBoardCursor(value: unknown): BoardCursor | null {
  if (typeof value !== "string" || value.length > 100) return null;
  const [at, id, ...rest] = value.split("|");
  if (rest.length > 0 || !at || !id || !TIMESTAMP.test(at) || !UUID.test(id)) return null;
  return { at, id };
}

/** The date a column is ordered on: the one the period reads. */
function boardSortColumn(periodBy: BoardPeriodField | undefined) {
  return (periodBy ?? DEFAULT_BOARD_PERIOD_FIELD) === "created" ? task.createdAt : task.updatedAt;
}

/**
 * The cards the board may show for a query, in SQL: the reader's scope
 * (taskScope), the projects of the bar, the period and every filter. `omit`
 * leaves one filter out, for the counts that answer "what would picking this
 * show": the mission menu does not read the mission, the release menu the
 * release.
 */
function boardCondition(
  projectIds: string[],
  principal: MaybePrincipal,
  query: BoardQuery,
  omit: { mission?: boolean; release?: boolean } = {},
): SQL | undefined {
  const since = boardWindowStart(query.now ?? new Date(), query.period);
  const types = query.types ?? [];
  const priorities = query.priorities ?? [];
  return and(
    inArray(task.projectId, projectIds),
    taskScope(principal),
    since ? gte(boardSortColumn(query.periodBy), since) : undefined,
    query.personUserId ? personCondition(query.personUserId) : undefined,
    omit.mission ? undefined : missionCondition(principal, query.missionId ?? null),
    types.length > 0 ? inArray(task.tipo, [...types]) : undefined,
    priorities.length > 0 ? inArray(task.priority, [...priorities]) : undefined,
    omit.release || query.resolvedIn === undefined
      ? undefined
      : query.resolvedIn === null
        ? isNull(task.resolvedIn)
        : eq(task.resolvedIn, query.resolvedIn),
  );
}

/**
 * The mission filter as the card line reads it: a card whose mission the
 * reader may not see carries no mission (OCL-227), so for them it is a loose
 * card, and the loose bucket must find it.
 */
function missionCondition(principal: MaybePrincipal, missionId: string | null): SQL | undefined {
  if (missionId === null) return undefined;
  if (missionId !== NO_MISSION) return eq(task.missionId, missionId);
  const visible = missionScope(principal);
  if (visible === undefined) return isNull(task.missionId);
  return or(
    isNull(task.missionId),
    sql`not exists (select 1 from ${mission} where ${mission.id} = ${task.missionId} and ${visible})`,
  );
}

/**
 * One column's next page of ids, newest first by the period's date, the id
 * breaking ties, so a page starts exactly where the last one ended: nothing
 * twice, nothing skipped, even among cards written in the same instant.
 */
async function boardColumnIds(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  query: BoardQuery,
  status: ColumnStatus,
  after: BoardCursor | null,
  limit: number,
): Promise<{ ids: string[]; next: string | null }> {
  const column = boardSortColumn(query.periodBy);
  const rows = await database
    .select({ id: task.id, at: sql<string>`${column}::text` })
    .from(task)
    .where(
      and(
        boardCondition(projectIds, principal, query),
        eq(task.status, status),
        after
          ? sql`(${column}, ${task.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(column), desc(task.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ids: page.map((row) => row.id),
    next: rows.length > limit && last ? encodeBoardCursor({ at: last.at, id: last.id }) : null,
  };
}

export type BoardColumnRows = { rows: BoardTaskRow[]; next: string | null };

/** The rows of the ids, in the ids' order. */
function inOrder(ids: string[], rows: BoardTaskRow[]): BoardTaskRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * Every column's newest cards: a page each, or as many as `depth` says when
 * the board already holds more of a column (the poll re-reads what is on
 * screen, not just the first page).
 */
export async function loadBoardColumns(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  query: BoardQuery,
  depth: Partial<Record<ColumnStatus, number>> = {},
): Promise<Record<ColumnStatus, BoardColumnRows>> {
  const pages = await Promise.all(
    COLUMN_STATUSES.map((status) =>
      projectIds.length === 0
        ? { ids: [], next: null }
        : boardColumnIds(
            database,
            projectIds,
            principal,
            query,
            status,
            null,
            Math.max(BOARD_COLUMN_PAGE, Math.min(depth[status] ?? 0, BOARD_COLUMN_MAX_DEPTH)),
          ),
    ),
  );
  const ids = pages.flatMap((page) => page.ids);
  const rows =
    ids.length === 0 ? [] : await queryBoardTasks(database, principal, inArray(task.id, ids));
  return Object.fromEntries(
    COLUMN_STATUSES.map((status, index) => {
      const page = pages[index]!;
      return [status, { rows: inOrder(page.ids, rows), next: page.next }];
    }),
  ) as Record<ColumnStatus, BoardColumnRows>;
}

/** The deepest a re-read goes: past it the reader scrolls the rest in again. */
const BOARD_COLUMN_MAX_DEPTH = 2_000;

/** One column's page after a cursor, for the reader scrolling it to its end. */
export async function loadBoardColumnPage(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  query: BoardQuery,
  status: ColumnStatus,
  after: BoardCursor,
): Promise<BoardColumnRows> {
  if (projectIds.length === 0) return { rows: [], next: null };
  const page = await boardColumnIds(
    database,
    projectIds,
    principal,
    query,
    status,
    after,
    BOARD_COLUMN_PAGE,
  );
  if (page.ids.length === 0) return { rows: [], next: null };
  const rows = await queryBoardTasks(database, principal, inArray(task.id, page.ids));
  return { rows: inOrder(page.ids, rows), next: page.next };
}

/**
 * The board's numbers, counted in SQL so they stay exact while the columns
 * hold only their first pages: each column's cards, and what the mission and
 * release menus offer (each counted without its own filter, as picking one
 * would show). A mission the reader may not see counts as loose, as its cards
 * read.
 */
export type BoardCounts = {
  columns: ColumnCounts;
  /** Cards per mission the reader sees. */
  missions: Record<string, number>;
  /** Cards with no mission (or one the reader may not see). */
  loose: number;
  /** Every card the mission menu reads: its "all missions". */
  scope: number;
  /** Cards per release; the empty key is the cards without one. */
  releases: Record<string, number>;
};

export async function loadBoardCounts(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  query: BoardQuery,
): Promise<BoardCounts> {
  const counts: BoardCounts = {
    columns: { aberto: 0, em_execucao: 0, feito: 0, validado: 0, descartado: 0 },
    missions: {},
    loose: 0,
    scope: 0,
    releases: {},
  };
  if (projectIds.length === 0) return counts;
  const [byStatus, byMission, byRelease] = await Promise.all([
    database
      .select({ status: task.status, n: count() })
      .from(task)
      .where(boardCondition(projectIds, principal, query))
      .groupBy(task.status),
    database
      .select({ missionId: task.missionId, n: count() })
      .from(task)
      .where(boardCondition(projectIds, principal, query, { mission: true }))
      .groupBy(task.missionId),
    database
      .select({ resolvedIn: task.resolvedIn, n: count() })
      .from(task)
      .where(boardCondition(projectIds, principal, query, { release: true }))
      .groupBy(task.resolvedIn),
  ]);
  for (const row of byStatus) counts.columns[row.status] += Number(row.n);
  const missionIds = byMission.flatMap((row) => (row.missionId ? [row.missionId] : []));
  const seen = isAdmin(principal) || missionIds.length === 0
    ? null
    : new Set(
        (
          await database
            .select({ id: mission.id })
            .from(mission)
            .where(and(inArray(mission.id, missionIds), missionScope(principal)))
        ).map((row) => row.id),
      );
  for (const row of byMission) {
    const n = Number(row.n);
    counts.scope += n;
    if (row.missionId && (seen === null || seen.has(row.missionId))) {
      counts.missions[row.missionId] = (counts.missions[row.missionId] ?? 0) + n;
    } else {
      counts.loose += n;
    }
  }
  for (const row of byRelease) counts.releases[row.resolvedIn ?? ""] = Number(row.n);
  return counts;
}

/** Cards by id, for the ones a search or a link brings in from outside the window. */
export async function loadBoardTasksByIds(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  ids: string[],
  /** Only the cards linked to this person (the search's hits); null is everyone. */
  personUserId: string | null = null,
) {
  if (projectIds.length === 0 || ids.length === 0) return [];
  return queryBoardTasks(
    database,
    principal,
    and(
      inArray(task.projectId, projectIds),
      inArray(task.id, ids),
      personUserId ? personCondition(personUserId) : undefined,
    ),
  );
}

/**
 * A mission's cards in every project the reader sees (navigation plan E3):
 * the mission's page ignores the board's project scope and its period.
 */
export async function loadMissionBoardTasks(
  database: Database,
  projectIds: string[],
  principal: MaybePrincipal,
  missionId: string,
) {
  if (projectIds.length === 0) return [];
  return queryBoardTasks(
    database,
    principal,
    and(inArray(task.projectId, projectIds), eq(task.missionId, missionId)),
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
