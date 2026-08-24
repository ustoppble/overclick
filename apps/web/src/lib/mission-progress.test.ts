import { describe, expect, it } from "vitest";
import { missionProgress } from "./mission-progress";

describe("mission progress (OCL-138)", () => {
  it("computes the % done and the 4-colour segmentation", () => {
    const progress = missionProgress({
      aberto: 3,
      em_execucao: 2,
      feito: 4,
      validado: 1,
    });

    expect(progress.total).toBe(10);
    expect(progress.done).toBe(5);
    expect(progress.pct).toBe(50);
    expect(progress.segments).toEqual([
      { status: "aberto", count: 3, pct: 30 },
      { status: "em_execucao", count: 2, pct: 20 },
      { status: "feito", count: 4, pct: 40 },
      { status: "validado", count: 1, pct: 10 },
    ]);
  });

  it("excludes descartado from both the total and the percentage", () => {
    // descartado is not part of MissionStatusCounts at all: a mission with
    // 2 feito, 1 validado and any number of discarded cards is 100% of what
    // it counts, because the discarded ones were never in the denominator.
    const progress = missionProgress({
      aberto: 0,
      em_execucao: 0,
      feito: 2,
      validado: 1,
    });

    expect(progress.total).toBe(3);
    expect(progress.pct).toBe(100);
  });

  it("is 0% on an empty mission, not NaN or a divide-by-zero", () => {
    const progress = missionProgress({
      aberto: 0,
      em_execucao: 0,
      feito: 0,
      validado: 0,
    });

    expect(progress.total).toBe(0);
    expect(progress.done).toBe(0);
    expect(progress.pct).toBe(0);
    for (const segment of progress.segments) {
      expect(segment.pct).toBe(0);
    }
  });

  it("rounds a % that does not divide evenly", () => {
    const progress = missionProgress({
      aberto: 1,
      em_execucao: 0,
      feito: 0,
      validado: 2,
    });

    // 2/3 = 66.67% -> rounds to 67
    expect(progress.pct).toBe(67);
  });

  it("is 100% once every counted card is feito or validado", () => {
    const progress = missionProgress({
      aberto: 0,
      em_execucao: 0,
      feito: 1,
      validado: 1,
    });

    expect(progress.pct).toBe(100);
  });
});
