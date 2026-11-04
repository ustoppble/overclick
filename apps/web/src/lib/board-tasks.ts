import { executionAttempt, handoff, mission, project, task, type Database } from "@agent-board/db";
import { and, asc, desc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  periodDays,
  type BoardPeriod,
  type BoardPeriodField,
} from "./board-filter";
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
