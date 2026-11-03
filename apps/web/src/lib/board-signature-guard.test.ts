import { describe, expect, it } from "vitest";
import {
  BOARD_SIGNATURE_MAX_IN_FLIGHT,
  BOARD_SIGNATURE_MAX_PER_MINUTE,
  createBoardSignatureLimiter,
} from "./board-signature-guard";

describe("board signature limiter", () => {
  it("allows one poll at a time per person and says no to a second", () => {
    expect(BOARD_SIGNATURE_MAX_IN_FLIGHT).toBe(1);
    const limiter = createBoardSignatureLimiter();
    const first = limiter.acquire("u1", 0);
    expect(first.ok).toBe(true);
    expect(limiter.acquire("u1", 1)).toEqual({ ok: false, reason: "busy" });
    // Someone else is not held up by it.
    expect(limiter.acquire("u2", 1).ok).toBe(true);
    if (first.ok) first.release();
    expect(limiter.acquire("u1", 2).ok).toBe(true);
  });

  it("allows 12 a minute and says rate to the 13th", () => {
    expect(BOARD_SIGNATURE_MAX_PER_MINUTE).toBe(12);
    const limiter = createBoardSignatureLimiter();
    for (let i = 0; i < BOARD_SIGNATURE_MAX_PER_MINUTE; i += 1) {
      const slot = limiter.acquire("u1", i * 1000);
      expect(slot.ok).toBe(true);
      if (slot.ok) slot.release();
    }
    expect(limiter.acquire("u1", 13_000)).toEqual({ ok: false, reason: "rate" });
  });

  it("lets the ordinary cadence of three a minute through all day", () => {
    const limiter = createBoardSignatureLimiter();
    for (let i = 0; i < 500; i += 1) {
      const slot = limiter.acquire("u1", i * 20_000);
      expect(slot.ok).toBe(true);
      if (slot.ok) slot.release();
    }
  });

  it("counts the minute from the calls that were granted, not the refused ones", () => {
    const limiter = createBoardSignatureLimiter();
    for (let i = 0; i < 12; i += 1) {
      const slot = limiter.acquire("u1", i);
      if (slot.ok) slot.release();
    }
    for (let i = 0; i < 100; i += 1) limiter.acquire("u1", 100 + i);
    // The first call leaves the minute at 60 001; refused ones kept nothing.
    const again = limiter.acquire("u1", 60_000 + 11);
    expect(again.ok).toBe(true);
  });

  it("forgets people who stopped polling", () => {
    const limiter = createBoardSignatureLimiter();
    for (let i = 0; i < 50; i += 1) {
      const slot = limiter.acquire(`u${i}`, 0);
      if (slot.ok) slot.release();
    }
    expect(limiter.size()).toBe(50);
    const later = limiter.acquire("late", 61_000);
    if (later.ok) later.release();
    expect(limiter.size()).toBe(1);
  });

  it("does not keep an empty entry for a refused first call", () => {
    const limiter = createBoardSignatureLimiter(0);
    expect(limiter.acquire("u1", 0)).toEqual({ ok: false, reason: "rate" });
    expect(limiter.size()).toBe(0);
  });
});
