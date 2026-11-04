import { mission, task, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestWorld, createTestWorld, linkProjects, type TestWorld } from "../mcp/test-db";
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

const {
  assignCardsToMissionAction,
  deleteEmptyMissionAction,
  restoreCardMissionsAction,
  updateMissionAction,
} = await import("./missions");

const card = (title: string) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem: { session_id: "sess_member_missions", cli: "test" },
  project_id: world.projectId,
});

/**
 * The board's mission actions as a member: the admin's mission shows up in
 * their board because it holds a card of a project linked to them, and that
 * is all it gives them. Same rule as mission_update / mission_delete over MCP.
 */
describe("mission actions as a member: the admin's mission is theirs to read only", () => {
  let memberId: string;
  let adminMission: string;
  let memberMission: string;
  let looseCard: string;

  beforeEach(async () => {
    world = await createTestWorld();
    const [m] = await world.db
      .insert(user)
      .values({ email: "member@example.test", passwordHash: "x", role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    memberId = m!.id;
    await linkProjects(world.db, memberId, [world.projectId]);
    const admin: AuthContext = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin",
      canManage: true,
    };
    const [a, b] = await world.db
      .insert(mission)
      .values([
        { workspaceId: world.workspaceId, organizationId: world.organizationId, title: "Do admin", createdByUserId: world.adminUserId },
        { workspaceId: world.workspaceId, organizationId: world.organizationId, title: "Do member", createdByUserId: memberId },
      ])
      .returning({ id: mission.id });
    adminMission = a!.id;
    memberMission = b!.id;
    // The admin's card in the linked project is what makes the mission visible.
    const made = await invokeTool(world.db, admin, "task_create", card("do admin"));
    if (!made.ok) throw new Error("fixture failed");
    await world.db.update(task).set({ missionId: adminMission }).where(eq(task.id, (made.value as { task: { id: string } }).task.id));
    const loose = await invokeTool(world.db, admin, "task_create", card("solto"));
    if (!loose.ok) throw new Error("fixture failed");
    looseCard = (loose.value as { task: { id: string } }).task.id;
    sessionUserId = memberId;
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  const titleOf = async (id: string) =>
    (await world.db.select({ t: mission.title }).from(mission).where(eq(mission.id, id)))[0]?.t;

  it("cannot edit the admin's mission", async () => {
    const result = await updateMissionAction({
      missionId: adminMission,
      title: "Mudado",
      objective: "x",
      context: "y",
      status: "pausada",
    });
    expect(result.ok).toBe(false);
    expect(await titleOf(adminMission)).toBe("Do admin");
  });

  it("can edit the mission it wrote; the admin can edit any", async () => {
    const own = await updateMissionAction({ missionId: memberMission, title: "Meu 2", objective: "", context: "", status: "ativa" });
    expect(own.ok).toBe(true);
    sessionUserId = world.adminUserId;
    const admin = await updateMissionAction({ missionId: memberMission, title: "Meu 3", objective: "", context: "", status: "ativa" });
    expect(admin.ok).toBe(true);
    expect(await titleOf(memberMission)).toBe("Meu 3");
  });

  it("cannot delete the admin's mission, even one that looks empty to them", async () => {
    // Out of the member's sight, a card the admin keeps there is not counted.
    await world.db.update(task).set({ missionId: null }).where(eq(task.missionId, adminMission));
    const result = await deleteEmptyMissionAction(adminMission);
    expect(result.ok).toBe(false);
    expect(await titleOf(adminMission)).toBe("Do admin");
  });

  it("can delete the empty mission it wrote", async () => {
    expect((await deleteEmptyMissionAction(memberMission)).ok).toBe(true);
    expect(await titleOf(memberMission)).toBeUndefined();
  });

  it("does not move a card into the admin's mission, nor undo into it; its own mission, yes", async () => {
    const refused = await assignCardsToMissionAction([looseCard], adminMission);
    expect(refused.ok).toBe(false);
    expect((await world.db.select().from(task).where(eq(task.id, looseCard)))[0]?.missionId).toBeNull();

    const undone = await restoreCardMissionsAction([{ taskId: looseCard, missionId: adminMission }]);
    expect(undone.ok).toBe(false);
    expect((await world.db.select().from(task).where(eq(task.id, looseCard)))[0]?.missionId).toBeNull();

    const moved = await assignCardsToMissionAction([looseCard], memberMission);
    expect(moved.ok).toBe(true);
  });

  it("the admin still moves cards into any mission", async () => {
    sessionUserId = world.adminUserId;
    expect((await assignCardsToMissionAction([looseCard], memberMission)).ok).toBe(true);
    expect((await assignCardsToMissionAction([looseCard], adminMission)).ok).toBe(true);
  });
});
