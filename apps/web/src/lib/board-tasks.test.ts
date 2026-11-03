import { task, user, type Database } from "@agent-board/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  adminPrincipal,
  closeTestWorld,
  createTestWorld,
  type TestWorld,
} from "../mcp/test-db";
import type { BoardFilter } from "./board-filter";
import {
  BOARD_PAGE_SIZE,
  countBoardColumns,
  findBoardTaskByShortId,
  loadBoardTasks,
  loadOlderBoardTasks,
  searchBoardTaskIds,
} from "./board-tasks";
import type { Principal } from "./scope";

const DAY = 86_400_000;
const NOW = new Date("2026-11-03T12:00:00Z");
const ALL: BoardFilter = {
  organizationIds: [],
  projectIds: [],
  missionId: null,
  types: [],
  priorities: [],
};

describe("board window", () => {
  let world: TestWorld;
  let seq = 0;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  function database(): Database {
    return world.db as unknown as Database;
  }

  function projects() {
    return [{ id: world.projectId, organizationId: world.organizationId }];
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

  it("always loads open and running cards, however old", async () => {
    world = await createTestWorld();
    await card("open and ancient", "aberto", 120);
    await card("running for weeks", "em_execucao", 40);

    const rows = await loadBoardTasks(
      database(),
      [world.projectId],
      adminPrincipal(world),
      { now: NOW, period: "all" },
    );
    expect(rows.map((row) => row.title).sort()).toEqual([
      "open and ancient",
      "running for weeks",
    ]);
  });

  it("keeps done cards only from the last 7 days, like validated and discarded", async () => {
    world = await createTestWorld();
    await card("done today", "feito", 0);
    await card("done 6 days ago", "feito", 6);
    await card("done a month ago", "feito", 30);
    await card("done a year ago", "feito", 365);

    const rows = await loadBoardTasks(
      database(),
      [world.projectId],
      adminPrincipal(world),
      { now: NOW, period: "all" },
    );
    expect(rows.map((row) => row.title).sort()).toEqual([
      "done 6 days ago",
      "done today",
    ]);
  });

  it("hands older done cards out 50 at a time, and counts the whole column", async () => {
    world = await createTestWorld();
    await card("done yesterday", "feito", 1);
    for (let i = 0; i < BOARD_PAGE_SIZE + 3; i += 1) {
      await card(`stale ${i}`, "feito", 10 + i);
    }

    const first = await loadOlderBoardTasks(
      database(),
      projects(),
      adminPrincipal(world),
      { status: "feito", filter: ALL, before: null },
    );
    expect(first.tasks).toHaveLength(BOARD_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(first.tasks.every((row) => row.status === "feito")).toBe(true);

    const last = first.tasks.at(-1)!;
    const second = await loadOlderBoardTasks(
      database(),
      projects(),
      adminPrincipal(world),
      {
        status: "feito",
        filter: ALL,
        before: { updatedAt: last.updatedAt.toISOString(), id: last.id },
      },
    );
    expect(second.tasks).toHaveLength(BOARD_PAGE_SIZE + 4 - BOARD_PAGE_SIZE);
    expect(second.hasMore).toBe(false);

    // The head still shows the real total, not the 1 card the window holds.
    const counts = await countBoardColumns(
      database(),
      projects(),
      adminPrincipal(world),
      { ...ALL, period: "all" },
      { now: NOW },
    );
    expect(counts.counts.feito).toBe(BOARD_PAGE_SIZE + 4);
  });

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

  it("keeps validated and discarded cards only from the last 7 days", async () => {
    world = await createTestWorld();
    await card("validated yesterday", "validado", 1);
    await card("validated last month", "validado", 30);
    await card("discarded today", "descartado", 0);
    await card("discarded long ago", "descartado", 90);

    const rows = await loadBoardTasks(
      database(),
      [world.projectId],
      adminPrincipal(world),
      { now: NOW, period: "all" },
    );
    expect(rows.map((row) => row.title).sort()).toEqual([
      "discarded today",
      "validated yesterday",
    ]);
  });

  it("hands older finished cards out 50 at a time, newest change first", async () => {
    world = await createTestWorld();
    await card("validated yesterday", "validado", 1);
    for (let i = 0; i < BOARD_PAGE_SIZE + 3; i += 1) {
      await card(`old ${i}`, "validado", 10 + i);
    }
    await card("old discarded", "descartado", 20);

    const first = await loadOlderBoardTasks(
      database(),
      projects(),
      adminPrincipal(world),
      { status: "validado", filter: ALL, before: null },
    );
    expect(first.tasks).toHaveLength(BOARD_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    // Newest change first: the first page starts where the window ended.
    expect(first.tasks[0]?.title).toBe("validated yesterday");
    expect(first.tasks.every((row) => row.status === "validado")).toBe(true);

    const last = first.tasks.at(-1)!;
    const second = await loadOlderBoardTasks(
      database(),
      projects(),
      adminPrincipal(world),
      {
        status: "validado",
        filter: ALL,
        before: { updatedAt: last.updatedAt.toISOString(), id: last.id },
      },
    );
    expect(second.tasks.map((row) => row.title)).toEqual([
      "old 49",
      "old 50",
      "old 51",
      "old 52",
    ]);
    expect(second.hasMore).toBe(false);
  });

  it("pages older cards inside the board filter", async () => {
    world = await createTestWorld();
    await card("old bug", "validado", 30, world.adminUserId, { tipo: "bug" });
    await card("old feature", "validado", 31, world.adminUserId, { tipo: "feature" });

    const page = await loadOlderBoardTasks(
      database(),
      projects(),
      adminPrincipal(world),
      { status: "validado", filter: { ...ALL, types: ["bug"] }, before: null },
    );
    expect(page.tasks.map((row) => row.title)).toEqual(["old bug"]);
  });

  it("counts every card of each column, not only the loaded ones", async () => {
    world = await createTestWorld();
    await card("open", "aberto", 100);
    await card("validated yesterday", "validado", 1);
    await card("validated long ago", "validado", 60);
    await card("validated longer ago", "validado", 200);
    await card("discarded long ago", "descartado", 50);

    const counts = await countBoardColumns(
      database(),
      projects(),
      adminPrincipal(world),
      { ...ALL, period: "all" },
      { now: NOW },
    );
    expect(counts.counts).toEqual({
      aberto: 1,
      em_execucao: 0,
      feito: 0,
      validado: 3,
      descartado: 1,
    });
    expect(counts.older).toEqual({
      aberto: 0,
      em_execucao: 0,
      feito: 0,
      validado: 0,
      descartado: 0,
    });
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

    const titles = async (period?: "7d" | "14d" | "30d" | "all") =>
      (
        await loadBoardTasks(database(), [world.projectId], adminPrincipal(world), {
          now: NOW,
          ...(period ? { period } : {}),
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

    it("with all time keeps the v0.4.2 window and the cut of old done cards", async () => {
      await mixed();
      expect(await titles("all")).toEqual([
        "done 3 days",
        "open 10 days",
        "open ancient",
        "open today",
        "running 20 days",
      ]);
    });

    it("counts each column inside the period, and what lies beyond it", async () => {
      await mixed();
      const week = await countBoardColumns(database(), projects(), adminPrincipal(world), ALL, {
        now: NOW,
      });
      expect(week.counts).toEqual({
        aberto: 1,
        em_execucao: 0,
        feito: 1,
        validado: 0,
        descartado: 0,
      });
      expect(week.older).toEqual({
        aberto: 2,
        em_execucao: 1,
        feito: 1,
        validado: 1,
        descartado: 1,
      });
      const month = await countBoardColumns(
        database(),
        projects(),
        adminPrincipal(world),
        { ...ALL, period: "30d" },
        { now: NOW },
      );
      expect(month.counts.aberto).toBe(2);
      expect(month.older.aberto).toBe(1);
      const everything = await countBoardColumns(
        database(),
        projects(),
        adminPrincipal(world),
        { ...ALL, period: "all" },
        { now: NOW },
      );
      expect(everything.counts.aberto).toBe(3);
      expect(everything.older.aberto).toBe(0);
    });

    it("pages the open column's cards past the period, newest change first", async () => {
      await mixed();
      const inWindow = await loadBoardTasks(database(), [world.projectId], adminPrincipal(world), {
        now: NOW,
      });
      const oldestOpen = inWindow.filter((row) => row.status === "aberto").at(-1)!;
      const page = await loadOlderBoardTasks(database(), projects(), adminPrincipal(world), {
        status: "aberto",
        filter: ALL,
        before: { updatedAt: oldestOpen.updatedAt.toISOString(), id: oldestOpen.id },
      });
      expect(page.tasks.map((row) => row.title)).toEqual(["open 10 days", "open ancient"]);
      expect(page.hasMore).toBe(false);
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
      const counts = await countBoardColumns(database(), projects(), member, ALL, { now: NOW });
      expect(counts.counts.aberto).toBe(1);
      expect(counts.older.aberto).toBe(1);
      const older = await loadOlderBoardTasks(database(), projects(), member, {
        status: "aberto",
        filter: ALL,
        before: null,
      });
      expect(older.tasks.map((row) => row.title).sort()).toEqual(["member old", "member recent"]);
    });
  });

  it("never shows a member the admin's cards: window, older pages, counts, search, link", async () => {
    world = await createTestWorld();
    const member = await memberPrincipal();
    await card("admin open", "aberto", 1);
    const adminOld = await card("admin secret black", "validado", 30);
    await card("member open", "aberto", 1, member.userId);
    const memberOld = await card("member black", "validado", 30, member.userId);
    const adminDone = await card("admin done stale", "feito", 30);
    const memberDone = await card("member done stale", "feito", 30, member.userId);

    const window = await loadBoardTasks(database(), [world.projectId], member, { now: NOW, period: "all" });
    expect(window.map((row) => row.title)).toEqual(["member open"]);

    const older = await loadOlderBoardTasks(database(), projects(), member, {
      status: "validado",
      filter: ALL,
      before: null,
    });
    expect(older.tasks.map((row) => row.id)).toEqual([memberOld.id]);

    const counts = await countBoardColumns(database(), projects(), member, { ...ALL, period: "all" }, { now: NOW });
    expect(counts.counts.aberto).toBe(1);
    expect(counts.counts.validado).toBe(1);
    expect(counts.counts.feito).toBe(1);

    const olderDone = await loadOlderBoardTasks(database(), projects(), member, {
      status: "feito",
      filter: ALL,
      before: null,
    });
    expect(olderDone.tasks.map((row) => row.id)).toEqual([memberDone.id]);
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
