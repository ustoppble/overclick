import { asc, eq } from "drizzle-orm";
import { mission, organization, project } from "@agent-board/db";
import type { Database, ModelPrice } from "@agent-board/db";
import { filterBoardCards, type BoardFilter } from "./board-filter";
import { toBoardTotals, type BoardTotals } from "./board-totals";
import {
  computeInsights,
  filterMissionAttempts,
  loadInsightAttemptRows,
  loadMissionAttemptRows,
  type InsightAttemptRow,
  type MissionAttemptInsightRow,
} from "./insights";

export type OrganizationProject = {
  id: string;
  name: string;
  idPrefix: string;
};

export type OrganizationMission = {
  id: string;
  title: string;
};

export type OrganizationOverview = {
  id: string;
  name: string;
  hasContext: boolean;
  projects: OrganizationProject[];
  /** Only the missions still running: a business is read by what is open. */
  activeMissions: OrganizationMission[];
  totals: BoardTotals;
};

type OverviewDb = Pick<Database, "select">;

/**
 * One section per organization: its projects, the missions still active in it,
 * and what the work under it consumed.
 *
 * The telemetry is not computed here. It is the Insights aggregation, run over
 * the same attempt rows, narrowed by the same board filter shape the topbar
 * total uses — a business is just "every project of this organization". A
 * second arithmetic written for this page would be a second answer to the same
 * question, and the two would drift on the first counter anyone adds.
 */
export async function loadOrganizationOverviews(
  db: OverviewDb,
  workspaceId: string,
  pricingEnabled: boolean,
  prices: readonly ModelPrice[],
): Promise<OrganizationOverview[]> {
  const [organizations, projects, missions, attemptRows, missionAttemptRows] =
    await Promise.all([
      db
        .select({
          id: organization.id,
          name: organization.name,
          context: organization.context,
        })
        .from(organization)
        .where(eq(organization.workspaceId, workspaceId))
        .orderBy(asc(organization.name)),
      db
        .select({
          id: project.id,
          name: project.name,
          idPrefix: project.idPrefix,
          organizationId: project.organizationId,
        })
        .from(project)
        .where(eq(project.workspaceId, workspaceId))
        .orderBy(asc(project.createdAt)),
      db
        .select({
          id: mission.id,
          title: mission.title,
          status: mission.status,
          organizationId: mission.organizationId,
        })
        .from(mission)
        .where(eq(mission.workspaceId, workspaceId))
        .orderBy(asc(mission.createdAt)),
      loadInsightAttemptRows(db, workspaceId),
      loadMissionAttemptRows(db, workspaceId),
    ]);

  return organizations.map((org) =>
    toOverview(org, projects, missions, attemptRows, missionAttemptRows, {
      pricingEnabled,
      prices,
    }),
  );
}

/**
 * The board filter that means "only this business". Named here because it is
 * what makes this page's numbers the board's numbers: the same filter, applied
 * by the same code, over the same rows.
 */
export function organizationScope(organizationId: string): BoardFilter {
  return {
    organizationIds: [organizationId],
    projectIds: [],
    missionId: null,
    types: [],
    priorities: [],
  };
}

/**
 * What one business consumed. It narrows with the board's own filter and runs
 * the Insights aggregation, which is exactly what `loadBoardTotals` does for
 * the topbar, so the two cannot report different numbers for one organization.
 */
export function organizationTotals(
  organizationId: string,
  attemptRows: InsightAttemptRow[],
  missionAttemptRows: MissionAttemptInsightRow[],
  money: { pricingEnabled: boolean; prices: readonly ModelPrice[] },
): BoardTotals {
  const filter = organizationScope(organizationId);
  const insights = computeInsights(
    filterBoardCards(attemptRows, filter),
    [],
    money.prices,
    filterMissionAttempts(missionAttemptRows, filter),
  );
  return toBoardTotals(insights.totals, money.pricingEnabled);
}

function toOverview(
  org: { id: string; name: string; context: string | null },
  projects: {
    id: string;
    name: string;
    idPrefix: string;
    organizationId: string;
  }[],
  missions: {
    id: string;
    title: string;
    status: string;
    organizationId: string;
  }[],
  attemptRows: InsightAttemptRow[],
  missionAttemptRows: MissionAttemptInsightRow[],
  money: { pricingEnabled: boolean; prices: readonly ModelPrice[] },
): OrganizationOverview {
  return {
    id: org.id,
    name: org.name,
    hasContext: Boolean(org.context?.trim()),
    projects: projects
      .filter((row) => row.organizationId === org.id)
      .map((row) => ({ id: row.id, name: row.name, idPrefix: row.idPrefix })),
    activeMissions: missions
      .filter((row) => row.organizationId === org.id && row.status === "ativa")
      .map((row) => ({ id: row.id, title: row.title })),
    totals: organizationTotals(
      org.id,
      attemptRows,
      missionAttemptRows,
      money,
    ),
  };
}
