import { mcpToken, project, projectMember, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { invokeToolForTests as invokeTool } from "../mcp/test-tools";
import { generateTokenSecret, hashToken } from "../mcp/token";

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

const { setBoardPersonAction, setBoardScopeAction } = await import("./board-filter");

/**
 * The person picked in the global bar is remembered like the scope and the
 * period (E4): one column on the user. Only a person the reader can see on a
 * card may be remembered, so a member cannot park someone else's id there.
 */
describe("the board person is remembered like the scope", () => {
  let memberId: string;
  let outsiderId: string;

  const stored = async (userId: string) => {
    const [row] = await world.db
      .select({ person: user.boardPerson })
      .from(user)
      .where(eq(user.id, userId));
    return row?.person ?? null;
  };

  beforeEach(async () => {
    world = await createTestWorld();
    const [m] = await world.db
      .insert(user)
      .values({ email: "member@example.test", role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    memberId = m!.id;
    await world.db.insert(projectMember).values({ projectId: world.projectId, userId: memberId });
    const [side] = await world.db
      .insert(project)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        name: "Lateral",
        idPrefix: "LT",
        nextNumber: 1,
      })
      .returning({ id: project.id });
    const [o] = await world.db
      .insert(user)
      .values({ email: "outsider@example.test", role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    outsiderId = o!.id;
    await world.db.insert(projectMember).values({ projectId: side!.id, userId: outsiderId });
    const secret = generateTokenSecret();
    const [tok] = await world.db
      .insert(mcpToken)
      .values({
        workspaceId: world.workspaceId,
        ownerUserId: outsiderId,
        label: "outsider-agent",
        hash: hashToken(secret),
        tokenPrefix: secret.slice(0, 12),
      })
      .returning({ id: mcpToken.id });
    const outsider = {
      tokenId: tok!.id,
      workspaceId: world.workspaceId,
      tokenLabel: "outsider",
      userId: outsiderId,
      role: "member" as const,
      organizationId: world.organizationId,
    };
    const made = await invokeTool(world.db, outsider, "task_create", {
      title: "só no lateral",
      type: "feature",
      o_que: "o",
      por_que: "p",
      como_confirmo: [{ step: "s", expected: "e" }],
      origem: { session_id: "s", cli: "test" },
      project_id: side!.id,
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    // The admin writes one card in the project the member sees.
    const admin = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin" as const,
      canManage: true,
    };
    const mine = await invokeTool(world.db, admin, "task_create", {
      title: "do admin",
      type: "feature",
      o_que: "o",
      por_que: "p",
      como_confirmo: [{ step: "s", expected: "e" }],
      origem: { session_id: "s", cli: "test" },
      project_id: world.projectId,
    });
    if (!mine.ok) throw new Error(JSON.stringify(mine));
    sessionUserId = memberId;
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  it("stores me, a visible person and everyone", async () => {
    expect(await setBoardPersonAction("me")).toEqual({ ok: true });
    expect(await stored(memberId)).toBe("me");
    expect(await setBoardPersonAction(world.adminUserId)).toEqual({ ok: true });
    expect(await stored(memberId)).toBe(world.adminUserId);
    expect(await setBoardPersonAction("all")).toEqual({ ok: true });
    expect(await stored(memberId)).toBeNull();
  });

  it("refuses a person the member cannot see on any card, the same as one that does not exist", async () => {
    await setBoardPersonAction("me");
    const outside = await setBoardPersonAction(outsiderId);
    const missing = await setBoardPersonAction("00000000-0000-0000-0000-000000000000");
    const garbage = await setBoardPersonAction("x' or 1=1");
    expect(outside).toEqual({ ok: false, error: "Person not found." });
    expect(missing).toEqual(outside);
    expect(garbage).toEqual(outside);
    expect(await stored(memberId)).toBe("me");
  });

  it("changing the scope leaves the person alone", async () => {
    await setBoardPersonAction("me");
    expect(await setBoardScopeAction({ organizationIds: [], projectIds: [] })).toEqual({ ok: true });
    expect(await stored(memberId)).toBe("me");
  });

  it("nobody signed in stores nothing", async () => {
    sessionUserId = "";
    expect(await setBoardPersonAction("me")).toEqual({ ok: false, error: "Not signed in." });
  });
});
