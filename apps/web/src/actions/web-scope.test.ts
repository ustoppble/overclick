import { mission, organization, project, task, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBoardTotals } from "../lib/board-totals-query";
import { loadOrganizationOverviews } from "../lib/organizations-query";
import { principalFromUserId } from "../lib/scope";
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

const { assignCardsToMissionAction, updateMissionAction, deleteEmptyMissionAction, createMissionAction } =
  await import("./missions");
const { setBoardFilterAction, boardTotalsAction } = await import("./board-filter");
const { tickValidationStepAction, reopenTaskAction, validateTaskAction } = await import("./review");
const { saveOrganizationAction, createOrganizationAction, deleteOrganizationAction } =
  await import("./organizations");
const { saveProjectContextAction } = await import("./projects");
const { releaseClaimAction } = await import("./claims");
const { discardTaskAction } = await import("./discard");

const origem = { session_id: "sess_web_scope", cli: "test" };
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  ...extra,
});

/** OCL-221: the web applies the same scope the MCP does, on every door. */
describe("web scope: a member only reaches what is theirs", () => {
  let admin: AuthContext;
  let member: AuthContext;
  let memberId: string;
  let otherOrgId: string;
  let otherProjectId: string;
  let adminCardId: string;
  let memberCardId: string;
  let adminMissionId: string;
  let memberMissionId: string;

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
    const [org2] = await world.db
      .insert(organization)
      .values({ workspaceId: world.workspaceId, name: "Outra" })
      .returning({ id: organization.id });
    otherOrgId = org2!.id;
    const [proj2] = await world.db
      .insert(project)
      .values({
        workspaceId: world.workspaceId,
        organizationId: otherOrgId,
        name: "Outro",
        idPrefix: "OT",
        nextNumber: 1,
      })
      .returning({ id: project.id });
    otherProjectId = proj2!.id;

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

    const a = await invokeTool(world.db, admin, "task_create", card("do admin", { project_id: world.projectId }));
    const b = await invokeTool(world.db, member, "task_create", card("do member", { project_id: world.projectId }));
    if (!a.ok || !b.ok) throw new Error("fixture cards failed");
    const idOf = (r: typeof a) => (r.value as { task: { id: string } }).task.id;
    adminCardId = idOf(a);
    memberCardId = idOf(b);
    adminMissionId = world.missionId;
    const [mm] = await world.db
      .insert(mission)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        title: "member mission",
        status: "ativa",
        createdByUserId: memberId,
      })
      .returning({ id: mission.id });
    memberMissionId = mm!.id;
    sessionUserId = memberId;
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  const statusOf = async (id: string) =>
    (await world.db.select({ s: task.status }).from(task).where(eq(task.id, id)))[0]?.s;

  it("member: cards of the admin answer as not found and stay untouched", async () => {
    const reopen = await reopenTaskAction(adminCardId, "nope");
    expect(reopen).toEqual({ ok: false, error: "Card not found." });
    expect(await tickValidationStepAction(adminCardId, 0, true)).toEqual({
      ok: false,
      error: "Card not found.",
    });
    expect(await validateTaskAction(adminCardId)).toEqual({ ok: false, error: "Card not found." });
    expect(await releaseClaimAction(adminCardId)).toMatchObject({ ok: false });
    expect(await discardTaskAction(adminCardId, "no")).toMatchObject({ ok: false });
    expect(await statusOf(adminCardId)).toBe("aberto");
  });

  it("member: cannot move an admin card into a mission, or their card into the admin's mission", async () => {
    expect(await assignCardsToMissionAction([adminCardId], memberMissionId)).toEqual({
      ok: false,
      error: "Card not found.",
    });
    expect(await assignCardsToMissionAction([memberCardId], adminMissionId)).toEqual({
      ok: false,
      error: "Mission not found.",
    });
    const rows = await world.db
      .select({ id: task.id, m: task.missionId })
      .from(task);
    expect(rows.find((r) => r.id === adminCardId)?.m).toBeNull();
    expect(rows.find((r) => r.id === memberCardId)?.m).toBeNull();
    // Their own card into their own mission works.
    expect(await assignCardsToMissionAction([memberCardId], memberMissionId)).toEqual({ ok: true });
  });

  it("member: cannot edit or delete the admin's mission", async () => {
    const edit = await updateMissionAction({
      missionId: adminMissionId,
      title: "hijack",
      objective: "",
      context: "",
      status: "ativa",
    });
    expect(edit).toEqual({ ok: false, error: "Mission not found." });
    expect(await deleteEmptyMissionAction(adminMissionId)).toEqual({
      ok: false,
      error: "Mission not found.",
    });
    const [row] = await world.db.select({ t: mission.title }).from(mission).where(eq(mission.id, adminMissionId));
    expect(row?.t).not.toBe("hijack");
  });

  it("member: a new mission lands in their own organization and carries them as author", async () => {
    const created = await createMissionAction({
      title: "mine",
      objective: "",
      context: "",
      organizationId: otherOrgId,
    });
    if (!created.ok) throw new Error(created.error);
    const [row] = await world.db
      .select({ org: mission.organizationId, by: mission.createdByUserId })
      .from(mission)
      .where(eq(mission.id, created.mission.id));
    expect(row).toEqual({ org: world.organizationId, by: memberId });
  });

  it("member: board filter refuses ids outside the scope", async () => {
    const base = { organizationIds: [], projectIds: [], missionId: null, types: [], priorities: [], resolvedIn: null };
    expect(await setBoardFilterAction({ ...base, organizationIds: [otherOrgId] })).toEqual({
      ok: false,
      error: "Organization not found.",
    });
    expect(await setBoardFilterAction({ ...base, projectIds: [otherProjectId] })).toEqual({
      ok: false,
      error: "Project not found.",
    });
    // Navigation plan E4: the mission is no longer remembered, so there is
    // nothing to refuse; someone else's mission id is simply never stored.
    expect(await setBoardFilterAction({ ...base, missionId: adminMissionId })).toEqual({ ok: true });
    const [stored] = await world.db
      .select({ missionId: user.boardMissionId })
      .from(user)
      .where(eq(user.id, memberId));
    expect(stored?.missionId).not.toBe(adminMissionId);
  });

  it("member: cannot create, edit or delete organizations and projects", async () => {
    expect(await createOrganizationAction({ name: "X" })).toMatchObject({ ok: false });
    expect(
      await saveOrganizationAction({ organizationId: world.organizationId, name: "renamed", context: "" }),
    ).toMatchObject({ ok: false });
    expect(await deleteOrganizationAction({ organizationId: otherOrgId })).toMatchObject({ ok: false });
    expect(
      await saveProjectContextAction({ projectId: world.projectId, context: "pwn", currentVersion: "" }),
    ).toMatchObject({ ok: false });
    const [org] = await world.db.select({ n: organization.name }).from(organization).where(eq(organization.id, world.organizationId));
    expect(org?.n).not.toBe("renamed");
    const [proj] = await world.db.select({ c: project.context }).from(project).where(eq(project.id, world.projectId));
    expect(proj?.c).not.toBe("pwn");
  });

  it("member: an unknown user gets nothing at all", async () => {
    sessionUserId = "00000000-0000-4000-8000-0000000000ff";
    expect(await reopenTaskAction(memberCardId, "x")).toMatchObject({ ok: false });
    expect(await boardTotalsAction({ organizationIds: [], projectIds: [], missionId: null, types: [], priorities: [], resolvedIn: null })).toMatchObject({ tokens: 0 });
  });

  it("aggregates count only the member's cards; the admin still sees everything", async () => {
    const memberP = await principalFromUserId(world.db, memberId);
    const adminP = await principalFromUserId(world.db, world.adminUserId);
    const empty = { organizationIds: [], projectIds: [], missionId: null, types: [], priorities: [], resolvedIn: null };
    // Both cards run and deliver, so the attempt rows exist.
    for (const [ctx, id] of [[admin, adminCardId], [member, memberCardId]] as const) {
      const [row] = await world.db.select({ n: task.shortId }).from(task).where(eq(task.id, id));
      const claim = await invokeTool(world.db, ctx, "task_claim", { task_id: row!.n, executor: { cli: "claude", model: "sonnet-5" } });
      if (!claim.ok) throw new Error(JSON.stringify(claim));
      const del = await invokeTool(world.db, ctx, "task_deliver", {
        task_id: row!.n,
        summary: "s",
        usage: { segments: [{ model: "sonnet-5", input: 100, output: 10, cache_read: 0, cache_write: 0 }], duration_ms: 1000, turns: 1 },
      });
      if (!del.ok) throw new Error(JSON.stringify(del));
    }
    const forAdmin = await loadBoardTotals(world.db, world.workspaceId, false, [], empty, adminP);
    const forMember = await loadBoardTotals(world.db, world.workspaceId, false, [], empty, memberP);
    expect(forAdmin.tokens).toBe(220);
    expect(forMember.tokens).toBe(110);

    const orgsAdmin = await loadOrganizationOverviews(world.db, world.workspaceId, false, [], adminP);
    const orgsMember = await loadOrganizationOverviews(world.db, world.workspaceId, false, [], memberP);
    expect(orgsAdmin.map((o) => o.name).sort()).toEqual(["Outra", expect.any(String)].sort());
    expect(orgsMember).toHaveLength(1);
    expect(orgsMember[0]!.id).toBe(world.organizationId);
    expect(orgsMember[0]!.totals.tokens).toBe(110);
    expect(orgsMember[0]!.projects.map((p) => p.id)).toEqual([world.projectId]);
    expect(orgsMember[0]!.activeMissions.map((m) => m.id)).toEqual([memberMissionId]);
    expect(orgsAdmin.find((o) => o.id === world.organizationId)!.activeMissions.map((m) => m.id).sort()).toEqual(
      [adminMissionId, memberMissionId].sort(),
    );
  });
});
