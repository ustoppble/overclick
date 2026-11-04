import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_SIGNATURE_MAX_PER_MINUTE,
  globalBarCountsLimiter,
} from "../lib/board-signature-guard";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

/**
 * The E1 review (M2): the bar's 60 s poll is callable by any signed-in
 * session, like the board's signature, so it is held to the same limiter.
 */

let world: TestWorld;
let sessionUserId = "";

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

vi.mock("../lib/cookies", () => ({
  getSession: async () =>
    sessionUserId
      ? { userId: sessionUserId, sessionVersion: 1, email: "who@example.test" }
      : null,
}));

const { globalBarCountsAction } = await import("./global-bar");

describe("the global bar's counts are rate limited like the board's signature (M2)", () => {
  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
    globalBarCountsLimiter.reset();
  });

  afterEach(async () => {
    sessionUserId = "";
    globalBarCountsLimiter.reset();
    if (world) await closeTestWorld(world);
  });

  it("answers the counts while the person is under the minute's allowance", async () => {
    expect(await globalBarCountsAction()).toEqual({ running: 0, review: 0 });
  });

  it("answers nothing once a person has asked twelve times in a minute, and the bar keeps what it had", async () => {
    for (let i = 0; i < BOARD_SIGNATURE_MAX_PER_MINUTE; i += 1) {
      expect(await globalBarCountsAction()).toEqual({ running: 0, review: 0 });
    }
    expect(await globalBarCountsAction()).toBeNull();
  });

  it("answers nothing while another poll of the same person is still in flight", async () => {
    const held = globalBarCountsLimiter.acquire(world.adminUserId);
    expect(held.ok).toBe(true);
    expect(await globalBarCountsAction()).toBeNull();
    if (held.ok) held.release();
    expect(await globalBarCountsAction()).toEqual({ running: 0, review: 0 });
  });
});
