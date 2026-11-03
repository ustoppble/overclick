import { describe, expect, it } from "vitest";
import {
  BOARD_SEARCH_MAX_CHARS,
  BOARD_SEARCH_MAX_PER_MINUTE,
  BOARD_SEARCH_MAX_TERMS,
  createBoardSearchLimiter,
  normalizeBoardSearch,
} from "./board-search-guard";

describe("board search query", () => {
  it("trims and keeps an ordinary query as it is", () => {
    expect(normalizeBoardSearch("  black panes  ")).toBe("black panes");
  });

  it("refuses a query shorter than two characters", () => {
    expect(normalizeBoardSearch("a")).toBeNull();
    expect(normalizeBoardSearch("   ")).toBeNull();
    expect(normalizeBoardSearch("")).toBeNull();
    expect(normalizeBoardSearch(42)).toBeNull();
    expect(normalizeBoardSearch("ab")).toBe("ab");
  });

  it("cuts a query at 100 characters", () => {
    const long = "x".repeat(5000);
    expect(normalizeBoardSearch(long)).toHaveLength(BOARD_SEARCH_MAX_CHARS);
  });

  it("keeps only the first six terms", () => {
    const many = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
    const query = normalizeBoardSearch(many);
    expect(query?.split(/\s+/)).toHaveLength(BOARD_SEARCH_MAX_TERMS);
    expect(query).toBe("w0 w1 w2 w3 w4 w5");
  });

  it("leaves no trailing space after the cut", () => {
    expect(normalizeBoardSearch(`${"a".repeat(99)} bbbb`)).toBe("a".repeat(99));
  });
});

describe("board search limiter", () => {
  it("allows one search in flight per person", () => {
    const limiter = createBoardSearchLimiter();
    const first = limiter.acquire("u1", 0);
    expect(first).not.toBeNull();
    expect(limiter.acquire("u1", 1)).toBeNull();
    // Someone else is not held up by it.
    expect(limiter.acquire("u2", 1)).not.toBeNull();
    first?.();
    expect(limiter.acquire("u1", 2)).not.toBeNull();
  });

  it("allows 30 a minute and answers nothing to the 31st", () => {
    const limiter = createBoardSearchLimiter();
    for (let i = 0; i < BOARD_SEARCH_MAX_PER_MINUTE; i += 1) {
      const release = limiter.acquire("u1", i * 1000);
      expect(release).not.toBeNull();
      release?.();
    }
    expect(limiter.acquire("u1", 31_000)).toBeNull();
    // A minute after the first one, room opens again.
    expect(limiter.acquire("u1", 60_001)).not.toBeNull();
  });

  it("does not charge a refused search against the minute", () => {
    const limiter = createBoardSearchLimiter();
    const held = limiter.acquire("u1", 0);
    for (let i = 0; i < 100; i += 1) expect(limiter.acquire("u1", 1 + i)).toBeNull();
    held?.();
    expect(limiter.acquire("u1", 200)).not.toBeNull();
  });

  it("releases a slot only once", () => {
    const limiter = createBoardSearchLimiter();
    const release = limiter.acquire("u1", 0);
    release?.();
    release?.();
    const second = limiter.acquire("u1", 1);
    expect(second).not.toBeNull();
    expect(limiter.acquire("u1", 2)).toBeNull();
  });
});
