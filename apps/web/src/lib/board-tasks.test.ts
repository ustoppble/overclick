import { task, user, type Database } from "@agent-board/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  adminPrincipal,
  closeTestWorld,
  createTestWorld,
  type TestWorld,
} from "../mcp/test-db";
import type { BoardPeriod, BoardPeriodField } from "./board-filter";
import {
  findBoardTaskByShortId,
  loadBoardTasks,
  searchBoardTaskIds,
} from "./board-tasks";
import type { Principal } from "./scope";

const DAY = 86_400_000;
const NOW = new Date("2026-11-03T12:00:00Z");

describe("board window", () => {
  let world: TestWorld;
  let seq = 0;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  function database(): Database {
    return world.db as unknown as Database;
  }

  async function card(
    title: string,
    status: "aberto" | "em_execucao" | "feito" | "validado" | "descartado",
    ageDays: number,
    createdByUserId: string | null = world.adminUserId,
    extra: Partial<typeof task.$inferInsert> = {},
  ) {
    seq += 1;
    const at = new Date(NOW.getTime() - ageDays * DAY);
    const [row] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        shortId: `OC-${seq}`,
        title,
        status,
        createdByUserId,
        createdAt: at,
        updatedAt: at,
        ...extra,
      })
      .returning({ id: task.id, shortId: task.shortId });
    if (!row) throw new Error("card not inserted");
    return row;
  }

  async function memberPrincipal(): Promise<Principal> {
    const [row] = await world.db
      .insert(user)
      .values({
        email: "member@example.test",
        passwordHash: "x",
        role: "member",
        organizationId: world.organizationId,
      })
      .returning({ id: user.id });
    if (!row) throw new Error("member not inserted");
    return { userId: row.id, role: "member", organizationId: world.organizationId };
  }

  it("finds an old done card through the search and the short id link", async () => {
    world = await createTestWorld();
    const old = await card("Review queue stuck forever", "feito", 200);
    await card("Unrelated", "feito", 200);

    const hits = await searchBoardTaskIds(
      database(),
      world.workspaceId,
      adminPrincipal(world),
      "stuck forever",
    );
    expect(hits).toEqual([old.id]);
    const linked = await findBoardTaskByShortId(
      database(),
      [world.projectId],
      adminPrincipal(world),
      old.shortId,
    );
    expect(linked?.id).toBe(old.id);
  });

  it("finds an old card through the server search", async () => {
    world = await createTestWorld();
    const old = await card("Terminal panes go black", "validado", 300);
    await card("Unrelated", "validado", 300);

    const ids = await searchBoardTaskIds(
      database(),
      world.workspaceId,
      adminPrincipal(world),
      "black panes",
    );
    expect(ids).toEqual([old.id]);
    const byShortId = await searchBoardTaskIds(
      database(),
      world.workspaceId,
      adminPrincipal(world),
      old.shortId.toLowerCase(),
    );
    expect(byShortId).toEqual([old.id]);
  });

  it("opens a card outside the window by its short id", async () => {
    world = await createTestWorld();
    const old = await card("validated long ago", "validado", 90);

    const found = await findBoardTaskByShortId(
      database(),
      [world.projectId],
      adminPrincipal(world),
      old.shortId,
    );
    expect(found?.id).toBe(old.id);
  });

  it("opens the current owner of a recycled short id, not the card that once had it", async () => {
    world = await createTestWorld();
    // The former holder is inserted first, so a bare limit 1 would pick it.
    const former = await card("moved away", "validado", 90, world.adminUserId, {
      previousShortIds: ["ZZ-1"],
    });
    const owner = await card("owns it now", "validado", 90, world.adminUserId, {
      shortId: "ZZ-1",
    });

    const found = await findBoardTaskByShortId(
      database(),
      [world.projectId],
      adminPrincipal(world),
      "zz-1",
    );
    expect(found?.id).toBe(owner.id);
    expect(found?.id).not.toBe(former.id);
    // With no current owner, the old link still lands on the card that moved.
    const onlyFormer = await findBoardTaskByShortId(
      database(),
      [world.projectId],
      adminPrincipal(world),
      "OLD-7",
    );
    expect(onlyFormer).toBeNull();
    const moved = await card("renumbered", "validado", 90, world.adminUserId, {
      previousShortIds: ["OLD-7"],
    });
    const viaOld = await findBoardTaskByShortId(
      database(),
      [world.projectId],
      adminPrincipal(world),
      "old-7",
    );
    expect(viaOld?.id).toBe(moved.id);
  });

  describe("the period filter", () => {
    async function mixed() {
      world = await createTestWorld();
      await card("open today", "aberto", 0);
      await card("open 10 days", "aberto", 10);
      await card("open ancient", "aberto", 200);
      await card("running 20 days", "em_execucao", 20);
      await card("done 3 days", "feito", 3);
      await card("done 60 days", "feito", 60);
      await card("validated 12 days", "validado", 12);
      await card("discarded 40 days", "descartado", 40);
    }

    const titles = async (period?: BoardPeriod, periodBy?: BoardPeriodField) =>
      (
        await loadBoardTasks(database(), [world.projectId], adminPrincipal(world), {
          now: NOW,
          ...(period ? { period } : {}),
          ...(periodBy ? { periodBy } : {}),
        })
      )
        .map((row) => row.title)
        .sort();

    it("defaults to the last 7 days, by last activity, in every column", async () => {
      await mixed();
      expect(await titles()).toEqual(["done 3 days", "open today"]);
    });

    it("widens to 14 and 30 days, open and running columns included", async () => {
      await mixed();
      expect(await titles("14d")).toEqual([
        "done 3 days",
        "open 10 days",
        "open today",
        "validated 12 days",
      ]);
      expect(await titles("30d")).toEqual([
        "done 3 days",
        "open 10 days",
        "open today",
        "running 20 days",
        "validated 12 days",
      ]);
    });

    it("with all time loads every card of every column, old finished ones included", async () => {
      await mixed();
      expect(await titles("all")).toEqual([
        "discarded 40 days",
        "done 3 days",
        "done 60 days",
        "open 10 days",
        "open ancient",
        "open today",
        "running 20 days",
        "validated 12 days",
      ]);
    });

    describe("by the date it reads", () => {
      // Created long ago and touched today, created this week, created and
      // touched three weeks ago: the three cases the two dates disagree on.
      async function dated() {
        world = await createTestWorld();
        await card("old, touched today", "feito", 60, world.adminUserId, {
          updatedAt: new Date(NOW.getTime() - 2 * 3_600_000),
        });
        await card("new this week", "aberto", 2);
        await card("three weeks", "validado", 20);
      }

      it("reads the last activity by default (Updated)", async () => {
        await dated();
        expect(await titles("7d")).toEqual(["new this week", "old, touched today"]);
        expect(await titles("7d", "updated")).toEqual(["new this week", "old, touched today"]);
      });

      it("reads when the card was created when asked (Created)", async () => {
        await dated();
        expect(await titles("7d", "created")).toEqual(["new this week"]);
        expect(await titles("30d", "created")).toEqual(["new this week", "three weeks"]);
        expect(await titles("all", "created")).toEqual([
          "new this week",
          "old, touched today",
          "three weeks",
        ]);
      });
    });

    it("still finds a card of any age by search and by link, whatever the period", async () => {
      world = await createTestWorld();
      const old = await card("Ancient open regression", "aberto", 400);
      expect(await titles()).toEqual([]);
      expect(
        await searchBoardTaskIds(database(), world.workspaceId, adminPrincipal(world), "regression"),
      ).toEqual([old.id]);
      expect(
        (await findBoardTaskByShortId(database(), [world.projectId], adminPrincipal(world), old.shortId))
          ?.id,
      ).toBe(old.id);
    });

    it("gives a member the same periods over their own cards only", async () => {
      world = await createTestWorld();
      const member = await memberPrincipal();
      await card("admin recent", "aberto", 1);
      await card("member recent", "aberto", 1, member.userId);
      await card("member old", "aberto", 100, member.userId);
      await card("admin old", "aberto", 100);

      const week = await loadBoardTasks(database(), [world.projectId], member, { now: NOW });
      expect(week.map((row) => row.title)).toEqual(["member recent"]);
      const created = await loadBoardTasks(database(), [world.projectId], member, {
        now: NOW,
        periodBy: "created",
      });
      expect(created.map((row) => row.title)).toEqual(["member recent"]);
      const everything = await loadBoardTasks(database(), [world.projectId], member, {
        now: NOW,
        period: "all",
      });
      expect(everything.map((row) => row.title).sort()).toEqual(["member old", "member recent"]);
    });
  });

  it("never shows a member the admin's cards: window, search, link", async () => {
    world = await createTestWorld();
    const member = await memberPrincipal();
    await card("admin open", "aberto", 1);
    const adminOld = await card("admin secret black", "validado", 30);
    await card("member open", "aberto", 1, member.userId);
    const memberOld = await card("member black", "validado", 30, member.userId);
    const adminDone = await card("admin done stale", "feito", 30);
    const memberDone = await card("member done stale", "feito", 30, member.userId);

    const week = await loadBoardTasks(database(), [world.projectId], member, { now: NOW });
    expect(week.map((row) => row.title)).toEqual(["member open"]);

    const everything = await loadBoardTasks(database(), [world.projectId], member, {
      now: NOW,
      period: "all",
    });
    expect(everything.map((row) => row.id).sort()).toEqual(
      [memberDone.id, memberOld.id, week[0]!.id].sort(),
    );
    expect(
      await findBoardTaskByShortId(database(), [world.projectId], member, adminDone.shortId),
    ).toBeNull();

    const hits = await searchBoardTaskIds(database(), world.workspaceId, member, "black");
    expect(hits).toEqual([memberOld.id]);
    expect(
      await searchBoardTaskIds(database(), world.workspaceId, member, adminOld.shortId),
    ).toEqual([]);

    expect(
      await findBoardTaskByShortId(database(), [world.projectId], member, adminOld.shortId),
    ).toBeNull();
  });
});
