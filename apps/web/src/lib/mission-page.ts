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
import {
  computeInsights,
  filterMissionAttempts,
  loadInsightAttemptRows,
  loadMissionAttemptRows,
} from "./insights";
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
 * A member sees the missions they created or that hold a card of a project
 * linked to them, and only the cards of their linked projects in them.
 */
export async function loadMissionList(
  database: Database,
  workspaceId: string,
  principal: MaybePrincipal,
  /**
   * The scope of the global bar (E4). Empty is every organization or every
   * project. A mission belongs to an organization; under a project scope it
   * shows when it holds cards in those projects, counted there, or when it
   * holds none yet, since it is where the next card of the organization goes.
   */
  scope: { organizationIds: string[]; projectIds: string[] } = { organizationIds: [], projectIds: [] },
): Promise<MissionListItem[]> {
  const inOrganizations = await database.query.mission.findMany({
    where: and(
      eq(mission.workspaceId, workspaceId),
      missionScope(principal),
      scope.organizationIds.length > 0
        ? inArray(mission.organizationId, scope.organizationIds)
        : undefined,
    ),
    orderBy: desc(mission.updatedAt),
    columns: { id: true, title: true, status: true, objective: true, updatedAt: true },
  });
  if (inOrganizations.length === 0) return [];

  const visible = await visibleProjectIds(database, workspaceId, principal);
  const projectIds =
    scope.projectIds.length > 0 ? visible.filter((id) => scope.projectIds.includes(id)) : visible;
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
                inOrganizations.map((item) => item.id),
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

  // Under a project scope, a mission whose cards all sit elsewhere leaves.
  const missions =
    scope.projectIds.length === 0
      ? inOrganizations
      : await missionsWithoutCardsElsewhere(database, inOrganizations, counts, principal);
  return missions.map((item) => ({
    ...item,
    counts: counts.get(item.id) ?? emptyCounts(),
    projectNames: [...(names.get(item.id) ?? [])].sort((a, b) => a.localeCompare(b)),
  }));
}

/** The missions with cards in scope, plus the ones the reader sees no card of at all. */
async function missionsWithoutCardsElsewhere<T extends { id: string }>(
  database: Database,
  missions: T[],
  inScope: Map<string, MissionStatusTotals>,
  principal: MaybePrincipal,
): Promise<T[]> {
  const rest = missions.filter((item) => !inScope.has(item.id)).map((item) => item.id);
  if (rest.length === 0) return missions;
  const elsewhere = await database
    .selectDistinct({ missionId: task.missionId })
    .from(task)
    .where(and(inArray(task.missionId, rest), taskScope(principal)));
  const taken = new Set(elsewhere.map((row) => row.missionId));
  return missions.filter((item) => inScope.has(item.id) || !taken.has(item.id));
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
  /**
   * The scope of the global bar (E4 review h-ipv, item 2): the list counts a
   * mission's cards in these projects, so its usage reads the same ones.
   * Empty is every organization or every project.
   */
  scope: { organizationIds: string[]; projectIds: string[] } = { organizationIds: [], projectIds: [] },
): Promise<Map<string, BoardTotals>> {
  const [allRows, allMissionAttemptRows] = await Promise.all([
    loadInsightAttemptRows(database, workspaceId, principal),
    loadMissionAttemptRows(database, workspaceId, principal),
  ]);
  const rows = allRows.filter(
    (row) =>
      (scope.organizationIds.length === 0 || scope.organizationIds.includes(row.organizationId)) &&
      (scope.projectIds.length === 0 || scope.projectIds.includes(row.projectId)),
  );
  // Orchestration follows the rule Usage applies to it: under a project scope
  // only the mission work that ran against one of those projects counts.
  const missionAttemptRows = filterMissionAttempts(allMissionAttemptRows, {
    organizationIds: scope.organizationIds,
    projectIds: scope.projectIds,
    missionId: null,
  });
  const insights = computeInsights(rows, [], prices, missionAttemptRows);
  return new Map(
    // Card attempts and mission attempts together, as the board's total adds them.
    insights.combinedGroups.byMission.map((group) => [
      group.key,
      toBoardTotals(group.total, pricingEnabled),
    ]),
  );
}
