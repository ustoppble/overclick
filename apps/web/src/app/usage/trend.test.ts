import { describe, expect, it } from "vitest";
import type { ModelPrice } from "@agent-board/db";
import type { InsightAttemptRow } from "../../lib/insights";
import { buildDailyTrend, trendValue } from "./trend";

const PRICES: ModelPrice[] = [
  { model: "opus-5", label: "opus-5", inputPerMtok: 5, outputPerMtok: 25, cachePerMtok: 0.5, cacheWritePerMtok: 0.5 },
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
    organizationId: "o1",
    projectId: "p1",
    projectName: "proj",
    missionId: null,
    missionTitle: null,
    resolvedIn: null,
    taskUpdatedAt: new Date(0),
    taskCreatedAt: new Date(0),
    model: "claude-opus-5",
    executor: "claude-code",
    modelSource: null,
    result: "success",
    finishedAt: new Date(Date.UTC(2026, 7, 10, 15)),
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
        row({ attemptId: "a2", finishedAt: new Date(Date.UTC(2026, 7, 10, 20)) }),
        row({ attemptId: "a3", finishedAt: new Date(Date.UTC(2026, 7, 12, 12)) }),
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

  it("buckets by the workspace's day, not the server's (E7 review)", () => {
    // 01:30 UTC on 4 August is still 3 August in São Paulo
    const late = row({ finishedAt: new Date(Date.UTC(2026, 7, 4, 1, 30)) });
    const br = buildDailyTrend([late], { prices: [], pricingEnabled: false, lang: "pt-BR" });
    const en = buildDailyTrend([late], { prices: [], pricingEnabled: false, lang: "en" });
    expect(br.points[0].dayKey).toBe("2026-08-03");
    expect(br.points[0].label).toBe("3/8");
    expect(en.points[0].dayKey).toBe("2026-08-04");
    expect(en.points[0].label).toBe("8/4");
  });

  it("zero-fills across a month end without skipping or doubling a day", () => {
    const trend = buildDailyTrend(
      [
        row({ finishedAt: new Date(Date.UTC(2026, 7, 30, 15)) }),
        row({ attemptId: "a2", finishedAt: new Date(Date.UTC(2026, 8, 2, 15)) }),
      ],
      { prices: [], pricingEnabled: false, lang: "pt-BR" },
    );
    expect(trend.points.map((p) => p.dayKey)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});
