import { user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBoardFilter } from "../lib/board-filter";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

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

const { setBoardFilterAction } = await import("./board-filter");

const base = {
  organizationIds: [],
  projectIds: [],
  missionId: null,
  types: [],
  priorities: [],
};

describe("the board period is saved like the other board filters", () => {
  const stored = async (userId = world.adminUserId) => {
    const [row] = await world.db
      .select({ period: user.boardPeriod })
      .from(user)
      .where(eq(user.id, userId));
    return row?.period;
  };

  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  it("starts with nothing stored, which reads as the last 7 days", async () => {
    const period = await stored();
    expect(period).toBeNull();
    expect(resolveBoardFilter({ projectId: "all", missionId: null, period }, [], []).period).toBe("7d");
  });

  it("stores the period the reader picked and reads it back on the next visit", async () => {
    for (const period of ["30d", "14d", "all", "7d"] as const) {
      expect(await setBoardFilterAction({ ...base, period })).toEqual({ ok: true });
      expect(await stored()).toBe(period);
      expect(
        resolveBoardFilter({ projectId: "all", missionId: null, period: await stored() }, [], []).period,
      ).toBe(period);
    }
  });

  it("saves the default when a filter arrives without a period", async () => {
    await setBoardFilterAction({ ...base, period: "all" });
    await setBoardFilterAction(base);
    expect(await stored()).toBe("7d");
  });

  it("refuses a period the board does not offer, 90 days included, and keeps the old one", async () => {
    await setBoardFilterAction({ ...base, period: "30d" });
    expect(await setBoardFilterAction({ ...base, period: "90d" as never })).toEqual({
      ok: false,
      error: "Period not found.",
    });
    expect(await stored()).toBe("30d");
  });

  it("keeps each person's period their own", async () => {
    const [member] = await world.db
      .insert(user)
      .values({
        email: "member@example.test",
        passwordHash: "x",
        role: "member",
        organizationId: world.organizationId,
      })
      .returning({ id: user.id });
    await setBoardFilterAction({ ...base, period: "all" });
    sessionUserId = member!.id;
    await setBoardFilterAction({ ...base, period: "14d" });
    expect(await stored(member!.id)).toBe("14d");
    expect(await stored(world.adminUserId)).toBe("all");
  });
});
