import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardSearchLimiter } from "./board-search-guard";
import {
  createBoardSearchRunner,
  type BoardSearchReply,
} from "./board-search-runner";

/**
 * A stand-in for the server action: the real limiter, and searches that stay
 * open until the test lets them go, so "a search in flight" is under control.
 */
function fakeServer(maxInFlight: number, perMinute = 30) {
  const limiter = createBoardSearchLimiter(perMinute, maxInFlight);
  const open: Array<() => void> = [];
  const asked: string[] = [];
  return {
    asked,
    async search(query: string): Promise<BoardSearchReply<string>> {
      const slot = limiter.acquire("u1");
      if (!slot.ok) return { query, cards: [], limited: slot.reason };
      asked.push(query);
      await new Promise<void>((resolve) => open.push(resolve));
      slot.release();
      return { query, cards: [`hit:${query}`] };
    },
    finishAll() {
      for (const resolve of open.splice(0)) resolve();
    },
    finishOldest() {
      open.shift()?.();
    },
  };
}

function watch() {
  const seen = { results: [] as Array<[string, string[]]>, states: [] as string[] };
  return {
    seen,
    handlers: {
      onResult: (query: string, cards: string[]) => seen.results.push([query, cards]),
      onState: (state: string) => seen.states.push(state),
    },
  };
}

describe("board search runner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ends up showing the second search when it ran while the first was open", async () => {
    // One slot, the old limiter: the case the review found.
    const server = fakeServer(1);
    const runner = createBoardSearchRunner<string>({ search: server.search });
    const { seen, handlers } = watch();

    const cancelFirst = runner.start("abc", handlers);
    await vi.advanceTimersByTimeAsync(0);
    cancelFirst();
    runner.start("abcd", handlers);
    await vi.advanceTimersByTimeAsync(0);

    // The server turned "abcd" away; the UI has not been told it is done.
    expect(seen.results).toEqual([]);
    expect(seen.states).toEqual(["searching", "searching"]);

    server.finishOldest();
    await vi.advanceTimersByTimeAsync(0);
    server.finishAll();
    await vi.advanceTimersByTimeAsync(0);

    expect(seen.results).toEqual([["abcd", ["hit:abcd"]]]);
    expect(seen.states.at(-1)).toBe("done");
  });

  it("retries the latest search after a short backoff when the first stays open", async () => {
    const server = fakeServer(1);
    const runner = createBoardSearchRunner<string>({ search: server.search });
    const { seen, handlers } = watch();

    runner.start("abc", handlers)();
    await vi.advanceTimersByTimeAsync(0);
    runner.start("abcd", handlers);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.asked).toEqual(["abc"]);

    // Still open at the backoff: the retry is refused again and waits more.
    await vi.advanceTimersByTimeAsync(300);
    expect(seen.results).toEqual([]);
    server.finishAll();
    await vi.advanceTimersByTimeAsync(300);
    server.finishAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.results).toEqual([["abcd", ["hit:abcd"]]]);
  });

  it("covers two tabs: a third search waits for a slot and then answers", async () => {
    const server = fakeServer(2);
    const runner = createBoardSearchRunner<string>({ search: server.search });
    const { seen, handlers } = watch();

    // Two other tabs hold both slots.
    void server.search("tab one");
    void server.search("tab two");
    await vi.advanceTimersByTimeAsync(0);

    runner.start("mine", handlers);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.results).toEqual([]);
    // Another tab finishes; this tab cannot see it, so the backoff brings the retry.
    server.finishOldest();
    await vi.advanceTimersByTimeAsync(300);
    server.finishAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.results).toEqual([["mine", ["hit:mine"]]]);
  });

  it("gives up after three retries and shows only the local results", async () => {
    const search = vi.fn(async (query: string) => ({
      query,
      cards: [] as string[],
      limited: "busy" as const,
    }));
    const runner = createBoardSearchRunner<string>({ search });
    const { seen, handlers } = watch();

    runner.start("abc", handlers);
    await vi.advanceTimersByTimeAsync(5000);

    expect(search).toHaveBeenCalledTimes(4);
    expect(seen.results).toEqual([]);
    expect(seen.states.at(-1)).toBe("limited");
  });

  it("does not retry when the minute is spent", async () => {
    const search = vi.fn(async (query: string) => ({
      query,
      cards: [] as string[],
      limited: "rate" as const,
    }));
    const runner = createBoardSearchRunner<string>({ search });
    const { seen, handlers } = watch();

    runner.start("abc", handlers);
    await vi.advanceTimersByTimeAsync(5000);

    expect(search).toHaveBeenCalledTimes(1);
    expect(seen.results).toEqual([]);
    expect(seen.states.at(-1)).toBe("limited");
  });

  it("stops retrying a search that was cancelled", async () => {
    const search = vi.fn(async (query: string) => ({
      query,
      cards: [] as string[],
      limited: "busy" as const,
    }));
    const runner = createBoardSearchRunner<string>({ search });
    const { seen, handlers } = watch();

    const cancel = runner.start("abc", handlers);
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    await vi.advanceTimersByTimeAsync(5000);

    expect(search).toHaveBeenCalledTimes(1);
    expect(seen.states).toEqual(["searching"]);
  });
});
