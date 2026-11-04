import { mission, task, user } from "@agent-board/db";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { invokeToolForTests as invokeTool } from "../mcp/test-tools";
import type { AuthContext } from "../mcp/types";

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

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { assignCardsToMissionAction, restoreCardMissionsAction } = await import("./missions");

const origem = { session_id: "sess_bulk_move", cli: "test" };
const card = (title: string) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  project_id: world.projectId,
});

/**
 * Navigation plan E6: "Mover para missão…" on the selection bar, and the
 * "N cards movidos · Desfazer" it leaves. The server reads where each card was
 * — the client is not asked — and the undo checks every card and every
 * mission against the caller's scope again.
 */
describe("bulk move and its undo", () => {
  let admin: AuthContext;
  let member: AuthContext;
  let memberId: string;
  let target: string;
  let other: string;
  let memberMission: string;
  let ids: string[];
  let memberCards: string[];

  beforeEach(async () => {
    world = await createTestWorld();
    const [m] = await world.db
      .insert(user)
      .values({
        email: "member@example.test",
        passwordHash: "x",
        role: "member",
        organizationId: world.organizationId,
      })
      .returning({ id: user.id });
    memberId = m!.id;
    admin = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin",
      canManage: true,
    };
    member = {
      tokenId: world.secondTokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "member",
      userId: memberId,
      role: "member",
      organizationId: world.organizationId,
      canManage: false,
    };
    const missions = await world.db
      .insert(mission)
      .values([
        { workspaceId: world.workspaceId, organizationId: world.organizationId, title: "Login por código", status: "ativa", createdByUserId: world.adminUserId },
        { workspaceId: world.workspaceId, organizationId: world.organizationId, title: "Outra", status: "ativa", createdByUserId: world.adminUserId },
        { workspaceId: world.workspaceId, organizationId: world.organizationId, title: "Do member", status: "ativa", createdByUserId: memberId },
      ])
      .returning({ id: mission.id });
    [target, other, memberMission] = missions.map((row) => row.id) as [string, string, string];

    const idOf = (r: Awaited<ReturnType<typeof invokeTool>>) => {
      if (!r.ok) throw new Error("fixture card failed");
      return (r.value as { task: { id: string } }).task.id;
    };
    // Three cards from three places: the fixture mission, another one, none.
    ids = [
      idOf(await invokeTool(world.db, admin, "task_create", card("a"))),
      idOf(await invokeTool(world.db, admin, "task_create", card("b"))),
      idOf(await invokeTool(world.db, admin, "task_create", card("c"))),
    ];
    memberCards = [
      idOf(await invokeTool(world.db, member, "task_create", card("m1"))),
      idOf(await invokeTool(world.db, member, "task_create", card("m2"))),
    ];
    const place = (id: string, missionId: string | null) =>
      world.db.update(task).set({ missionId }).where(eq(task.id, id));
    await place(ids[0]!, world.missionId);
    await place(ids[1]!, other);
    await place(ids[2]!, null);
    await place(memberCards[0]!, null);
    await place(memberCards[1]!, memberMission);
    sessionUserId = world.adminUserId;
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  const missionsOf = async (cardIds: string[]) =>
    Object.fromEntries(
      (
        await world.db
          .select({ id: task.id, m: task.missionId })
          .from(task)
          .where(inArray(task.id, cardIds))
      ).map((row) => [row.id, row.m]),
    );

  it("moves 3 cards, then Desfazer puts each back in its own previous mission, Sem missão included", async () => {
    const before = await missionsOf(ids);
    expect(before[ids[2]!]).toBeNull();

    const moved = await assignCardsToMissionAction(ids, target);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(Object.values(await missionsOf(ids))).toEqual([target, target, target]);
    // What the undo needs comes from the server, not from the board's copy.
    expect(Object.fromEntries(moved.previous.map((p) => [p.taskId, p.missionId]))).toEqual(before);

    expect(await restoreCardMissionsAction(moved.previous)).toEqual({ ok: true });
    expect(await missionsOf(ids)).toEqual(before);
  });

  it("member: moving another person's card is refused and nothing moves", async () => {
    sessionUserId = memberId;
    expect(await assignCardsToMissionAction([memberCards[0]!, ids[2]!], memberMission)).toEqual({
      ok: false,
      error: "Card not found.",
    });
    expect(await missionsOf([memberCards[0]!, ids[2]!])).toEqual({
      [memberCards[0]!]: null,
      [ids[2]!]: null,
    });
  });

  it("member: an undo naming another person's card or mission is refused and nothing moves", async () => {
    sessionUserId = memberId;
    // A forged undo: their own card plus the admin's, which must stay put.
    expect(
      await restoreCardMissionsAction([
        { taskId: memberCards[0]!, missionId: memberMission },
        { taskId: ids[0]!, missionId: null },
      ]),
    ).toEqual({ ok: false, error: "Card not found." });
    // Their own card sent into the admin's mission.
    expect(
      await restoreCardMissionsAction([{ taskId: memberCards[0]!, missionId: target }]),
    ).toEqual({ ok: false, error: "Mission not found." });
    expect(await missionsOf([memberCards[0]!, ids[0]!])).toEqual({
      [memberCards[0]!]: null,
      [ids[0]!]: world.missionId,
    });
  });

  it("member: moves and undoes their own cards", async () => {
    sessionUserId = memberId;
    const moved = await assignCardsToMissionAction(memberCards, memberMission);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(await restoreCardMissionsAction(moved.previous)).toEqual({ ok: true });
    expect(await missionsOf(memberCards)).toEqual({
      [memberCards[0]!]: null,
      [memberCards[1]!]: memberMission,
    });
  });
});
