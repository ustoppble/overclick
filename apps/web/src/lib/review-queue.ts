import {
  handoff,
  organization,
  project,
  task,
  user,
  type Database,
} from "@agent-board/db";
import { and, asc, count, eq, inArray, max, sql } from "drizzle-orm";
import { parseComoConfirmo } from "../mcp/map";
import { resolveBoardFilter } from "./board-filter";
import {
  organizationScope,
  projectScope,
  taskScope,
  type MaybePrincipal,
} from "./scope";

/**
 * What waits for a person, counted the one way the whole app counts it (the
 * F1 contract of the navigation plan): by scope and by role, and by nothing
 * else. The board's period, type, priority, mission and search narrow what
 * its columns show; they never hide a delivery that is waiting for review. A
 * card delivered a month ago is still waiting, and the "N to review" chip
 * says so whatever the board happens to be showing.
 */

export type ReviewScope = {
  workspaceId: string;
  /** Empty means every organization the reader may see. */
  organizationIds: string[];
  /** Empty means every project the reader may see. */
  projectIds: string[];
};

export type ReviewScopeLabel = {
  /** The organization's name when the scope is one organization. */
  organization: string | null;
  /** The project's name when the scope is one project. */
  project: string | null;
};

export type TaskStatusCounts = {
  aberto: number;
  em_execucao: number;
  feito: number;
  validado: number;
  descartado: number;
};

const NO_COUNTS: TaskStatusCounts = {
  aberto: 0,
  em_execucao: 0,
  feito: 0,
  validado: 0,
  descartado: 0,
};

function inScope(principal: MaybePrincipal, scope: ReviewScope) {
  return and(
    eq(project.workspaceId, scope.workspaceId),
    projectScope(principal),
    taskScope(principal),
    scope.organizationIds.length > 0
      ? inArray(project.organizationId, scope.organizationIds)
      : undefined,
    scope.projectIds.length > 0 ? inArray(task.projectId, scope.projectIds) : undefined,
  );
}

/** Cards per status inside the scope, as this reader may see them. */
export async function countCardsByStatus(
  database: Database,
  principal: MaybePrincipal,
  scope: ReviewScope,
): Promise<TaskStatusCounts> {
  if (!principal) return { ...NO_COUNTS };
  const rows = await database
    .select({ status: task.status, n: count() })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .where(inScope(principal, scope))
    .groupBy(task.status);
  const counts = { ...NO_COUNTS };
  for (const row of rows) counts[row.status] = Number(row.n);
  return counts;
}

export type ReviewQueueEntry = {
  id: string;
  shortId: string;
  /** The card's latest delivery, ISO. */
  deliveredAt: string;
  /** How-to-confirm steps ticked, of all of them. */
  checks: { done: number; total: number };
};

/**
 * The cards waiting for review, the one delivered longest ago first. A card
 * returned and delivered again is ordered by its latest delivery, so it goes
 * to the end of the line, behind what was waiting while it was being redone.
 * A card in review with no delivery on record (moved there by hand before
 * handoffs existed) is ordered by its last change.
 */
export async function loadReviewQueue(
  database: Database,
  principal: MaybePrincipal,
  scope: ReviewScope,
): Promise<ReviewQueueEntry[]> {
  if (!principal) return [];
  const delivered = sql<Date>`coalesce(${max(handoff.createdAt)}, ${task.updatedAt})`;
  const rows = await database
    .select({
      id: task.id,
      shortId: task.shortId,
      deliveredAt: delivered,
      comoConfirmo: task.comoConfirmo,
      ticks: task.validationTicks,
    })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .leftJoin(handoff, eq(handoff.taskId, task.id))
    .where(and(eq(task.status, "feito"), inScope(principal, scope)))
    // Grouped by the key: every other column of the card follows from it.
    .groupBy(task.id)
    .orderBy(asc(delivered), asc(task.shortId));
  return rows.map((row) => {
    const total = parseComoConfirmo(row.comoConfirmo).length;
    const done = new Set(row.ticks.map((tick) => tick.index).filter((i) => i < total)).size;
    return {
      id: row.id,
      shortId: row.shortId,
      deliveredAt: new Date(row.deliveredAt).toISOString(),
      checks: { done, total },
    };
  });
}

export { nextInQueue } from "./review-queue-order";

/**
 * The scope the reader left on the board: the organization/project pair they
 * last chose, read back the way the board reads it. Only the pair: the
 * facets, the mission and the period are the board's own narrowing.
 */
export async function readReviewScope(
  database: Database,
  workspaceId: string,
  principal: MaybePrincipal,
): Promise<ReviewScope & { label: ReviewScopeLabel }> {
  const empty = {
    workspaceId,
    organizationIds: [],
    projectIds: [],
    label: { organization: null, project: null },
  };
  if (!principal) return empty;
  const [me] = await database
    .select({
      organizationId: user.boardOrganizationId,
      projectId: user.boardProjectId,
    })
    .from(user)
    .where(eq(user.id, principal.userId))
    .limit(1);
  const projects = await database
    .select({ id: project.id, name: project.name, organizationId: project.organizationId })
    .from(project)
    .where(and(eq(project.workspaceId, workspaceId), projectScope(principal)))
    .orderBy(asc(project.createdAt));
  const organizations = await database
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(and(eq(organization.workspaceId, workspaceId), organizationScope(principal)))
    .orderBy(asc(organization.name));
  const filter = resolveBoardFilter(
    {
      organizationId: me?.organizationId ?? null,
      projectId: me?.projectId ?? null,
      missionId: null,
      types: null,
      priorities: null,
      resolvedIn: null,
      period: null,
      periodBy: null,
    },
    projects,
    [],
    undefined,
    organizations,
  );
  const oneOrganization =
    filter.organizationIds.length === 1
      ? filter.organizationIds[0]
      : principal.role === "member"
        ? principal.organizationId
        : null;
  return {
    workspaceId,
    organizationIds: filter.organizationIds,
    projectIds: filter.projectIds,
    label: {
      organization: organizations.find((item) => item.id === oneOrganization)?.name ?? null,
      project:
        filter.projectIds.length === 1
          ? (projects.find((item) => item.id === filter.projectIds[0])?.name ?? null)
          : null,
    },
  };
}
