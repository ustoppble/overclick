import { describe, expect, it } from "vitest";
import { onRestoredFromCache } from "./restore";

/**
 * E4 review, item 4: changing the scope disables the picker while the page
 * goes. Back to it from the browser's cache (bfcache) brings the page back
 * frozen as it left — the picker must come back usable.
 */
describe("onRestoredFromCache", () => {
  function fakeWindow() {
    const listeners = new Map<string, (event: { persisted?: boolean }) => void>();
    return {
      addEventListener: (type: string, fn: (event: { persisted?: boolean }) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      fire: (type: string, event: { persisted?: boolean }) => listeners.get(type)?.(event),
      listeners,
    };
  }

  it("calls back when the page comes back from the cache, not on a fresh load", () => {
    const target = fakeWindow();
    let calls = 0;
    const stop = onRestoredFromCache(target as never, () => calls++);
    target.fire("pageshow", { persisted: false });
    expect(calls).toBe(0);
    target.fire("pageshow", { persisted: true });
    expect(calls).toBe(1);
    stop();
    expect(target.listeners.size).toBe(0);
  });
});
