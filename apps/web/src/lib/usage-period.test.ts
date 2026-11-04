import { describe, expect, it } from "vitest";
import { attemptsInPeriod, missionAttemptsInPeriod } from "./usage-period";

/**
 * Navigation plan E4 (D6): the period reaches Consumo. The cost on top of the
 * board and the Consumo page its link opens count the same cards: the ones
 * the board's window holds, by the date the period reads.
 */
const NOW = new Date("2026-11-04T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const row = (id: string, updated: number, created: number) => ({
  attemptId: id,
  taskUpdatedAt: daysAgo(updated),
  taskCreatedAt: daysAgo(created),
});

describe("card attempts follow the card into or out of the period", () => {
  const rows = [row("fresh", 1, 40), row("month", 20, 20), row("old", 90, 90)];

  it("keeps the attempts of cards updated in the last 7 days by default", () => {
    expect(attemptsInPeriod(rows, {}, NOW).map((r) => r.attemptId)).toEqual(["fresh"]);
  });

  it("widens with the period and reads the creation date when asked", () => {
    expect(attemptsInPeriod(rows, { period: "30d" }, NOW).map((r) => r.attemptId)).toEqual([
      "fresh",
      "month",
    ]);
    expect(
      attemptsInPeriod(rows, { period: "30d", periodBy: "created" }, NOW).map((r) => r.attemptId),
    ).toEqual(["month"]);
  });

  it("keeps everything for all time", () => {
    expect(attemptsInPeriod(rows, { period: "all" }, NOW)).toHaveLength(3);
  });
});

describe("mission attempts, which have no card, go by their own dates", () => {
  const missions = [
    { attemptId: "running", startedAt: daysAgo(10), finishedAt: null },
    { attemptId: "finished", startedAt: daysAgo(10), finishedAt: daysAgo(2) },
    { attemptId: "old", startedAt: daysAgo(60), finishedAt: daysAgo(59) },
  ];

  it("reads the last activity as the finish, or the start while it runs", () => {
    expect(missionAttemptsInPeriod(missions, { period: "7d" }, NOW).map((r) => r.attemptId)).toEqual([
      "finished",
    ]);
    expect(
      missionAttemptsInPeriod(missions, { period: "14d" }, NOW).map((r) => r.attemptId),
    ).toEqual(["running", "finished"]);
  });

  it("reads the creation date as the start", () => {
    expect(
      missionAttemptsInPeriod(missions, { period: "7d", periodBy: "created" }, NOW).map((r) => r.attemptId),
    ).toEqual([]);
  });
});
