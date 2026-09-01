import { describe, expect, it } from "vitest";
import {
  flattenUsageSegments,
  modelChain,
  normalizeUsageSegments,
  resolveUsageSegments,
  segmentModels,
  segmentTokenCounts,
  segmentTotalTokens,
} from "./usage";

describe("usage segments", () => {
  it("keeps the segments an executor reported, one per model", () => {
    const segments = normalizeUsageSegments(
      {
        segments: [
          { model: "sonnet-5", input: 100, output: 200, cache_read: 300 },
          { model: "opus-5", input: 10, output: 20, cache_write: 30 },
        ],
      },
      "sonnet-5",
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]?.model).toBe("sonnet-5");
    expect(segments[1]?.model).toBe("opus-5");
  });

  it("folds the flat legacy shape into a single segment for the running model", () => {
    const segments = normalizeUsageSegments(
      { tokens_in: 1_000, tokens_out: 2_000, tokens_cache: 3_000 },
      "opus-5",
    );

    expect(segments).toEqual([
      { model: "opus-5", input: 1_000, output: 2_000, cache_read: 3_000 },
    ]);
  });

  it("reports no segment when the usage block carries no token counter", () => {
    expect(normalizeUsageSegments({ }, "opus-5")).toEqual([]);
    expect(normalizeUsageSegments(null, "opus-5")).toEqual([]);
  });

  it("leaves the model null when nothing ever named one", () => {
    const segments = normalizeUsageSegments({ tokens_in: 5 }, null);
    expect(segments[0]?.model).toBeNull();
  });

  it("keeps a cache read and a cache write apart, since they price apart", () => {
    expect(
      segmentTokenCounts({
        model: "opus-5",
        input: 1,
        output: 2,
        cache_read: 4,
        cache_write: 8,
      }),
    ).toEqual({ input: 1, output: 2, cacheRead: 4, cacheWrite: 8 });
    expect(segmentTotalTokens({ model: "opus-5", input: 1, cache_write: 8 })).toBe(9);
  });

  it("flattens segments into the counters written before segments existed", () => {
    expect(
      flattenUsageSegments([
        { model: "sonnet-5", input: 100, output: 200, cache_read: 300 },
        { model: "opus-5", input: 10, output: 20, cache_write: 30 },
      ]),
    ).toEqual({ tokens_in: 110, tokens_out: 220, tokens_cache: 330 });
  });

  it("derives the flat totals from the segments when storing", () => {
    const stored = resolveUsageSegments(
      {
        tokens_in: 999_999,
        segments: [
          { model: "sonnet-5", input: 100, output: 200 },
          { model: "opus-5", input: 10, output: 20 },
        ],
        duration_ms: 60_000,
      },
      "sonnet-5",
    );

    expect(stored.tokens_in).toBe(110);
    expect(stored.tokens_out).toBe(220);
    expect(stored.tokens_cache).toBe(0);
    expect(stored.duration_ms).toBe(60_000);
    expect(stored.segments).toHaveLength(2);
  });

  it("leaves a usage block with no tokens alone instead of inventing zeros", () => {
    const stored = resolveUsageSegments({ duration_ms: 1_000, turns: 3 }, "opus-5");
    expect(stored.segments).toEqual([]);
    expect(stored.tokens_in).toBeUndefined();
  });

  it("names one model, or the chain a run walked", () => {
    expect(modelChain(["opus-5"])).toBe("opus-5");
    expect(modelChain(["sonnet-5", "opus-5"])).toBe("sonnet-5 to opus-5");
    expect(modelChain(["opus-5", "opus-5"])).toBe("opus-5");
    expect(modelChain([null])).toBeNull();
    expect(modelChain([])).toBeNull();
  });

  it("lists the models a run touched, in order, without repeating", () => {
    expect(
      segmentModels([
        { model: "sonnet-5" },
        { model: "opus-5" },
        { model: "sonnet-5" },
      ]),
    ).toEqual(["sonnet-5", "opus-5"]);
  });
});
