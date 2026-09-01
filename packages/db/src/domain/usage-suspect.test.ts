import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_TOKENS_PER_SECOND,
  MAX_TOTAL_TOKENS_PER_SECOND,
  MIN_USAGE_WINDOW_MS,
  checkUsageWindow,
} from "./usage-suspect";

describe("usage claim window guard", () => {
  it("accepts ordinary telemetry even when claim and delivery are very close", () => {
    expect(
      checkUsageWindow(
        { tokens_in: 20_000, tokens_out: 4_000, tokens_cache: 50_000 },
        25,
      ).suspect,
    ).toBe(false);
  });

  it("flags output that could not fit in the claim window", () => {
    const check = checkUsageWindow(
      { tokens_out: 5_000_000 },
      60_000,
    );
    expect(check.suspect).toBe(true);
    expect(check.outputTokens).toBe(5_000_000);
  });

  it("also guards aggregate input and cache throughput", () => {
    const justOver =
      (MIN_USAGE_WINDOW_MS / 1_000) * MAX_TOTAL_TOKENS_PER_SECOND + 1;
    expect(checkUsageWindow({ tokens_cache: justOver }, 1).suspect).toBe(true);
  });

  it("keeps the documented output ceiling stable", () => {
    expect(MAX_OUTPUT_TOKENS_PER_SECOND).toBe(2_000);
  });
});

/**
 * OCL-161. The ceiling is about work the machine had to do, and a cache read
 * is not that: it is a prefix that already exists being handed back. Counting
 * reads put the 50k ceiling at the 91st percentile of real runs and marked
 * 29% of the board suspect.
 */
describe("the window ignores cache reads", () => {
  const MINUTE = 60_000;

  it("clears a run that only read a large cache", () => {
    const check = checkUsageWindow(
      {
        segments: [
          { model: "opus-5", input: 20_000, output: 10_000, cache_read: 5_000_000 },
        ],
      },
      MINUTE,
    );
    expect(check.suspect).toBe(false);
  });

  it("still catches the same volume as real input", () => {
    const check = checkUsageWindow(
      { segments: [{ model: "opus-5", input: 5_000_000 }] },
      MINUTE,
    );
    expect(check.suspect).toBe(true);
  });

  it("still catches a cache the run had to build", () => {
    const check = checkUsageWindow(
      { segments: [{ model: "opus-5", cache_write: 5_000_000 }] },
      MINUTE,
    );
    expect(check.suspect).toBe(true);
  });

  it("keeps the old reading when there are no segments", () => {
    // The flat contract merges reads and writes into tokens_cache, so there is
    // no honest way to tell which half it was: the old behaviour stands.
    const check = checkUsageWindow({ tokens_cache: 5_000_000 }, MINUTE);
    expect(check.suspect).toBe(true);
  });
});
