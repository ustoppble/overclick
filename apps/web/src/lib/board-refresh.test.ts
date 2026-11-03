import { describe, expect, it, vi } from "vitest";
import {
  BOARD_REFRESH_INTERVAL_MS,
  BOARD_REFRESH_MAX_AGE_MS,
  subscribeToBoardRefresh,
} from "./board-refresh";

function harness(initialVisibility: DocumentVisibilityState = "visible") {
  let visibilityState = initialVisibility;
  let visibilityListener: (() => void) | null = null;
  let intervalCallback: (() => unknown) | null = null;

  const doc = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: vi.fn((_event: string, listener: () => void) => {
      visibilityListener = listener;
    }),
    removeEventListener: vi.fn((_event: string, listener: () => void) => {
      if (visibilityListener === listener) visibilityListener = null;
    }),
  } as unknown as Document;

  const clock = {
    setInterval: vi.fn((callback: () => unknown) => {
      intervalCallback = callback;
      return 17;
    }),
    clearInterval: vi.fn(),
  };

  return {
    doc,
    clock,
    tick: () => intervalCallback?.(),
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      visibilityListener?.();
    },
  };
}

describe("board refresh subscription", () => {
  it("refreshes a visible board on the regular cadence", () => {
    const refresh = vi.fn();
    const host = harness();

    const unsubscribe = subscribeToBoardRefresh({ refresh }, host.doc, host.clock);

    expect(host.clock.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      BOARD_REFRESH_INTERVAL_MS,
    );
    host.tick();
    expect(refresh).toHaveBeenCalledOnce();

    unsubscribe();
    expect(host.clock.clearInterval).toHaveBeenCalledWith(17);
  });

  it("pauses while hidden and refreshes immediately when visible again", () => {
    const refresh = vi.fn();
    const host = harness("hidden");

    subscribeToBoardRefresh({ refresh }, host.doc, host.clock);
    expect(host.clock.setInterval).not.toHaveBeenCalled();

    host.setVisibility("visible");
    expect(refresh).toHaveBeenCalledOnce();
    expect(host.clock.setInterval).toHaveBeenCalledOnce();

    host.setVisibility("hidden");
    expect(host.clock.clearInterval).toHaveBeenCalledWith(17);
  });

  it("polls every 20 seconds, not every 5", () => {
    expect(BOARD_REFRESH_INTERVAL_MS).toBe(20_000);
  });

  it("skips a tick while the previous refresh has not finished", () => {
    const refresh = vi.fn();
    let busy = false;
    const host = harness();

    subscribeToBoardRefresh({ refresh, isBusy: () => busy }, host.doc, host.clock);

    host.tick();
    expect(refresh).toHaveBeenCalledTimes(1);

    // The first refresh is still in flight: three more ticks pile up nothing.
    busy = true;
    host.tick();
    host.tick();
    host.tick();
    expect(refresh).toHaveBeenCalledTimes(1);

    busy = false;
    host.tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh on coming back to the tab while one is in flight", () => {
    const refresh = vi.fn();
    const host = harness("hidden");

    subscribeToBoardRefresh({ refresh, isBusy: () => true }, host.doc, host.clock);
    host.setVisibility("visible");

    expect(refresh).not.toHaveBeenCalled();
    // The cadence still resumes, so the next free tick refreshes.
    expect(host.clock.setInterval).toHaveBeenCalledOnce();
  });
});

describe("board refresh by signature", () => {
  function setup(options: { held?: string | null; signature?: () => Promise<string | null | { limited: true }> } = {}) {
    const refresh = vi.fn();
    const host = harness();
    let clockNow = 1_000_000;
    let held = options.held === undefined ? "a" : options.held;
    const signature = vi.fn(options.signature ?? (async () => "a"));
    subscribeToBoardRefresh(
      { refresh, signature, held: () => held, now: () => clockNow },
      host.doc,
      host.clock,
    );
    return {
      refresh,
      signature,
      host,
      hold: (next: string | null) => {
        held = next;
      },
      advance: (ms: number) => {
        clockNow += ms;
      },
    };
  }

  it("asks for the signature, not for the page, and leaves the page alone when it matches", async () => {
    const run = setup();
    await run.host.tick();
    expect(run.signature).toHaveBeenCalledOnce();
    expect(run.refresh).not.toHaveBeenCalled();
  });

  it("refreshes when the signature differs from the one the page was built with", async () => {
    const run = setup({ signature: async () => "b" });
    await run.host.tick();
    expect(run.refresh).toHaveBeenCalledOnce();
  });

  it("refreshes when the signature cannot be read, so a lost session still lands on the login", async () => {
    const failing = setup({ signature: async () => null });
    await failing.host.tick();
    expect(failing.refresh).toHaveBeenCalledOnce();

    const throwing = setup({
      signature: async () => {
        throw new Error("network");
      },
    });
    await throwing.host.tick();
    expect(throwing.refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh when the server says the poll was too often, and asks again at the next tick", async () => {
    let answer: string | { limited: true } = { limited: true };
    const run = setup({ held: "a", signature: async () => answer });
    await run.host.tick();
    expect(run.refresh).not.toHaveBeenCalled();

    // Not even a stale board is rebuilt on a refusal: the page asks again soon.
    run.advance(BOARD_REFRESH_MAX_AGE_MS);
    await run.host.tick();
    expect(run.refresh).not.toHaveBeenCalled();

    answer = "b";
    await run.host.tick();
    expect(run.signature).toHaveBeenCalledTimes(3);
    expect(run.refresh).toHaveBeenCalledOnce();
  });

  it("refreshes an unchanged board once it is older than the max age", async () => {
    const run = setup();
    run.advance(BOARD_REFRESH_MAX_AGE_MS - 1);
    await run.host.tick();
    expect(run.refresh).not.toHaveBeenCalled();

    run.advance(1);
    await run.host.tick();
    expect(run.refresh).toHaveBeenCalledOnce();

    // The age starts over with that refresh.
    await run.host.tick();
    expect(run.refresh).toHaveBeenCalledOnce();
  });

  it("does not ask twice while the first answer is on its way", async () => {
    let answer: (value: string) => void = () => {};
    const run = setup({
      signature: () => new Promise<string>((resolve) => (answer = resolve)),
    });
    const first = run.host.tick();
    await run.host.tick();
    expect(run.signature).toHaveBeenCalledOnce();

    answer("b");
    await first;
    expect(run.refresh).toHaveBeenCalledOnce();
  });

  it("does not even ask while a refresh is in flight", async () => {
    const refresh = vi.fn();
    const signature = vi.fn(async () => "b");
    const host = harness();
    subscribeToBoardRefresh(
      { refresh, signature, held: () => "a", isBusy: () => true },
      host.doc,
      host.clock,
    );
    await host.tick();
    expect(signature).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("checks the signature on coming back to the tab instead of reloading the page", async () => {
    const refresh = vi.fn();
    const signature = vi.fn(async () => "a");
    const host = harness("hidden");
    subscribeToBoardRefresh(
      { refresh, signature, held: () => "a" },
      host.doc,
      host.clock,
    );
    host.setVisibility("visible");
    await vi.waitFor(() => expect(signature).toHaveBeenCalledOnce());
    expect(refresh).not.toHaveBeenCalled();
  });
});
