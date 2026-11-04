import { isReleaseVersion } from "@agent-board/mcp-core";
import {
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  NO_MISSION,
  TASK_PRIORITIES,
  TASK_TYPES,
  isBoardPeriod,
  isBoardPeriodField,
  projectsInOrganizations,
  type BoardFilter,
} from "./board-filter";
import type { BoardQuery } from "./board-tasks";

/**
 * The bridge between the board's filter and the server's query. The filter
 * comes from the browser, so nothing in it is trusted: the scope is read
 * against the projects the reader sees, the mission against the missions
 * they see, and every other value against what the board knows. A value
 * that does not fit narrows to nothing; it never widens to "all".
 */

const MAX_IDS = 500;

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, MAX_IDS);
}

/**
 * The projects the bar's scope puts on the board, among the ones the reader
 * sees. A project the reader does not see is not there to pick: asked for
 * alone it leaves the board empty, never the reader's every project.
 */
export function boardScopeProjectIds(
  projects: readonly { id: string; organizationId: string }[],
  filter: Pick<BoardFilter, "organizationIds" | "projectIds">,
): string[] {
  const organizationIds = ids(filter.organizationIds);
  const projectIds = ids(filter.projectIds);
  const inOrganizations = projectsInOrganizations([...projects], organizationIds);
  // An organization the reader does not see narrows to nothing as well.
  if (organizationIds.length > 0 && inOrganizations.length === 0) return [];
  if (projectIds.length === 0) return inOrganizations.map((item) => item.id);
  const asked = new Set(projectIds);
  return inOrganizations.filter((item) => asked.has(item.id)).map((item) => item.id);
}

/**
 * The query for a filter. `missions` is the set of missions the reader sees:
 * a mission outside it reads as one that holds none of their cards.
 */
export function boardQueryFromFilter(
  filter: Partial<BoardFilter> | null | undefined,
  missions: ReadonlySet<string>,
  personUserId: string | null,
  now: Date = new Date(),
): BoardQuery & { missionId: string | null } {
  const input = filter ?? {};
  const missionId =
    input.missionId === NO_MISSION
      ? NO_MISSION
      : typeof input.missionId === "string"
        ? input.missionId
        : null;
  const resolvedIn =
    input.resolvedIn === null
      ? null
      : typeof input.resolvedIn === "string" && isReleaseVersion(input.resolvedIn)
        ? input.resolvedIn
        : undefined;
  return {
    now,
    period: isBoardPeriod(input.period) ? input.period : DEFAULT_BOARD_PERIOD,
    periodBy: isBoardPeriodField(input.periodBy) ? input.periodBy : DEFAULT_BOARD_PERIOD_FIELD,
    personUserId,
    // A mission the reader may not see holds nothing for them.
    missionId:
      missionId === null || missionId === NO_MISSION || missions.has(missionId)
        ? missionId
        : UNSEEN_MISSION,
    types: TASK_TYPES.filter((value) => ids(input.types).includes(value)),
    priorities: TASK_PRIORITIES.filter((value) => ids(input.priorities).includes(value)),
    ...(resolvedIn !== undefined ? { resolvedIn } : {}),
  };
}

/** No card has this mission: the nil uuid stands for a mission the reader may not see. */
const UNSEEN_MISSION = "00000000-0000-0000-0000-000000000000";

/**
 * What a set of columns answers, as one string: the browser compares it to
 * tell whether the columns a refresh brings are the ones it holds.
 */
export function boardQueryKey(projectIds: readonly string[], query: BoardQuery): string {
  return JSON.stringify([
    [...projectIds].sort(),
    query.period ?? DEFAULT_BOARD_PERIOD,
    query.periodBy ?? DEFAULT_BOARD_PERIOD_FIELD,
    query.personUserId ?? null,
    query.missionId ?? null,
    [...(query.types ?? [])],
    [...(query.priorities ?? [])],
    query.resolvedIn === undefined ? "*" : query.resolvedIn,
  ]);
}
