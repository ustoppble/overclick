import {
  executionAttempt,
  mission,
  project,
  task,
  type Database,
  type ModelPrice,
} from "@agent-board/db";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { runRecord } from "./board-card";
import { loadMissionBoardTasks, type BoardTaskRow } from "./board-tasks";
import { toBoardTotals, type BoardTotals } from "./board-totals";
import { computeInsights, loadInsightAttemptRows, loadMissionAttemptRows } from "./insights";
import { missionScope, projectScope, taskScope, type MaybePrincipal } from "./scope";

export type MissionStatusTotals = {
  total: number;
  aberto: number;
  em_execucao: number;
  feito: number;
  validado: number;
  descartado: number;
};

export type MissionRun = { cli: string | null; model: string | null; effort: string | null };

export type MissionPageData = {
  mission: {
    id: string;
    title: string;
    status: "ativa" | "pausada" | "concluida";
    objective: string;
    context: string;
  };
  counts: MissionStatusTotals;
  /** The mission's cards in every project the reader sees. */
  rows: BoardTaskRow[];
  /** The projects those cards belong to, by name. */
  projects: { id: string; name: string }[];
  /** What ran on them: one entry per distinct record, in the order first seen. */
  ran: MissionRun[];
};

export type MissionListItem = {
  id: string;
  title: string;
  status: "ativa" | "pausada" | "concluida";
  objective: string;
  updatedAt: Date;
  counts: MissionStatusTotals;
  projectNames: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emptyCounts(): MissionStatusTotals {
  return { total: 0, aberto: 0, em_execucao: 0, feito: 0, validado: 0, descartado: 0 };
}

async function visibleProjectIds(
  database: Database,
  workspaceId: string,
  principal: MaybePrincipal,
): Promise<string[]> {
  const rows = await database
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.workspaceId, workspaceId), projectScope(principal)));
  return rows.map((row) => row.id);
}

/**
 * The page of one mission (navigation plan E3, F5). It ignores the board's
 * project scope: the progress, the cards and what ran are the whole mission's,
 * across every project the reader sees. A mission the reader may not see (a
 * member's view of someone else's) is null, the same as one that does not
 * exist, and so is an id that is not one.
 */
export async function loadMissionPage(
  database: Database,
  workspaceId: string,
  principal: MaybePrincipal,
  missionId: string,
): Promise<MissionPageData | null> {
  if (!UUID.test(missionId)) return null;
  const found = await database.query.mission.findFirst({
    where: and(
      eq(mission.id, missionId),
      eq(mission.workspaceId, workspaceId),
      missionScope(principal),
    ),
    columns: { id: true, title: true, status: true, objective: true, context: true },
  });
  if (!found) return null;

  const projectIds = await visibleProjectIds(database, workspaceId, principal);
  const rows = await loadMissionBoardTasks(database, projectIds, principal, found.id);

  const counts = emptyCounts();
  const projects = new Map<string, string>();
  for (const row of rows) {
    counts[row.status] += 1;
    counts.total += 1;
    projects.set(row.projectId, row.project.name);
  }

  const attempts =
    rows.length === 0
      ? []
      : await database
          .select({
            executor: executionAttempt.executor,
            model: executionAttempt.model,
            modelSource: executionAttempt.modelSource,
          })
          .from(executionAttempt)
          .where(
            inArray(
              executionAttempt.taskId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(asc(executionAttempt.startedAt));
  const ran = new Map<string, MissionRun>();
  for (const attempt of attempts) {
    const record = runRecord(attempt);
    if (!record.model && !record.cli) continue;
    const key = `${record.cli}\u0000${record.model}\u0000${record.effort}`;
    if (!ran.has(key)) ran.set(key, record);
  }

  return {
    mission: found,
    counts,
    rows,
    projects: [...projects].map(([id, name]) => ({ id, name })),
    ran: [...ran.values()],
  };
}

/**
 * The missions the reader may see (navigation plan E3), the most recently
 * changed first, each with its cards by status and the projects they are in.
 * A member sees the missions they created, and only their own cards in them.
 */
export async function loadMissionList(
  database: Database,
  workspaceId: string,
  principal: MaybePrincipal,
): Promise<MissionListItem[]> {
  const missions = await database.query.mission.findMany({
    where: and(eq(mission.workspaceId, workspaceId), missionScope(principal)),
    orderBy: desc(mission.updatedAt),
    columns: { id: true, title: true, status: true, objective: true, updatedAt: true },
  });
  if (missions.length === 0) return [];

  const projectIds = await visibleProjectIds(database, workspaceId, principal);
  const counted =
    projectIds.length === 0
      ? []
      : await database
          .select({
            missionId: task.missionId,
            status: task.status,
            projectName: project.name,
            n: count(),
          })
          .from(task)
          .innerJoin(project, eq(task.projectId, project.id))
          .where(
            and(
              inArray(
                task.missionId,
                missions.map((item) => item.id),
              ),
              inArray(task.projectId, projectIds),
              taskScope(principal),
            ),
          )
          .groupBy(task.missionId, task.status, project.name);

  const counts = new Map<string, MissionStatusTotals>();
  const names = new Map<string, Set<string>>();
  for (const row of counted) {
    if (!row.missionId) continue;
    const entry = counts.get(row.missionId) ?? emptyCounts();
    const n = Number(row.n);
    entry[row.status] += n;
    entry.total += n;
    counts.set(row.missionId, entry);
    const set = names.get(row.missionId) ?? new Set<string>();
    set.add(row.projectName);
    names.set(row.missionId, set);
  }

  return missions.map((item) => ({
    ...item,
    counts: counts.get(item.id) ?? emptyCounts(),
    projectNames: [...(names.get(item.id) ?? [])].sort((a, b) => a.localeCompare(b)),
  }));
}

/**
 * What each mission consumed, by mission id: the Usage page's own aggregation
 * (computeInsights) over the reader's attempts, so the list and Usage report
 * the same numbers for a mission.
 */
export async function loadMissionUsage(
  database: Database,
  workspaceId: string,
  pricingEnabled: boolean,
  prices: readonly ModelPrice[],
  principal: MaybePrincipal,
): Promise<Map<string, BoardTotals>> {
  const [rows, missionAttemptRows] = await Promise.all([
    loadInsightAttemptRows(database, workspaceId, principal),
    loadMissionAttemptRows(database, workspaceId, principal),
  ]);
  const insights = computeInsights(rows, [], prices, missionAttemptRows);
  return new Map(
    // Card attempts and mission attempts together, as the board's total adds them.
    insights.combinedGroups.byMission.map((group) => [
      group.key,
      toBoardTotals(group.total, pricingEnabled),
    ]),
  );
}
