import { describe, expect, it } from "vitest";
import type { ModelPrice } from "@agent-board/db";
import { filterBoardCards } from "./board-filter";
import { toBoardTotals } from "./board-totals";
import {
  computeInsights,
  filterMissionAttempts,
  type InsightAttemptRow,
  type MissionAttemptInsightRow,
} from "./insights";
import { organizationScope, organizationTotals } from "./organizations-query";

const PRICES: ModelPrice[] = [
  {
    model: "opus-5",
    label: "opus-5",
    inputPerMtok: 5,
    outputPerMtok: 25,
    cachePerMtok: 0.5,
    cacheWritePerMtok: 0.5,
  },
];

let seq = 0;

function attempt(over: Partial<InsightAttemptRow> = {}): InsightAttemptRow {
  seq += 1;
  return {
    attemptId: `attempt-${seq}`,
    organizationId: "o1",
    taskId: `task-${seq}`,
    taskShortId: `OCL-${seq}`,
    taskTitle: "card",
    taskIsExample: false,
    taskStatus: "feito",
    tipo: "feature",
    priority: "media",
    projectId: "p1",
    projectName: "Board",
    missionId: null,
    missionTitle: null,
    resolvedIn: null,
    model: "opus-5",
    executor: "claude-code",
    modelSource: "declared",
    result: "success",
    finishedAt: new Date("2026-08-20T10:00:00Z"),
    usageSegments: null,
    tokensIn: 1000,
    tokensOut: 200,
    tokensCache: 0,
    costUsd: null,
    costSource: null,
    costStatus: null,
    costUnpricedModels: null,
    costBreakdown: null,
    durationMs: 60_000,
    serverDurationMs: null,
    turns: 3,
    usageEstimated: false,
    usageSuspect: false,
    ...over,
  };
}

function missionAttempt(
  over: Partial<MissionAttemptInsightRow> = {},
): MissionAttemptInsightRow {
  seq += 1;
  return {
    attemptId: `mission-attempt-${seq}`,
    organizationId: "o1",
    projectId: "p1",
    projectName: "Board",
    missionId: "m1",
    missionTitle: "Organization layer",
    model: "opus-5",
    executor: "claude-code",
    modelSource: "declared",
    status: "finished",
    result: "success",
    finishedAt: new Date("2026-08-20T11:00:00Z"),
    usageSegments: null,
    tokensIn: 500,
    tokensOut: 100,
    tokensCache: 0,
    costUsd: null,
    costSource: null,
    costStatus: null,
    costUnpricedModels: null,
    costBreakdown: null,
    durationMs: 30_000,
    serverDurationMs: null,
    turns: 2,
    usageEstimated: false,
    usageSuspect: false,
    ...over,
  };
}

/**
 * The contract of the organizations page: its numbers are the board's numbers.
 * The test does not re-add the tokens by hand — that would be a third
 * arithmetic to keep in step. It runs the aggregation the topbar total runs
 * (`filterBoardCards` into `computeInsights` into `toBoardTotals`, which is
 * `loadBoardTotals` with the query stripped off) and asserts the page agrees.
 */
describe("organization telemetry is the board's telemetry", () => {
  const rows = [
    attempt({ organizationId: "o1", projectId: "p1" }),
    attempt({ organizationId: "o1", projectId: "p2", tokensIn: 4000 }),
    attempt({ organizationId: "o2", projectId: "p3", tokensIn: 9000 }),
  ];
  const missionRows = [
    missionAttempt({ organizationId: "o1" }),
    missionAttempt({ organizationId: "o2", tokensIn: 7000 }),
  ];
  const money = { pricingEnabled: true, prices: PRICES };

  function boardTotals(organizationId: string) {
    const filter = organizationScope(organizationId);
    const insights = computeInsights(
      filterBoardCards(rows, filter),
      [],
      money.prices,
      filterMissionAttempts(missionRows, filter),
    );
    return toBoardTotals(insights.totals, money.pricingEnabled);
  }

  it("matches the board total for the same organization", () => {
    for (const organizationId of ["o1", "o2"]) {
      expect(
        organizationTotals(organizationId, rows, missionRows, money),
      ).toEqual(boardTotals(organizationId));
    }
  });

  it("counts only the work filed under that organization", () => {
    const first = organizationTotals("o1", rows, missionRows, money);
    const second = organizationTotals("o2", rows, missionRows, money);
    // Three attempts of work under o1 (two cards and one mission attempt),
    // two under o2, and no row is counted twice.
    expect(first.attempts).toBe(3);
    expect(second.attempts).toBe(2);
    expect(first.tokens + second.tokens).toBe(
      organizationTotals("o1", rows, missionRows, money).tokens +
        organizationTotals("o2", rows, missionRows, money).tokens,
    );
    expect(first.tokens).toBeGreaterThan(0);
    expect(second.tokens).toBeGreaterThan(0);
  });

  it("leaves money out when the workspace never switched it on", () => {
    const totals = organizationTotals("o1", rows, missionRows, {
      pricingEnabled: false,
      prices: PRICES,
    });
    // Not a zero: an unpriced board has no dollar figure to report at all.
    expect(totals.costUsd).toBeNull();
  });
});
