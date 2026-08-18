import { describe, expect, it } from "vitest";
import type { ModelPrice } from "@agent-board/db";
import type { InsightAttemptRow } from "../../lib/insights";
import { buildDailyTrend, trendValue } from "./trend";

const PRICES: ModelPrice[] = [
  { model: "opus-5", label: "opus-5", inputPerMtok: 5, outputPerMtok: 25, cachePerMtok: 0.5 },
];

function row(over: Partial<InsightAttemptRow>): InsightAttemptRow {
  return {
    attemptId: "a1",
    taskId: "t1",
    taskShortId: "AGB-1",
    taskTitle: "card",
    taskIsExample: false,
    taskStatus: "feito",
    tipo: "feature",
    priority: "media",
    projectId: "p1",
    projectName: "proj",
    missionId: null,
    missionTitle: null,
    model: "claude-opus-5",
    executor: "claude-code",
    result: "success",
    finishedAt: new Date(2026, 7, 10, 12),
    usageSegments: null,
    tokensIn: 1_000_000,
    tokensOut: 100_000,
    tokensCache: 0,
    costUsd: null,
    costSource: null,
    costStatus: null,
    costUnpricedModels: null,
    costBreakdown: null,
    durationMs: 60_000,
    serverDurationMs: 60_000,
    turns: 3,
    usageEstimated: false,
    usageSuspect: false,
    ...over,
  };
}

describe("buildDailyTrend", () => {
  it("buckets by finish day and fills the gap with zero days", () => {
    const trend = buildDailyTrend(
      [
        row({}),
        row({ attemptId: "a2", finishedAt: new Date(2026, 7, 10, 18) }),
        row({ attemptId: "a3", finishedAt: new Date(2026, 7, 12, 9) }),
      ],
      { prices: [], pricingEnabled: false, lang: "en" },
    );
    expect(trend.points.map((p) => p.dayKey)).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ]);
    expect(trend.points[0].attempts).toBe(2);
    expect(trend.points[1].tokens).toBe(0);
    expect(trend.metric).toBe("tokens");
    expect(trend.peak?.dayKey).toBe("2026-08-10");
  });

  it("skips unfinished and example attempts, like the totals do", () => {
    const trend = buildDailyTrend(
      [
        row({}),
        row({ attemptId: "a2", finishedAt: null }),
        row({ attemptId: "a3", taskIsExample: true }),
      ],
      { prices: [], pricingEnabled: false, lang: "en" },
    );
    expect(trend.points).toHaveLength(1);
    expect(trend.points[0].attempts).toBe(1);
  });

  it("measures cost with the price table when pricing is on", () => {
    const trend = buildDailyTrend([row({})], {
      prices: PRICES,
      pricingEnabled: true,
      lang: "pt-BR",
    });
    expect(trend.metric).toBe("cost");
    // 1M input at 5/Mtok + 100k output at 25/Mtok = 7.5
    expect(trend.points[0].costUsd).toBeCloseTo(7.5);
    expect(trendValue(trend.points[0], trend.metric)).toBeCloseTo(7.5);
    expect(trend.points[0].label).toBe("10/8");
  });

  it("falls back to the agent-reported cost when no price covers the model", () => {
    const trend = buildDailyTrend(
      [row({ model: "grok-4.6", costUsd: "3.25" })],
      { prices: PRICES, pricingEnabled: true, lang: "en" },
    );
    expect(trend.points[0].costUsd).toBeCloseTo(3.25);
  });

  it("keeps suspect counters out of the trend", () => {
    const trend = buildDailyTrend(
      [row({ usageSuspect: true, tokensIn: 5_000_000 })],
      { prices: [], pricingEnabled: false, lang: "en" },
    );
    expect(trend.points[0]).toMatchObject({ attempts: 1, tokens: 0 });
  });
});
