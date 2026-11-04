import { mission, task, user, type Database } from "@agent-board/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  adminPrincipal,
  closeTestWorld,
  createTestWorld,
  insertSideProject,
  linkProjects,
  type TestWorld,
} from "../mcp/test-db";
import { NO_MISSION } from "./board-filter";
import { boardQueryFromFilter, boardScopeProjectIds } from "./board-query";
import {
  BOARD_COLUMN_PAGE,
  decodeBoardCursor,
  findBoardTaskByShortId,
  loadBoardColumnPage,
  loadBoardColumns,
  loadBoardCounts,
  loadBoardTasksByIds,
  type BoardQuery,
} from "./board-tasks";
import type { Principal } from "./scope";

const DAY = 86_400_000;
const NOW = new Date("2026-11-03T12:00:00Z");

/**
 * The board hands each column over a page at a time (OCL board lazy): the
 * newest first, the rest when the reader scrolls. These pin what that must
 * not cost: exact counts, pages that neither repeat nor skip a card, the
 * member's scope, and the cards outside the pages still reachable.
 */
describe("board columns by page", () => {
  let world: TestWorld | undefined;
  let seq = 0;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    world = undefined;
  });

  function database(): Database {
    return world.db as unknown as Database;
  }

  async function cards(
    n: number,
    status: "aberto" | "em_execucao" | "feito" | "validado" | "descartado",
    options: { ageDays?: (i: number) => number; extra?: Partial<typeof task.$inferInsert> } = {},
  ) {
    const values = Array.from({ length: n }, (_, i) => {
      seq += 1;
      const at = new Date(NOW.getTime() - (options.ageDays?.(i) ?? 1) * DAY);
      return {
        projectId: world.projectId,
        shortId: `OC-${seq}`,
        title: `card ${seq}`,
        status,
        createdByUserId: world.adminUserId,
        createdAt: at,
        updatedAt: at,
        ...options.extra,
      };
    });
    return world.db.insert(task).values(values).returning({ id: task.id, shortId: task.shortId });
  }

  const allTime: BoardQuery = { now: NOW, period: "all", periodBy: "updated" };

  async function scrollAll(
    principal: Principal | ReturnType<typeof adminPrincipal>,
    projectIds: string[],
    status: "feito",
    query: BoardQuery = allTime,
  ) {
    const first = await loadBoardColumns(database(), projectIds, principal, query);
    const seen = first[status].rows.map((row) => row.id);
    let next = first[status].next;
    let pages = 1;
    while (next) {
      const cursor = decodeBoardCursor(next);
      expect(cursor).not.toBeNull();
      const page = await loadBoardColumnPage(database(), projectIds, principal, query, status, cursor!);
      seen.push(...page.rows.map((row) => row.id));
      next = page.next;
      pages += 1;
    }
    return { seen, pages, first };
  }

  it("hands each column its newest page and counts the whole column exactly", async () => {
    world = await createTestWorld();
    await cards(BOARD_COLUMN_PAGE + 25, "feito", { ageDays: (i) => i });
    await cards(3, "aberto");
    const columns = await loadBoardColumns(database(), [world.projectId], adminPrincipal(world), allTime);
    expect(columns.feito.rows).toHaveLength(BOARD_COLUMN_PAGE);
    expect(columns.feito.next).not.toBeNull();
    expect(columns.aberto.rows).toHaveLength(3);
    expect(columns.aberto.next).toBeNull();
    // Newest first, by the date the period reads.
    const dates = columns.feito.rows.map((row) => row.updatedAt.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));

    const counts = await loadBoardCounts(database(), [world.projectId], adminPrincipal(world), allTime);
    expect(counts.columns).toEqual({
      aberto: 3,
      em_execucao: 0,
      feito: BOARD_COLUMN_PAGE + 25,
      validado: 0,
      descartado: 0,
    });
    // Inside the period only: 7 days holds a week of the done cards.
    const week = await loadBoardCounts(database(), [world.projectId], adminPrincipal(world), {
      ...allTime,
      period: "7d",
    });
    // Ages 0 to 7 days: the seventh day is still inside the week.
    expect(week.columns.feito).toBe(8);
    expect(week.columns.aberto).toBe(3);
  });

  it("scrolls a column through every card once, ties on the same instant included", async () => {
    world = await createTestWorld();
    // Three pages' worth written in the same millisecond: only the id orders them.
    const made = await cards(BOARD_COLUMN_PAGE * 2 + 7, "feito", { ageDays: () => 2 });
    const { seen, pages } = await scrollAll(adminPrincipal(world), [world.projectId], "feito");
    expect(pages).toBe(3);
    expect(seen).toHaveLength(made.length);
    expect(new Set(seen).size).toBe(made.length);
    expect(new Set(seen)).toEqual(new Set(made.map((row) => row.id)));
  });

  it("keeps microsecond dates exact across a page boundary", async () => {
    world = await createTestWorld();
    await cards(BOARD_COLUMN_PAGE + 5, "feito", { ageDays: (i) => i });
    // Two groups one microsecond apart, which a JS Date cannot tell apart; the
    // first page ends inside the older group, so a cursor that lost the
    // microseconds would skip the rest of it.
    await world.client.exec(
      `update task set updated_at = '2026-11-01 10:00:00.000001+00' where short_id in (select short_id from task order by updated_at desc limit ${BOARD_COLUMN_PAGE + 10})`,
    );
    await world.client.exec(
      `update task set updated_at = '2026-11-01 10:00:00.000002+00' where short_id in (select short_id from task order by updated_at desc, id desc limit 10)`,
    );
    const { seen } = await scrollAll(adminPrincipal(world), [world.projectId], "feito");
    expect(seen).toHaveLength(BOARD_COLUMN_PAGE + 5);
    expect(new Set(seen).size).toBe(BOARD_COLUMN_PAGE + 5);
  });

  it("re-reads a column as deep as the board already holds it", async () => {
    world = await createTestWorld();
    await cards(BOARD_COLUMN_PAGE * 2 + 3, "feito", { ageDays: (i) => i });
    const deep = await loadBoardColumns(
      database(),
      [world.projectId],
      adminPrincipal(world),
      allTime,
      { feito: BOARD_COLUMN_PAGE * 2 },
    );
    expect(deep.feito.rows).toHaveLength(BOARD_COLUMN_PAGE * 2);
    const rest = await loadBoardColumnPage(
      database(),
      [world.projectId],
      adminPrincipal(world),
      allTime,
      "feito",
      decodeBoardCursor(deep.feito.next)!,
    );
    expect(rest.rows).toHaveLength(3);
    expect(rest.next).toBeNull();
  });

  it("filters in SQL: type, priority, release and the loose bucket, with menus counted without their own filter", async () => {
    world = await createTestWorld();
    await cards(4, "aberto", { extra: { tipo: "bug", priority: "alta", missionId: world.missionId } });
    await cards(2, "aberto", { extra: { tipo: "feature", resolvedIn: "v1.2.0" } });
    await cards(1, "feito", { extra: { tipo: "bug", priority: "baixa" } });
    const bugs = await loadBoardColumns(database(), [world.projectId], adminPrincipal(world), {
      ...allTime,
      types: ["bug"],
    });
    expect(bugs.aberto.rows).toHaveLength(4);
    expect(bugs.feito.rows).toHaveLength(1);
    const loose = await loadBoardCounts(database(), [world.projectId], adminPrincipal(world), {
      ...allTime,
      missionId: NO_MISSION,
    });
    expect(loose.columns.aberto).toBe(2);
    expect(loose.columns.feito).toBe(1);
    // The mission menu ignores the mission picked; the release menu the release.
    expect(loose.missions[world.missionId]).toBe(4);
    expect(loose.loose).toBe(3);
    expect(loose.scope).toBe(7);
    const released = await loadBoardCounts(database(), [world.projectId], adminPrincipal(world), {
      ...allTime,
      resolvedIn: "v1.2.0",
    });
    expect(released.columns.aberto).toBe(2);
    expect(released.releases).toEqual({ "v1.2.0": 2, "": 5 });
  });

  describe("a member", () => {
    async function member(): Promise<Principal> {
      const [row] = await world.db
        .insert(user)
        .values({
          email: "member@example.test",
          passwordHash: "x",
          role: "member",
          organizationId: world.organizationId,
        })
        .returning({ id: user.id });
      await linkProjects(world.db, row!.id, [world.projectId]);
      return { userId: row!.id, role: "member", organizationId: world.organizationId };
    }

    it("never gets a project they are not linked to, whatever the scope asks", async () => {
      world = await createTestWorld();
      const side = await insertSideProject(world.db, world);
      await cards(2, "aberto");
      await world.db.insert(task).values({
        projectId: side,
        shortId: "LT-1",
        title: "admin side",
        status: "aberto",
        createdByUserId: world.adminUserId,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const principal = await member();
      const visible = [{ id: world.projectId, organizationId: world.organizationId }];
      // The bar's scope names the side project: nothing, not "all of mine".
      expect(boardScopeProjectIds(visible, { organizationIds: [], projectIds: [side] })).toEqual([]);
      expect(
        boardScopeProjectIds(visible, { organizationIds: ["not-mine"], projectIds: [] }),
      ).toEqual([]);
      expect(boardScopeProjectIds(visible, { organizationIds: [], projectIds: [] })).toEqual([
        world.projectId,
      ]);
      // And even handed the side project, the query keeps to the member's scope.
      const columns = await loadBoardColumns(database(), [world.projectId, side], principal, allTime);
      expect(columns.aberto.rows.map((row) => row.projectId)).toEqual([
        world.projectId,
        world.projectId,
      ]);
      const counts = await loadBoardCounts(database(), [world.projectId, side], principal, allTime);
      expect(counts.columns.aberto).toBe(2);
    });

    it("cannot reach into a mission they may not see by naming it", async () => {
      world = await createTestWorld();
      const principal = await member();
      const side = await insertSideProject(world.db, world);
      const [hidden] = await world.db
        .insert(mission)
        .values({
          workspaceId: world.workspaceId,
          organizationId: world.organizationId,
          title: "admin's mission",
          createdByUserId: world.adminUserId,
        })
        .returning({ id: mission.id });
      // The mission's cards live in the side project only: missionScope hides it.
      await world.db.insert(task).values({
        projectId: side,
        missionId: hidden!.id,
        shortId: "LT-1",
        title: "admin side",
        status: "aberto",
        createdByUserId: world.adminUserId,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await cards(2, "aberto");
      const counts = await loadBoardCounts(database(), [world.projectId, side], principal, allTime);
      expect(counts.missions[hidden!.id]).toBeUndefined();
      // The page reads the mission against the missions the reader sees.
      const asked = boardQueryFromFilter({ missionId: hidden!.id, period: "all" }, new Set(), null, NOW);
      const none = await loadBoardCounts(database(), [world.projectId, side], principal, asked);
      expect(none.columns.aberto).toBe(0);
      const loose = boardQueryFromFilter({ missionId: NO_MISSION, period: "all" }, new Set(), null, NOW);
      const looseCounts = await loadBoardCounts(database(), [world.projectId, side], principal, loose);
      expect(looseCounts.columns.aberto).toBe(2);
    });
  });

  it("still reaches a card outside the loaded pages by id and by short id", async () => {
    world = await createTestWorld();
    const made = await cards(BOARD_COLUMN_PAGE + 10, "feito", { ageDays: (i) => i });
    const oldest = made[made.length - 1]!;
    const columns = await loadBoardColumns(database(), [world.projectId], adminPrincipal(world), allTime);
    expect(columns.feito.rows.some((row) => row.id === oldest.id)).toBe(false);
    const byId = await loadBoardTasksByIds(database(), [world.projectId], adminPrincipal(world), [oldest.id]);
    expect(byId.map((row) => row.id)).toEqual([oldest.id]);
    const byShort = await findBoardTaskByShortId(
      database(),
      [world.projectId],
      adminPrincipal(world),
      oldest.shortId,
    );
    expect(byShort?.id).toBe(oldest.id);
  });

  it("refuses a cursor it did not write", () => {
    expect(decodeBoardCursor("2026-11-01 10:00:00.000001+00|not-a-uuid")).toBeNull();
    expect(decodeBoardCursor("'; drop table task; --|00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(decodeBoardCursor(42)).toBeNull();
    expect(
      decodeBoardCursor("2026-11-01 10:00:00.000001+00|00000000-0000-0000-0000-000000000001"),
    ).toEqual({ at: "2026-11-01 10:00:00.000001+00", id: "00000000-0000-0000-0000-000000000001" });
  });
});
