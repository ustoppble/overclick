import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_BOARD_TOTALS } from "../../lib/board-totals";
import { dict } from "../../lib/i18n";
import type { BoardCard, BoardMissionOption } from "./board";
import { ReleaseHeader, releaseOverview } from "./release-header";

function card(overrides: Partial<BoardCard>): BoardCard {
  return {
    id: "card-1",
    organizationId: "o1",
    shortId: "OCL-1",
    title: "Release card",
    tipo: "feature",
    priority: "alta",
    status: "feito",
    supersedes: null,
    supersededBy: null,
    isExample: false,
    oQue: "x",
    porQue: "y",
    comoConfirmo: [],
    validationTicks: [],
    howToVerify: null,
    projectId: "project-1",
    projectName: "OverClick",
    missionId: "mission-1",
    mission: "Reliability",
    harness: null,
    plannedCli: null,
    ranCli: "codex",
    executors: ["codex"],
    harnessChain: null,
    harnessRan: null,
    modelSource: null,
    awaitingMyReview: false,
    devolve: "queue",
    origem: "test",
    executor: null,
    elapsed: null,
    claimInactive: null,
    claimStale: false,
    branch: null,
    resolvedIn: "v1.2.0",
    reportsCount: 0,
    timeline: [],
    telemetry: null,
    telemetryLine: [],
    duration: null,
    usageSuspect: false,
    transcript: null,
    handoff: null,
    ...overrides,
  };
}

const missions: BoardMissionOption[] = [
  {
    id: "mission-1",
    title: "Reliability",
    status: "ativa",
    objective: "",
    context: "",
    counts: {
      total: 2,
      aberto: 1,
      em_execucao: 0,
      feito: 1,
      validado: 0,
    },
  },
];

describe("release header", () => {
  it("aggregates status, missions and distinct actual executors", () => {
    const overview = releaseOverview(
      [
        card({ status: "aberto" }),
        card({ id: "card-2", executors: ["codex", "claude"] }),
        card({ id: "card-3", status: "validado", ranCli: "claude", executors: ["claude"] }),
      ],
      missions,
    );
    expect(overview.counts).toMatchObject({ aberto: 1, feito: 1, validado: 1 });
    expect(overview.missions.map((mission) => mission.id)).toEqual(["mission-1"]);
    expect(overview.executors).toEqual(["claude", "codex"]);
  });

  it("renders totals, honesty labels, mission chips and the filtered Insights link", () => {
    const html = renderToStaticMarkup(
      createElement(ReleaseHeader, {
        release: "v1.2.0",
        cards: [card({})],
        missions,
        totals: {
          ...EMPTY_BOARD_TOTALS,
          attempts: 1,
          tokens: 12_500,
          costUsd: 1.25,
          costComputed: 1,
          estimated: 1,
        },
        filter: {
          organizationIds: [],
          projectIds: [],
          missionId: null,
          types: [],
          priorities: [],
          resolvedIn: "v1.2.0",
        },
        onMissionSelect: vi.fn(),
        t: dict("en"),
      }),
    );

    expect(html).toContain("v1.2.0");
    // Every figure in the usage row is named: money carries its label and its
    // currency, tokens carry their unit (ux-v2 §4).
    expect(html).toContain("Cost");
    expect(html).toContain("$1.25");
    expect(html).toContain("13k");
    expect(html).toContain("tokens");
    expect(html).toContain("1 estimated");
    expect(html).toContain("Reliability");
    expect(html).toContain("codex");
    expect(html).toContain("release=v1.2.0");
  });
});
