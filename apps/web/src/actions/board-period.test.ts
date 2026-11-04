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

describe("the date the period reads is saved the same way", () => {
  const stored = async () => {
    const [row] = await world.db
      .select({ periodBy: user.boardPeriodBy })
      .from(user)
      .where(eq(user.id, world.adminUserId));
    return row?.periodBy;
  };

  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  it("starts with nothing stored, which reads as the last activity", async () => {
    const periodBy = await stored();
    expect(periodBy).toBeNull();
    expect(
      resolveBoardFilter({ projectId: "all", missionId: null, periodBy }, [], []).periodBy,
    ).toBe("updated");
  });

  it("stores Created and Updated and reads them back on the next visit", async () => {
    for (const periodBy of ["created", "updated"] as const) {
      expect(await setBoardFilterAction({ ...base, periodBy })).toEqual({ ok: true });
      expect(await stored()).toBe(periodBy);
      expect(
        resolveBoardFilter({ projectId: "all", missionId: null, periodBy: await stored() }, [], [])
          .periodBy,
      ).toBe(periodBy);
    }
  });

  it("refuses a date the board does not offer and keeps the old one", async () => {
    await setBoardFilterAction({ ...base, periodBy: "created" });
    expect(await setBoardFilterAction({ ...base, periodBy: "closed" as never })).toEqual({
      ok: false,
      error: "Period date not found.",
    });
    expect(await stored()).toBe("created");
  });
});

describe("the board remembers only the scope and the period (navigation plan E4, F2)", () => {
  const remembered = async () => {
    const [row] = await world.db
      .select({
        organizationId: user.boardOrganizationId,
        projectId: user.boardProjectId,
        missionId: user.boardMissionId,
        types: user.boardTaskTypes,
        priorities: user.boardPriorities,
        resolvedIn: user.boardResolvedIn,
        period: user.boardPeriod,
        periodBy: user.boardPeriodBy,
      })
      .from(user)
      .where(eq(user.id, world.adminUserId));
    return row!;
  };

  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  it("stores the organization, the project, the period and its date", async () => {
    expect(
      await setBoardFilterAction({
        ...base,
        organizationIds: [world.organizationId],
        projectIds: [world.projectId],
        period: "30d",
        periodBy: "created",
      }),
    ).toEqual({ ok: true });
    const row = await remembered();
    expect(row.organizationId).toBe(world.organizationId);
    expect(row.projectId).toBe(world.projectId);
    expect(row.period).toBe("30d");
    expect(row.periodBy).toBe("created");
  });

  it("does not store the mission, the type, the priority nor the release", async () => {
    await setBoardFilterAction({
      ...base,
      missionId: world.missionId,
      types: ["bug"],
      priorities: ["alta"],
      resolvedIn: null,
    });
    const row = await remembered();
    expect(row.missionId).toBeNull();
    expect(row.types).toBeNull();
    expect(row.priorities).toBeNull();
    expect(row.resolvedIn).toBeNull();
  });

  it("leaves what an older release stored where it is, untouched and unread", async () => {
    await world.db
      .update(user)
      .set({ boardMissionId: world.missionId, boardTaskTypes: "bug" })
      .where(eq(user.id, world.adminUserId));
    await setBoardFilterAction({ ...base, period: "14d" });
    const row = await remembered();
    // The columns stay (the DROP is a card of its own); nothing writes them.
    expect(row.missionId).toBe(world.missionId);
    expect(row.types).toBe("bug");
    expect(row.period).toBe("14d");
  });
});

/** E4 review, item 5: the filter line writes the period, and only the period. */
describe("setBoardPeriodAction", () => {
  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
  });
  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  it("writes the period and leaves the remembered scope alone", async () => {
    const { setBoardPeriodAction } = await import("./board-filter");
    await world.db
      .update(user)
      .set({ boardOrganizationId: "all", boardProjectId: world.projectId })
      .where(eq(user.id, world.adminUserId));
    expect(await setBoardPeriodAction({ period: "30d", periodBy: "created" })).toEqual({ ok: true });
    const [row] = await world.db
      .select({ p: user.boardPeriod, by: user.boardPeriodBy, proj: user.boardProjectId, org: user.boardOrganizationId })
      .from(user)
      .where(eq(user.id, world.adminUserId));
    expect(row).toEqual({ p: "30d", by: "created", proj: world.projectId, org: "all" });
    expect(await setBoardPeriodAction({ period: "90d" as never, periodBy: "updated" })).toMatchObject({ ok: false });
  });
});
