import type { TaskPriority, TaskType } from "@agent-board/db";
import { isReleaseVersion } from "@agent-board/mcp-core";

export const ALL_PROJECTS = "all";
/** Same sentinel on the organization column: every business, spelled out. */
export const ALL_ORGANIZATIONS = "all";
/**
 * The cards nobody put in a mission. A bucket, not a mission: without it a
 * loose card is only ever visible under "all missions", which is the same as
 * being invisible on a board with 44 cards.
 */
export const NO_MISSION = "none";
/** Stored/query sentinel for the cards whose release is still unset. */
export const NO_RELEASE = "__no_release__";

export const TASK_TYPES: readonly TaskType[] = ["bug", "feature", "rfc"];
export const TASK_PRIORITIES: readonly TaskPriority[] = [
  "urgente",
  "alta",
  "media",
  "baixa",
];

export type BoardFilter = {
  /**
   * The businesses on screen. Empty is every organization, which is what an
   * instance that never split into more than one keeps seeing forever.
   */
  organizationIds: string[];
  /**
   * The projects on screen. Empty is the All projects shortcut, which is every
   * project of the workspace: work that spans projects can only be seen
   * together if the filter takes more than one answer.
   */
  projectIds: string[];
  missionId: string | null;
  /** Undefined means every release; null means only cards without a release. */
  resolvedIn?: string | null;
  /** Empty means every task type. */
  types: TaskType[];
  /** Empty means every priority. */
  priorities: TaskPriority[];
};

type StoredBoardFilter = {
  organizationId?: string | null;
  projectId: string | null;
  missionId: string | null;
  types?: string | string[] | null;
  priorities?: string | string[] | null;
  resolvedIn?: string | null;
};

type FilterableCard = {
  /** The organization of the card's project, carried on the row it filters. */
  organizationId: string;
  projectId: string;
  missionId: string | null;
  tipo: TaskType;
  priority: TaskPriority;
  resolvedIn: string | null;
};

export type SearchableBoardCard = FilterableCard & {
  shortId: string;
  title: string;
  oQue: string;
  porQue: string;
  comoConfirmo: readonly { step: string; expected: string }[];
};

export function defaultProjectId(projects: { id: string }[]): string | null {
  return projects[0]?.id ?? null;
}

/**
 * Empty is "all": unlike the project filter, the organization filter has no
 * first-organization default to fall back to.
 */
export function encodeOrganizationSelection(organizationIds: string[]): string {
  return organizationIds.length === 0
    ? ALL_ORGANIZATIONS
    : organizationIds.join(",");
}

/**
 * The selection as one string, which is how it persists per user: "all" for
 * the shortcut, otherwise the project ids in workspace order.
 */
export function encodeProjectSelection(projectIds: string[]): string {
  return projectIds.length === 0 ? ALL_PROJECTS : projectIds.join(",");
}

/** Empty is stored as null, the backwards-compatible value for "all". */
export function encodeFacetSelection(values: readonly string[]): string | null {
  return values.length > 0 ? values.join(",") : null;
}

/** Null in storage remains available for "no filter", so no-release needs a sentinel. */
export function encodeReleaseSelection(
  value: string | null | undefined,
): string | null {
  if (value === undefined) return null;
  return value === null ? NO_RELEASE : value;
}

export function resolveReleaseSelection(
  stored: string | null | undefined,
  releases?: { value: string }[],
): string | null | undefined {
  if (stored == null || stored.length === 0) return undefined;
  if (stored === NO_RELEASE) return null;
  // A stored value the filter would not offer is no longer a selection: a
  // release that was deleted, and since OCL-128 also a branch name that some
  // delivery wrote into resolved_in.
  if (!isReleaseVersion(stored)) return undefined;
  if (releases && !releases.some((release) => release.value === stored)) {
    return undefined;
  }
  return stored;
}

function resolveFacetSelection<T extends string>(
  stored: string | string[] | null | undefined,
  known: readonly T[],
): T[] {
  const requested = new Set(
    (Array.isArray(stored) ? stored : (stored ?? "").split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return known.filter((value) => requested.has(value));
}

export function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

/**
 * The stored selection read back against the organizations that still exist.
 * A selection nothing answers is every organization, not none: a business
 * that was deleted must not leave the board pinned to an empty screen.
 */
export function resolveOrganizationSelection(
  stored: string | null | undefined,
  organizations: { id: string }[],
): string[] {
  if (stored == null || stored === ALL_ORGANIZATIONS) return [];
  const known = new Set(organizations.map((item) => item.id));
  const picked = stored
    .split(",")
    .map((id) => id.trim())
    .filter((id) => known.has(id));
  return picked.length === organizations.length ? [] : picked;
}

/** The projects the organization selection leaves on the table. */
export function projectsInOrganizations<T extends { organizationId?: string }>(
  projects: T[],
  organizationIds: string[],
): T[] {
  if (organizationIds.length === 0) return projects;
  return projects.filter(
    (item) =>
      item.organizationId !== undefined &&
      organizationIds.includes(item.organizationId),
  );
}

/**
 * The stored selection read back against the projects that still exist. A
 * selection whose projects all disappeared falls back to the first project,
 * the same default a user who never chose anything gets.
 */
export function resolveProjectSelection(
  stored: string | null,
  projects: { id: string }[],
): string[] {
  if (stored === ALL_PROJECTS) return [];
  const known = new Set(projects.map((item) => item.id));
  const picked = (stored ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => known.has(id));
  if (picked.length > 0) {
    return picked.length === projects.length ? [] : picked;
  }
  const first = defaultProjectId(projects);
  return first ? [first] : [];
}

/**
 * Checking and unchecking a project. Under All every box is ticked, so a click
 * there unticks the one clicked and leaves the rest: the box does what a
 * ticked box promises. Narrowing to a single project is the `only` button on
 * the row, which asks for it in so many words instead of hiding it inside a
 * click that looks like unchecking. A selection that ends up empty or covering
 * everything is All again, because an empty board is a state with no way to
 * read it.
 */
export function toggleProject(
  current: string[],
  projectId: string,
  projects: { id: string }[],
): string[] {
  if (current.length === 0) {
    const rest = projects.filter((item) => item.id !== projectId);
    // Unticking the only project there is would empty the board, so All holds.
    return rest.length === 0 ? [] : rest.map((item) => item.id);
  }
  const next = current.includes(projectId)
    ? current.filter((id) => id !== projectId)
    : [...current, projectId];
  if (next.length === 0 || next.length >= projects.length) return [];
  // Workspace order, so the chip and the panel read the same way.
  return projects.filter((item) => next.includes(item.id)).map((item) => item.id);
}

/**
 * Checking and unchecking an organization: the project filter's rule, applied
 * to the control above it. A click under All unticks the one clicked, and
 * `only` is how a caller asks to narrow to a single business.
 */
export function toggleOrganization(
  current: string[],
  organizationId: string,
  organizations: { id: string }[],
): string[] {
  if (current.length === 0) {
    const rest = organizations.filter((item) => item.id !== organizationId);
    return rest.length === 0 ? [] : rest.map((item) => item.id);
  }
  const next = current.includes(organizationId)
    ? current.filter((id) => id !== organizationId)
    : [...current, organizationId];
  if (next.length === 0 || next.length >= organizations.length) return [];
  return organizations
    .filter((item) => next.includes(item.id))
    .map((item) => item.id);
}

/**
 * Narrowing to one item, which is what the `only` button on an option row
 * asks for. Kept beside the toggles because it is the other half of the same
 * decision: the click unticks, this one isolates, and neither has to guess
 * which the reader meant.
 */
export function selectOnly(id: string, items: { id: string }[]): string[] {
  // One item is the whole list, and the whole list is All.
  return items.length <= 1 ? [] : [id];
}

/**
 * The filter as a query string, so a link can hand the same selection to
 * another page. Insights reads it back with boardFilterFromQuery, which is
 * what makes the topbar total and the Insights page agree by construction.
 */
export function boardFilterToQuery(filter: BoardFilter): string {
  const params = new URLSearchParams();
  params.set(
    "organizations",
    encodeOrganizationSelection(filter.organizationIds),
  );
  params.set("projects", encodeProjectSelection(filter.projectIds));
  if (filter.missionId) params.set("mission", filter.missionId);
  if (filter.types.length > 0) params.set("types", filter.types.join(","));
  if (filter.priorities.length > 0) {
    params.set("priorities", filter.priorities.join(","));
  }
  if (filter.resolvedIn !== undefined) {
    params.set("release", encodeReleaseSelection(filter.resolvedIn) ?? "");
  }
  return params.toString();
}

/** The other end of boardFilterToQuery. No params at all means everything. */
export function boardFilterFromQuery(
  params: {
    organizations?: string | null;
    projects?: string | null;
    mission?: string | null;
    types?: string | null;
    priorities?: string | null;
    release?: string | null;
  },
  projects: { id: string; organizationId?: string }[],
  missions: { id: string }[] = [],
  releases?: { value: string }[],
  organizations: { id: string }[] = [],
): BoardFilter {
  return resolveBoardFilter(
    {
      organizationId: params.organizations ?? ALL_ORGANIZATIONS,
      projectId: params.projects ?? ALL_PROJECTS,
      missionId: params.mission ?? null,
      types: params.types,
      priorities: params.priorities,
      resolvedIn: params.release,
    },
    projects,
    missions,
    releases,
    organizations,
  );
}

function inScope(filter: BoardFilter, card: FilterableCard): boolean {
  if (
    filter.organizationIds.length > 0 &&
    !filter.organizationIds.includes(card.organizationId)
  ) {
    return false;
  }
  return (
    filter.projectIds.length === 0 || filter.projectIds.includes(card.projectId)
  );
}

export function resolveBoardFilter(
  stored: StoredBoardFilter,
  projects: { id: string; organizationId?: string }[],
  missions: { id: string }[] = [],
  releases?: { value: string }[],
  organizations: { id: string }[] = [],
): BoardFilter {
  const organizationIds = resolveOrganizationSelection(
    stored.organizationId,
    organizations,
  );
  // The project selection is read inside the businesses on screen, so choosing
  // an organization narrows the board even while a wider project selection is
  // still stored on the user from before.
  const projectIds = resolveProjectSelection(
    stored.projectId,
    projectsInOrganizations(projects, organizationIds),
  );

  const missionIds = new Set(missions.map((item) => item.id));
  const missionId =
    stored.missionId === NO_MISSION
      ? NO_MISSION
      : stored.missionId && missionIds.has(stored.missionId)
        ? stored.missionId
        : null;
  const resolvedIn = resolveReleaseSelection(stored.resolvedIn, releases);

  return {
    organizationIds,
    projectIds,
    missionId,
    types: resolveFacetSelection(stored.types, TASK_TYPES),
    priorities: resolveFacetSelection(stored.priorities, TASK_PRIORITIES),
    ...(resolvedIn !== undefined ? { resolvedIn } : {}),
  };
}

function matchesFacets(card: FilterableCard, filter: BoardFilter): boolean {
  if (filter.types.length > 0 && !filter.types.includes(card.tipo)) return false;
  if (
    filter.priorities.length > 0 &&
    !filter.priorities.includes(card.priority)
  ) {
    return false;
  }
  return true;
}

function matchesRelease(card: FilterableCard, filter: BoardFilter): boolean {
  return (
    filter.resolvedIn === undefined || card.resolvedIn === filter.resolvedIn
  );
}

function matchesMission(card: FilterableCard, filter: BoardFilter): boolean {
  if (filter.missionId === NO_MISSION) return card.missionId === null;
  return !filter.missionId || card.missionId === filter.missionId;
}

export function filterBoardCards<T extends FilterableCard>(
  cards: T[],
  filter: BoardFilter,
): T[] {
  return cards.filter((card) => {
    if (!inScope(filter, card)) return false;
    if (!matchesFacets(card, filter)) return false;
    if (!matchesRelease(card, filter)) return false;
    return matchesMission(card, filter);
  });
}

/**
 * Free-text board search stays separate from facet resolution so it can be
 * composed with every active project, mission, type, priority and release
 * filter. Each word is required, which makes a query such as "OCL-72 board"
 * useful without requiring the words to appear next to each other.
 */
export function searchBoardCards<T extends SearchableBoardCard>(
  cards: T[],
  query: string,
): T[] {
  const needles = normalize(query).split(/\s+/).filter(Boolean);
  if (needles.length === 0) return cards;

  return cards.filter((card) => {
    const contract = card.comoConfirmo
      .flatMap((step) => [step.step, step.expected])
      .join(" ");
    const haystack = normalize(
      [card.shortId, card.title, card.oQue, card.porQue, contract].join(" "),
    );
    return needles.every((needle) => haystack.includes(needle));
  });
}

/** How many cards of the current selection have no mission at all. */
export function countLooseCards<T extends FilterableCard>(
  cards: T[],
  filter: BoardFilter,
): number {
  return cards.filter(
    (card) =>
      card.missionId === null &&
      inScope(filter, card) &&
      matchesFacets(card, filter) &&
      matchesRelease(card, filter),
  ).length;
}

/** A project the board filter can offer, with how many cards it would show. */
export type ProjectCount = { id: string; name: string; count: number };

/**
 * Every project of the workspace, each with the cards it would put on screen.
 * Unlike missions, a project with nothing in it stays on the list: the filter
 * is also how you get to a project, and an empty one is where the next card
 * goes. The counts answer the mission filter in force, because that is what
 * picking this project would actually show.
 */
export function projectFilterOptions<T extends FilterableCard>(
  cards: T[],
  projects: { id: string; name: string; organizationId?: string }[],
  filter: BoardFilter,
): ProjectCount[] {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (!matchesFacets(card, filter)) continue;
    if (!matchesRelease(card, filter)) continue;
    if (filter.missionId === NO_MISSION && card.missionId !== null) continue;
    if (
      filter.missionId &&
      filter.missionId !== NO_MISSION &&
      card.missionId !== filter.missionId
    ) {
      continue;
    }
    counts.set(card.projectId, (counts.get(card.projectId) ?? 0) + 1);
  }
  // Only the projects of the businesses on screen: an organization filter
  // that left this list whole would offer a one-click way straight back out
  // of the business just chosen.
  return projectsInOrganizations(projects, filter.organizationIds).map(
    (proj) => ({
      id: proj.id,
      name: proj.name,
      count: counts.get(proj.id) ?? 0,
    }),
  );
}

/** An organization the filter can offer, with the cards it would put on screen. */
export type OrganizationCount = { id: string; name: string; count: number };

/**
 * Every organization of the workspace, each with what picking it alone would
 * show. The count answers the facets, the release and the mission in force,
 * but not the project selection: that selection lives inside this one and is
 * re-read the moment the business changes.
 */
export function organizationFilterOptions<T extends FilterableCard>(
  cards: T[],
  organizations: { id: string; name: string }[],
  filter: BoardFilter,
): OrganizationCount[] {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (!matchesFacets(card, filter)) continue;
    if (!matchesRelease(card, filter)) continue;
    if (!matchesMission(card, filter)) continue;
    counts.set(card.organizationId, (counts.get(card.organizationId) ?? 0) + 1);
  }
  return organizations.map((org) => ({
    id: org.id,
    name: org.name,
    count: counts.get(org.id) ?? 0,
  }));
}

/** A mission the board filter can offer, with how many cards it holds here. */
export type MissionCount = { id: string; title: string; count: number };

/**
 * The missions worth offering on the board filter. Missions are workspace
 * wide, so a board that lists all of them offers chips that lead to an empty
 * board, and a filter that yields nothing teaches people to distrust the
 * filter. Only what holds cards in the current scope is offered, each with its
 * count. The mission being filtered by survives with a count of zero: hiding
 * the active filter would leave an empty board with nothing to clear.
 *
 * This rule is for filtering only. Choosing a mission for a card still lists
 * every mission of the workspace, because a mission crosses projects and this
 * card may be the first of that mission here.
 */
export function missionFilterOptions<T extends FilterableCard>(
  cards: T[],
  missions: { id: string; title: string }[],
  filter: BoardFilter,
): MissionCount[] {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (!inScope(filter, card)) continue;
    if (!matchesFacets(card, filter)) continue;
    if (!matchesRelease(card, filter)) continue;
    if (!card.missionId) continue;
    counts.set(card.missionId, (counts.get(card.missionId) ?? 0) + 1);
  }
  return missions
    .filter((miss) => (counts.get(miss.id) ?? 0) > 0 || miss.id === filter.missionId)
    .map((miss) => ({
      id: miss.id,
      title: miss.title,
      count: counts.get(miss.id) ?? 0,
    }));
}

/** A release the filter can offer, with the count left by every other dimension. */
export type ReleaseCount = { value: string | null; count: number };

/**
 * The releases worth putting on the filter (OCL-128).
 *
 * `resolved_in` is a free-text column, and a delivery that wrote its branch
 * name there ("ovka-78-...-f@68218bba") became an option on the RELEASE
 * filter, next to v0.2.2 and holding no cards. The write path refuses that
 * value now; this is the reading end, so the rows already stamped stop
 * polluting the menu. The cards themselves are not hidden: they stay under
 * "all releases", which is where a card whose release this filter cannot
 * read belongs.
 */
export function releaseValueOptions(
  releases: { value: string }[],
): { value: string }[] {
  return releases.filter((release) => isReleaseVersion(release.value));
}

export function releaseFilterOptions<T extends FilterableCard>(
  cards: T[],
  releases: { value: string }[],
  filter: BoardFilter,
): ReleaseCount[] {
  const counts = new Map<string | null, number>();
  for (const card of cards) {
    if (!inScope(filter, card)) continue;
    if (!matchesFacets(card, filter)) continue;
    if (!matchesMission(card, filter)) continue;
    counts.set(card.resolvedIn, (counts.get(card.resolvedIn) ?? 0) + 1);
  }
  return [
    ...releaseValueOptions(releases).map((release) => ({
      value: release.value,
      count: counts.get(release.value) ?? 0,
    })),
    { value: null, count: counts.get(null) ?? 0 },
  ];
}

/**
 * Past this many missions the eye stops scanning and starts hunting, so the
 * filter grows a search box. Below it the box would be one more control to
 * read before reading the three options it filters.
 */
export const MISSION_SEARCH_THRESHOLD = 8;

export function shouldSearchMissions(optionCount: number): boolean {
  return optionCount > MISSION_SEARCH_THRESHOLD;
}

/** Accents and case are how the mission was typed, not what is being looked for. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function searchMissions(
  options: MissionCount[],
  query: string,
): MissionCount[] {
  const needle = normalize(query);
  if (!needle) return options;
  return options.filter((option) => normalize(option.title).includes(needle));
}
