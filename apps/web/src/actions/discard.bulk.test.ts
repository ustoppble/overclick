import { task, taskComment, user } from "@agent-board/db";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeTestWorld,
  createTestWorld,
  insertSideProject,
  linkProjects,
  type TestWorld,
} from "../mcp/test-db";
import { invokeToolForTests as invokeTool } from "../mcp/test-tools";
import type { AuthContext } from "../mcp/types";
import { MAX_BULK_CARDS } from "../lib/bulk";

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

const { discardCardsAction } = await import("./discard");

const origem = { session_id: "sess_bulk_discard", cli: "test" };
const card = (title: string) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  project_id: world.projectId,
});
const NOWHERE = "00000000-0000-4000-8000-000000000000";

/**
 * Navigation plan E6: Descartar em lote. One task_update per card — the same
 * door the single discard and an agent use — behind a reason that is
 * required, and every id of the batch checked against the caller's scope on
 * the server, whatever the client sent.
 */
describe("discardCardsAction (bulk discard)", () => {
  let admin: AuthContext;
  let member: AuthContext;
  let memberId: string;
  let adminCards: string[];
  /** The admin's, in a project of the same organization not linked to the member. */
  let sideCards: string[];
  let memberCardId: string;

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
    const idOf = (r: Awaited<ReturnType<typeof invokeTool>>) => {
      if (!r.ok) throw new Error("fixture card failed");
      return (r.value as { task: { id: string } }).task.id;
    };
    adminCards = [];
    for (const title of ["um", "dois", "tres"]) {
      adminCards.push(idOf(await invokeTool(world.db, admin, "task_create", card(title))));
    }
    await linkProjects(world.db, memberId, [world.projectId]);
    const sideProjectId = await insertSideProject(world.db, world);
    sideCards = [];
    for (const title of ["lado um", "lado dois"]) {
      sideCards.push(idOf(await invokeTool(world.db, admin, "task_create", { ...card(title), project_id: sideProjectId })));
    }
    memberCardId = idOf(await invokeTool(world.db, member, "task_create", card("do member")));
    sessionUserId = world.adminUserId;
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  const statuses = async (ids: string[]) =>
    Object.fromEntries(
      (
        await world.db
          .select({ id: task.id, s: task.status })
          .from(task)
          .where(inArray(task.id, ids))
      ).map((row) => [row.id, row.s]),
    );

  it("refuses without a reason and touches nothing", async () => {
    for (const reason of ["", "   "]) {
      const r = await discardCardsAction(adminCards.slice(0, 2), reason);
      expect(r.ok).toBe(false);
    }
    expect(Object.values(await statuses(adminCards))).toEqual(["aberto", "aberto", "aberto"]);
  });

  it("refuses an empty batch and one larger than the board can show", async () => {
    expect((await discardCardsAction([], "fora")).ok).toBe(false);
    const huge = Array.from(
      { length: MAX_BULK_CARDS },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect((await discardCardsAction([...huge, adminCards[0]!], "fora")).ok).toBe(false);
    expect(await statuses([adminCards[0]!])).toEqual({ [adminCards[0]!]: "aberto" });
  });

  it("admin: discards every card with the reason on each card's trail", async () => {
    const r = await discardCardsAction(adminCards.slice(0, 2), "  escopo mudou  ");
    expect(r).toEqual({ ok: true, discarded: adminCards.slice(0, 2), kept: [] });
    expect(await statuses(adminCards)).toEqual({
      [adminCards[0]!]: "descartado",
      [adminCards[1]!]: "descartado",
      [adminCards[2]!]: "aberto",
    });
    for (const id of adminCards.slice(0, 2)) {
      const trail = await world.db
        .select({ body: taskComment.body })
        .from(taskComment)
        .where(eq(taskComment.taskId, id));
      expect(trail.map((row) => row.body)).toContain("Discarded: escopo mudou");
    }
  });

  it("a partial failure says which cards stayed, and why", async () => {
    // A live claim held by an agent: the board refuses it like task_update does.
    const claim = await invokeTool(world.db, admin, "task_claim", {
      task_id: adminCards[1],
      executor: { cli: "claude", model: "sonnet-5" },
    });
    expect(claim.ok).toBe(true);

    const r = await discardCardsAction([adminCards[0]!, adminCards[1]!, NOWHERE], "fora");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.discarded).toEqual([adminCards[0]]);
    expect(r.kept.map((k) => k.id)).toEqual([adminCards[1], NOWHERE]);
    expect(r.kept[1]!.error).toBe("Card not found.");
    expect(r.kept[0]!.error.length).toBeGreaterThan(0);
    expect(await statuses(adminCards.slice(0, 2))).toEqual({
      [adminCards[0]!]: "descartado",
      [adminCards[1]!]: "em_execucao",
    });
  });

  it("member: a card of a project not linked to them is refused as not found and stays untouched", async () => {
    sessionUserId = memberId;
    const r = await discardCardsAction([sideCards[0]!], "não é meu");
    // The same answer an id that never existed gets: nothing to learn from it.
    expect(r).toEqual({
      ok: false,
      error: "Card not found.",
      kept: [{ id: sideCards[0], error: "Card not found." }],
    });
    expect(await discardCardsAction([NOWHERE], "não é meu")).toEqual({
      ok: false,
      error: "Card not found.",
      kept: [{ id: NOWHERE, error: "Card not found." }],
    });

    // Mixed with their own card, the other person's card is still never touched.
    const mixed = await discardCardsAction([memberCardId, sideCards[1]!], "lote");
    expect(mixed.ok).toBe(false);
    if (mixed.ok) return;
    expect(mixed.kept?.find((k) => k.id === sideCards[1])?.error).toBe("Card not found.");
    expect(await statuses([sideCards[0]!, sideCards[1]!])).toEqual({
      [sideCards[0]!]: "aberto",
      [sideCards[1]!]: "aberto",
    });
  });

  it("member: their own card follows the single discard's rule (task_update needs can_manage)", async () => {
    sessionUserId = memberId;
    const r = await discardCardsAction([memberCardId], "meu");
    expect(r.ok).toBe(false);
    expect(await statuses([memberCardId])).toEqual({ [memberCardId]: "aberto" });
  });

  it("refuses with no session", async () => {
    sessionUserId = "";
    expect(await discardCardsAction(adminCards, "fora")).toEqual({
      ok: false,
      error: "Session expired. Sign in again.",
    });
  });
});
