import { describe, expect, it } from "vitest";
import {
  ALL_ORGANIZATIONS,
  ALL_PROJECTS,
  NO_MISSION,
  boardFilterFromQuery,
  boardFilterToQuery,
  countLooseCards,
  encodeFacetSelection,
  encodeProjectSelection,
  encodeReleaseSelection,
  filterBoardCards,
  missionFilterOptions,
  organizationFilterOptions,
  projectFilterOptions,
  releaseFilterOptions,
  releaseValueOptions,
  resolveBoardFilter,
  resolveOrganizationSelection,
  resolveReleaseSelection,
  resolveProjectSelection,
  searchBoardCards,
  searchMissions,
  shouldSearchMissions,
  toggleOrganization,
  toggleProject,
  type BoardFilter,
} from "./board-filter";

// Two businesses, so every assertion about narrowing has something to narrow.
const organizations = [
  { id: "o1", name: "Acme" },
  { id: "o2", name: "Other" },
];
const projects = [
  { id: "p1", organizationId: "o1" },
  { id: "p2", organizationId: "o1" },
  { id: "p3", organizationId: "o2" },
];
const named = [
  { id: "p1", name: "Board", organizationId: "o1" },
  { id: "p2", name: "Funnel", organizationId: "o1" },
  { id: "p3", name: "Empty", organizationId: "o2" },
];
const missions = [{ id: "m1" }, { id: "m2" }];
const titled = [
  { id: "m1", title: "Onboarding" },
  { id: "m2", title: "Cobrança" },
  { id: "m3", title: "Empty elsewhere" },
];
const cards = [
  { id: "a", organizationId: "o1", projectId: "p1", missionId: "m1", tipo: "feature" as const, priority: "urgente" as const, resolvedIn: "v1.2.0" },
  { id: "b", organizationId: "o1", projectId: "p1", missionId: null, tipo: "bug" as const, priority: "alta" as const, resolvedIn: null },
  { id: "c", organizationId: "o1", projectId: "p2", missionId: "m2", tipo: "bug" as const, priority: "media" as const, resolvedIn: "v1.1.0" },
];
/** The only card of the second business, which is what o2 narrows down to. */
const otherBusinessCard = {
  id: "d",
  organizationId: "o2",
  projectId: "p3",
  missionId: null,
  tipo: "feature" as const,
  priority: "baixa" as const,
  resolvedIn: null,
};
const allCards = [...cards, otherBusinessCard];

const searchableCards = [
  {
    ...cards[0],
    shortId: "OCL-72",
    title: "Pesquisar no board",
    oQue: "Campo de busca dentro de Filtros",
    porQue: "Achar cards sem rolagem cega",
    comoConfirmo: [
      { step: "Digitar um trecho", expected: "Board filtra em tempo real" },
    ],
  },
  {
    ...cards[1],
    shortId: "OCL-11",
    title: "Revisão do cabeçalho",
    oQue: "Ajustar o topbar",
    porQue: "Dar mais espaço",
    comoConfirmo: [
      { step: "Abrir o board", expected: "Cabeçalho em uma linha" },
    ],
  },
];
const ALL: string[] = [];

function boardFilter(overrides: Partial<BoardFilter> = {}): BoardFilter {
  return {
    organizationIds: [],
    projectIds: ALL,
    missionId: null,
    types: [],
    priorities: [],
    ...overrides,
  };
}

describe("board filters", () => {
  it("defaults to the first project when the user has no stored choice", () => {
    expect(resolveBoardFilter({ projectId: null, missionId: null }, projects, missions)).toEqual({
      organizationIds: [],
      projectIds: ["p1"],
      missionId: null,
      types: [],
      priorities: [],
    });
  });

  it("keeps All projects and a known mission", () => {
    expect(
      resolveBoardFilter(
        { projectId: ALL_PROJECTS, missionId: "m2" },
        projects,
        missions,
      ),
    ).toEqual(boardFilter({ missionId: "m2" }));
  });

  it("falls back when the stored project or mission disappeared", () => {
    expect(
      resolveBoardFilter(
        { projectId: "gone", missionId: "gone" },
        projects,
        missions,
      ),
    ).toEqual(boardFilter({ projectIds: ["p1"] }));
  });

  it("filters cards by project and mission; counters follow the list", () => {
    const onlyP1 = filterBoardCards(cards, boardFilter({ projectIds: ["p1"] }));
    expect(onlyP1.map((card) => card.id)).toEqual(["a", "b"]);

    const mission = filterBoardCards(cards, boardFilter({ missionId: "m2" }));
    expect(mission.map((card) => card.id)).toEqual(["c"]);

    const both = filterBoardCards(
      cards,
      boardFilter({ projectIds: ["p1"], missionId: "m1" }),
    );
    expect(both.map((card) => card.id)).toEqual(["a"]);
  });

  it("searches card ids, titles and contract text without losing facet results", () => {
    expect(searchBoardCards(searchableCards, "ocl-72").map((card) => card.shortId)).toEqual([
      "OCL-72",
    ]);
    expect(searchBoardCards(searchableCards, "rolagem cega").map((card) => card.shortId)).toEqual([
      "OCL-72",
    ]);
    expect(searchBoardCards(searchableCards, "CAMPO filtros").map((card) => card.shortId)).toEqual([
      "OCL-72",
    ]);
    expect(searchBoardCards(searchableCards, "  ")).toEqual(searchableCards);
  });

  it("keeps a no-mission bucket instead of hiding the loose cards", () => {
    expect(
      resolveBoardFilter(
        { projectId: ALL_PROJECTS, missionId: NO_MISSION },
        projects,
        missions,
      ),
    ).toEqual(boardFilter({ missionId: NO_MISSION }));

    const loose = filterBoardCards(cards, boardFilter({ missionId: NO_MISSION }));
    expect(loose.map((card) => card.id)).toEqual(["b"]);
  });

  it("counts the loose cards of the selection on screen", () => {
    expect(countLooseCards(cards, boardFilter({ projectIds: ["p1"] }))).toBe(1);
    expect(countLooseCards(cards, boardFilter({ projectIds: ["p2"] }))).toBe(0);
    expect(countLooseCards(cards, boardFilter({ missionId: "m1" }))).toBe(1);
  });

  it("combines project, mission, type and priority with OR inside facets", () => {
    const filtered = filterBoardCards(
      cards,
      boardFilter({
        projectIds: ["p1", "p2"],
        types: ["bug"],
        priorities: ["urgente", "alta"],
      }),
    );
    expect(filtered.map((card) => card.id)).toEqual(["b"]);

    const urgentOrMediumBugs = filterBoardCards(
      cards,
      boardFilter({
        types: ["bug"],
        priorities: ["urgente", "media"],
      }),
    );
    expect(urgentOrMediumBugs.map((card) => card.id)).toEqual(["c"]);
  });

  it("filters one exact release or the no-release bucket and combines dimensions", () => {
    expect(
      filterBoardCards(cards, boardFilter({ resolvedIn: "v1.2.0" })).map(
        (card) => card.id,
      ),
    ).toEqual(["a"]);
    expect(
      filterBoardCards(cards, boardFilter({ resolvedIn: null })).map(
        (card) => card.id,
      ),
    ).toEqual(["b"]);
    expect(
      filterBoardCards(
        cards,
        boardFilter({ projectIds: ["p2"], resolvedIn: "v1.2.0" }),
      ),
    ).toEqual([]);
  });

  it("stores and restores type and priority selections", () => {
    expect(encodeFacetSelection([])).toBeNull();
    expect(encodeFacetSelection(["bug", "rfc"])).toBe("bug,rfc");
    expect(
      resolveBoardFilter(
        {
          projectId: "p1",
          missionId: "m1",
          types: "bug,rfc,unknown",
          priorities: "urgente,alta,unknown",
        },
        projects,
        missions,
      ),
    ).toEqual(
      boardFilter({
        projectIds: ["p1"],
        missionId: "m1",
        types: ["bug", "rfc"],
        priorities: ["urgente", "alta"],
      }),
    );
  });
});

describe("several projects at once", () => {
  it("shows the selected projects together", () => {
    const two = filterBoardCards(cards, boardFilter({ projectIds: ["p1", "p2"] }));
    expect(two.map((card) => card.id)).toEqual(["a", "b", "c"]);

    const one = filterBoardCards(cards, boardFilter({ projectIds: ["p2"] }));
    expect(one.map((card) => card.id)).toEqual(["c"]);
  });

  it("stores the selection as one string and reads it back", () => {
    expect(encodeProjectSelection(["p1", "p2"])).toBe("p1,p2");
    expect(encodeProjectSelection(ALL)).toBe(ALL_PROJECTS);

    expect(resolveProjectSelection("p1,p2", projects)).toEqual(["p1", "p2"]);
    expect(resolveProjectSelection(ALL_PROJECTS, projects)).toEqual(ALL);
    // A project that was deleted drops out; what is left still stands.
    expect(resolveProjectSelection("p2,gone", projects)).toEqual(["p2"]);
    // Nothing left to stand on falls back to the single-project default.
    expect(resolveProjectSelection("gone", projects)).toEqual(["p1"]);
    // Every project selected is the All projects shortcut, stored as such.
    expect(resolveProjectSelection("p1,p2,p3", projects)).toEqual(ALL);
  });

  it("checks and unchecks, with All projects at both edges", () => {
    // Out of the shortcut, the first click narrows to what was clicked.
    expect(toggleProject(ALL, "p2", projects)).toEqual(["p2"]);
    expect(toggleProject(["p2"], "p1", projects)).toEqual(["p1", "p2"]);
    // Unchecking the last one is All projects again, never an empty board.
    expect(toggleProject(["p2"], "p2", projects)).toEqual(ALL);
    // So is checking every one of them.
    expect(toggleProject(["p1", "p2"], "p3", projects)).toEqual(ALL);
  });

  it("hands the selection to another page and reads it back", () => {
    expect(
      boardFilterToQuery(
        boardFilter({
          projectIds: ["p1", "p2"],
          missionId: "m1",
          types: ["bug", "feature"],
          priorities: ["urgente", "alta"],
          resolvedIn: "v1.2.0",
        }),
      ),
    ).toBe(
      "organizations=all&projects=p1%2Cp2&mission=m1&types=bug%2Cfeature&priorities=urgente%2Calta&release=v1.2.0",
    );
    expect(boardFilterToQuery(boardFilter())).toBe(
      "organizations=all&projects=all",
    );

    expect(
      boardFilterFromQuery({ projects: "p1,p2", mission: "m1" }, projects, missions),
    ).toEqual(boardFilter({ projectIds: ["p1", "p2"], missionId: "m1" }));
    // No params at all is the whole workspace, not the first project.
    expect(boardFilterFromQuery({}, projects, missions)).toEqual({
      organizationIds: [],
      projectIds: ALL,
      missionId: null,
      types: [],
      priorities: [],
    });
    expect(
      boardFilterFromQuery({ projects: "all", mission: NO_MISSION }, projects, missions),
    ).toEqual(boardFilter({ missionId: NO_MISSION }));

    expect(
      boardFilterFromQuery(
        { types: "bug,rfc,unknown", priorities: "alta,baixa,unknown" },
        projects,
        missions,
      ),
    ).toEqual(
      boardFilter({ types: ["bug", "rfc"], priorities: ["alta", "baixa"] }),
    );
  });

  it("stores, restores and validates release choices, including no release", () => {
    const releases = [{ value: "v1.2.0" }, { value: "v1.1.0" }];
    expect(encodeReleaseSelection(undefined)).toBeNull();
    expect(encodeReleaseSelection(null)).toBe("__no_release__");
    expect(resolveReleaseSelection("__no_release__", releases)).toBeNull();
    expect(resolveReleaseSelection("v1.2.0", releases)).toBe("v1.2.0");
    expect(resolveReleaseSelection("gone", releases)).toBeUndefined();
    expect(
      boardFilterFromQuery(
        { projects: "all", release: "__no_release__" },
        projects,
        missions,
        releases,
      ),
    ).toEqual(boardFilter({ resolvedIn: null }));
  });

  it("lists releases in server order plus no release, counted under other filters", () => {
    expect(
      releaseFilterOptions(
        cards,
        [{ value: "v1.2.0" }, { value: "v1.1.0" }],
        boardFilter({ projectIds: ["p1"] }),
      ),
    ).toEqual([
      { value: "v1.2.0", count: 1 },
      { value: "v1.1.0", count: 0 },
      { value: null, count: 1 },
    ]);
  });

  it("offers every project with what picking it would show", () => {
    expect(projectFilterOptions(cards, named, boardFilter({ projectIds: ["p1"] }))).toEqual([
      { id: "p1", name: "Board", count: 2 },
      { id: "p2", name: "Funnel", count: 1 },
      { id: "p3", name: "Empty", count: 0 },
    ]);
  });

  it("counts what the mission in force would leave on screen", () => {
    expect(projectFilterOptions(cards, named, boardFilter({ missionId: "m1" }))).toEqual([
      { id: "p1", name: "Board", count: 1 },
      { id: "p2", name: "Funnel", count: 0 },
      { id: "p3", name: "Empty", count: 0 },
    ]);
    expect(
      projectFilterOptions(cards, named, boardFilter({ missionId: NO_MISSION })),
    ).toEqual([
      { id: "p1", name: "Board", count: 1 },
      { id: "p2", name: "Funnel", count: 0 },
      { id: "p3", name: "Empty", count: 0 },
    ]);
  });
});

describe("the missions the filter offers", () => {
  it("offers only what holds cards here, each with its count", () => {
    expect(
      missionFilterOptions(cards, titled, boardFilter({ projectIds: ["p1"] })),
    ).toEqual([{ id: "m1", title: "Onboarding", count: 1 }]);

    expect(
      missionFilterOptions(cards, titled, boardFilter()),
    ).toEqual([
      { id: "m1", title: "Onboarding", count: 1 },
      { id: "m2", title: "Cobrança", count: 1 },
    ]);
  });

  it("narrows to the missions inside the selection", () => {
    expect(
      missionFilterOptions(cards, titled, boardFilter({ projectIds: ["p1", "p2"] })),
    ).toEqual([
      { id: "m1", title: "Onboarding", count: 1 },
      { id: "m2", title: "Cobrança", count: 1 },
    ]);

    expect(
      missionFilterOptions(cards, titled, boardFilter({ projectIds: ["p2"] })),
    ).toEqual([{ id: "m2", title: "Cobrança", count: 1 }]);
  });

  it("keeps the mission being filtered by, so it can be cleared", () => {
    expect(
      missionFilterOptions(
        cards,
        titled,
        boardFilter({ projectIds: ["p1"], missionId: "m2" }),
      ),
    ).toEqual([
      { id: "m1", title: "Onboarding", count: 1 },
      { id: "m2", title: "Cobrança", count: 0 },
    ]);
  });

  it("counts every card of the mission, not just the first", () => {
    const many = [
      ...cards,
      { id: "d", organizationId: "o1", projectId: "p1", missionId: "m1", tipo: "feature" as const, priority: "urgente" as const, resolvedIn: "v1.2.0" },
      { id: "e", organizationId: "o1", projectId: "p1", missionId: "m1", tipo: "feature" as const, priority: "urgente" as const, resolvedIn: "v1.2.0" },
    ];
    expect(
      missionFilterOptions(many, titled, boardFilter({ projectIds: ["p1"] })),
    ).toEqual([{ id: "m1", title: "Onboarding", count: 3 }]);
  });

  it("grows a search box only past a handful", () => {
    expect(shouldSearchMissions(8)).toBe(false);
    expect(shouldSearchMissions(9)).toBe(true);
  });

  it("searches ignoring case and accents", () => {
    const options = [
      { id: "m1", title: "Onboarding", count: 2 },
      { id: "m2", title: "Cobrança", count: 1 },
    ];
    expect(searchMissions(options, "cobranca").map((o) => o.id)).toEqual(["m2"]);
    expect(searchMissions(options, "ONBOARD").map((o) => o.id)).toEqual(["m1"]);
    expect(searchMissions(options, "  ").map((o) => o.id)).toEqual(["m1", "m2"]);
    expect(searchMissions(options, "nothing")).toEqual([]);
  });
});

/**
 * OCL-128: a delivery stamped `resolved_in` with its branch name, and the
 * RELEASE filter listed the raw value beside v0.2.2 with a count of zero.
 */
describe("the release filter only offers releases", () => {
  const branch =
    "ovka-78-bug-selecao-de-texto-no-pane-anda-com-o-scroll-f@68218bba";

  it("drops a value that is not a version from the options", () => {
    expect(
      releaseFilterOptions(
        cards,
        [{ value: "v1.2.0" }, { value: branch }, { value: "v1.1.0" }],
        boardFilter({}),
      ),
    ).toEqual([
      { value: "v1.2.0", count: 1 },
      { value: "v1.1.0", count: 1 },
      { value: null, count: 1 },
    ]);
  });

  it("keeps the no-release bucket counting cards whose release was dropped", () => {
    const stamped = [
      ...cards,
      {
        id: "d",
        organizationId: "o1",
        projectId: "p1",
        missionId: null,
        tipo: "bug" as const,
        priority: "baixa" as const,
        resolvedIn: branch,
      },
    ];
    const options = releaseFilterOptions(
      stamped,
      [{ value: "v1.2.0" }, { value: branch }],
      boardFilter({}),
    );
    expect(options.map((option) => option.value)).toEqual(["v1.2.0", null]);
  });

  it("narrows a raw list to the releases worth offering", () => {
    expect(
      releaseValueOptions([
        { value: "v1.2.0" },
        { value: branch },
        { value: "main" },
        { value: "1.1" },
      ]),
    ).toEqual([{ value: "v1.2.0" }, { value: "1.1" }]);
  });

  it("refuses to restore a stored selection that is not a release", () => {
    expect(resolveReleaseSelection(branch, [{ value: branch }])).toBeUndefined();
  });

  it("shows only the cards of the organizations picked", () => {
    expect(
      filterBoardCards(allCards, boardFilter({ organizationIds: ["o2"] })).map(
        (card) => card.id,
      ),
    ).toEqual(["d"]);
    // No organization picked is every organization, not none: a single
    // business instance must keep seeing its whole board.
    expect(filterBoardCards(allCards, boardFilter()).map((card) => card.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("offers only the projects of the organizations picked", () => {
    expect(
      projectFilterOptions(
        allCards,
        named,
        boardFilter({ organizationIds: ["o2"] }),
      ),
    ).toEqual([{ id: "p3", name: "Empty", count: 1 }]);
    expect(
      projectFilterOptions(allCards, named, boardFilter()).map((option) => option.id),
    ).toEqual(["p1", "p2", "p3"]);
  });

  it("counts every organization against the other filters in force", () => {
    expect(
      organizationFilterOptions(allCards, organizations, boardFilter()),
    ).toEqual([
      { id: "o1", name: "Acme", count: 3 },
      { id: "o2", name: "Other", count: 1 },
    ]);
    // The project selection is not applied: it lives inside this choice and is
    // replaced the moment the business changes.
    expect(
      organizationFilterOptions(
        allCards,
        organizations,
        boardFilter({ projectIds: ["p1"], types: ["bug"] }),
      ),
    ).toEqual([
      { id: "o1", name: "Acme", count: 2 },
      { id: "o2", name: "Other", count: 0 },
    ]);
  });

  it("reads a stored project selection inside the organizations picked", () => {
    // p1 and p2 are stored, but the board is on the other business now: the
    // stale selection cannot survive as an empty screen.
    expect(
      resolveBoardFilter(
        { organizationId: "o2", projectId: "p1,p2", missionId: null },
        projects,
        missions,
        undefined,
        organizations,
      ),
    ).toEqual({
      organizationIds: ["o2"],
      projectIds: ["p3"],
      missionId: null,
      types: [],
      priorities: [],
    });
  });

  it("falls back to every organization when the stored one is gone", () => {
    expect(resolveOrganizationSelection("deleted-id", organizations)).toEqual([]);
    expect(resolveOrganizationSelection(ALL_ORGANIZATIONS, organizations)).toEqual([]);
    expect(resolveOrganizationSelection(null, organizations)).toEqual([]);
    // Picking every organization one by one is the same as picking All.
    expect(resolveOrganizationSelection("o1,o2", organizations)).toEqual([]);
  });

  it("toggles organizations with the same All edges the project filter has", () => {
    expect(toggleOrganization([], "o1", organizations)).toEqual(["o1"]);
    expect(toggleOrganization(["o1"], "o1", organizations)).toEqual([]);
    expect(toggleOrganization(["o1"], "o2", organizations)).toEqual([]);
  });

  it("carries the organization selection to another page and back", () => {
    const query = boardFilterToQuery(boardFilter({ organizationIds: ["o2"] }));
    expect(query).toContain("organizations=o2");
    expect(
      boardFilterFromQuery(
        Object.fromEntries(new URLSearchParams(query)),
        projects,
        missions,
        undefined,
        organizations,
      ).organizationIds,
    ).toEqual(["o2"]);
  });
});
