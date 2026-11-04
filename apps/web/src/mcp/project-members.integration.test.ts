import { mcpToken, mission, project, projectMember, task, user } from "@agent-board/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateBearer } from "./auth";
import { createOverclickMcpServer } from "./server";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";
import { generateTokenSecret, hashToken } from "./token";
import type { AuthContext } from "./types";

const origem = { session_id: "sess_project_members", cli: "test" };
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  ...extra,
});
const shortIds = (value: unknown) =>
  (value as { tasks: Array<{ short_id: string }> }).tasks.map((t) => t.short_id).sort();

/**
 * A member reaches the projects an admin linked them to, and every card in
 * them, whoever wrote it; nothing of a project they are not linked to, even in
 * their own organization. Exercised the way an agent hits it: with the
 * member's own token, through the bearer check.
 */
describe("MCP as a member: projects linked to them, all their cards, nothing else", () => {
  let world: TestWorld;
  let admin: AuthContext;
  let memberId: string;
  let memberSecret: string;
  let sideProjectId: string;
  let linkedCard: string;
  let sideCard: string;
  let sideMissionId: string;

  /** A fresh bearer check: what the next request of the member's agent gets. */
  const asMember = async (): Promise<AuthContext> => {
    const auth = await authenticateBearer(world.db, `Bearer ${memberSecret}`);
    if (!auth.ok) throw new Error("member token should authenticate");
    return auth.ctx;
  };

  beforeEach(async () => {
    world = await createTestWorld();
    const [m] = await world.db
      .insert(user)
      .values({ email: "member@example.test", role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    memberId = m!.id;
    memberSecret = generateTokenSecret();
    await world.db.insert(mcpToken).values({
      workspaceId: world.workspaceId,
      ownerUserId: memberId,
      label: "member-agent",
      hash: hashToken(memberSecret),
      tokenPrefix: memberSecret.slice(0, 12),
    });
    // Same organization as the member, not linked to them.
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
    sideProjectId = side!.id;
    await world.db.insert(projectMember).values({ projectId: world.projectId, userId: memberId });

    admin = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin",
      canManage: true,
    };
    const [sm] = await world.db
      .insert(mission)
      .values({ workspaceId: world.workspaceId, organizationId: world.organizationId, title: "Só lateral" })
      .returning({ id: mission.id });
    sideMissionId = sm!.id;
    const a = await invokeTool(world.db, admin, "task_create", card("do admin no linkado", { project_id: world.projectId, mission: world.missionId }));
    const b = await invokeTool(world.db, admin, "task_create", card("do admin no lateral", { project_id: sideProjectId, mission: sideMissionId }));
    if (!a.ok || !b.ok) throw new Error("fixture cards failed");
    linkedCard = (a.value as { task: { short_id: string } }).task.short_id;
    sideCard = (b.value as { task: { short_id: string } }).task.short_id;
  });

  afterEach(async () => {
    await closeTestWorld(world);
  });

  it("sees the admin's card in a linked project, in list, search and get", async () => {
    const member = await asMember();
    const list = await invokeTool(world.db, member, "task_list", {});
    expect(list.ok && shortIds(list.value)).toEqual([linkedCard]);
    const search = await invokeTool(world.db, member, "task_search", { q: "do admin" });
    expect(search.ok && shortIds(search.value)).toEqual([linkedCard]);
    const got = await invokeTool(world.db, member, "task_get", { task_id: linkedCard });
    expect(got.ok).toBe(true);
  });

  it("lists only the linked project, with its cards counted", async () => {
    const member = await asMember();
    const projects = await invokeTool(world.db, member, "project_list", { view: "full" });
    const rows = projects.ok ? (projects.value as { projects: Array<{ id_prefix: string; cards: { total: number } }> }).projects : [];
    expect(rows.map((p) => p.id_prefix)).toEqual(["OC"]);
    expect(rows[0]?.cards.total).toBe(1);
    const lt = await invokeTool(world.db, member, "project_get", { project_id: "LT" });
    expect(lt.ok).toBe(false);
  });

  it("a card of an unlinked project answers exactly like one that does not exist", async () => {
    const member = await asMember();
    const calls: Array<[Parameters<typeof invokeTool>[2], Record<string, unknown>]> = [
      ["task_get", {}],
      ["task_update", { progress: "x" }],
      ["task_claim", {}],
      ["task_release", {}],
      ["task_heartbeat", {}],
      ["task_deliver", { summary: "x", usage: { estimated: true, reason: "x", tokens_in: 1, tokens_out: 1 } }],
      ["task_reopen", { reason: "x" }],
      ["task_delete", {}],
    ];
    for (const [tool, extra] of calls) {
      const real = await invokeTool(world.db, member, tool, { task_id: sideCard, ...extra });
      const fake = await invokeTool(world.db, member, tool, { task_id: "LT-999", ...extra });
      expect(real.ok, tool).toBe(false);
      if (!real.ok && !fake.ok) {
        expect(real.error.code, tool).toBe(fake.error.code);
        expect(real.error.message.replace(sideCard, "X"), tool).toBe(fake.error.message.replace("LT-999", "X"));
      }
    }
    const created = await invokeTool(world.db, member, "task_create", card("x", { project_id: sideProjectId }));
    expect(!created.ok && created.error.code).toBe("NOT_FOUND");
    const [still] = await world.db.select().from(task).where(eq(task.shortId, sideCard));
    expect(still?.status).toBe("aberto");
  });

  it("claims a card another person wrote in a linked project", async () => {
    const member = await asMember();
    const claimed = await invokeTool(world.db, member, "task_claim", {
      task_id: linkedCard,
      executor: { cli: "claude", model: "opus-5", effort: "high", session_id: "s1" },
    });
    expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
  });

  it("does not delete a card someone else wrote, even in a linked project; their own, yes", async () => {
    const member = await asMember();
    const theirs = await invokeTool(world.db, member, "task_delete", { task_id: linkedCard });
    expect(!theirs.ok && theirs.error.code).toBe("PERMISSION_DENIED");
    const own = await invokeTool(world.db, member, "task_create", card("meu", { project_id: world.projectId }));
    if (!own.ok) throw new Error(JSON.stringify(own));
    const ownId = (own.value as { task: { short_id: string } }).task.short_id;
    const deleted = await invokeTool(world.db, member, "task_delete", { task_id: ownId });
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
  });

  it("sees the missions with cards in a linked project, and not one whose cards are all elsewhere", async () => {
    const member = await asMember();
    const missions = await invokeTool(world.db, member, "mission_list", {});
    const titles = missions.ok ? (missions.value as { missions: Array<{ title: string }> }).missions.map((x) => x.title) : [];
    expect(titles).toEqual(["Norte do board"]);
    expect((await invokeTool(world.db, member, "mission_get", { mission_id: world.missionId })).ok).toBe(true);
    expect((await invokeTool(world.db, member, "mission_get", { mission_id: sideMissionId })).ok).toBe(false);
  });

  it("a member with no link sees no project, no card and no one else's mission", async () => {
    await world.db.delete(projectMember).where(eq(projectMember.userId, memberId));
    const member = await asMember();
    const list = await invokeTool(world.db, member, "task_list", {});
    expect(list.ok && shortIds(list.value)).toEqual([]);
    const projects = await invokeTool(world.db, member, "project_list", {});
    expect(projects.ok && (projects.value as { projects: unknown[] }).projects).toEqual([]);
    const missions = await invokeTool(world.db, member, "mission_list", {});
    expect(missions.ok && (missions.value as { missions: unknown[] }).missions).toEqual([]);
    expect((await invokeTool(world.db, member, "task_get", { task_id: linkedCard })).ok).toBe(false);
  });

  it("a link changed by the admin counts on the member's very next request", async () => {
    const before = await asMember();
    expect((await invokeTool(world.db, before, "task_get", { task_id: sideCard })).ok).toBe(false);
    await world.db.insert(projectMember).values({ projectId: sideProjectId, userId: memberId });
    const after = await asMember();
    expect((await invokeTool(world.db, after, "task_get", { task_id: sideCard })).ok).toBe(true);
    await world.db
      .delete(projectMember)
      .where(and(eq(projectMember.userId, memberId), eq(projectMember.projectId, world.projectId)));
    const later = await asMember();
    expect((await invokeTool(world.db, later, "task_get", { task_id: linkedCard })).ok).toBe(false);
  });

  it("a link to a project of another organization opens nothing", async () => {
    const [otherOrg] = await world.db
      .insert((await import("@agent-board/db")).organization)
      .values({ workspaceId: world.workspaceId, name: "Outra" })
      .returning({ id: (await import("@agent-board/db")).organization.id });
    const [foreign] = await world.db
      .insert(project)
      .values({ workspaceId: world.workspaceId, organizationId: otherOrg!.id, name: "Fora", idPrefix: "FO", nextNumber: 1 })
      .returning({ id: project.id });
    await world.db.insert(projectMember).values({ projectId: foreign!.id, userId: memberId });
    const made = await invokeTool(world.db, admin, "task_create", card("fora", { project_id: foreign!.id }));
    if (!made.ok) throw new Error("fixture failed");
    const member = await asMember();
    const projects = await invokeTool(world.db, member, "project_list", {});
    const prefixes = projects.ok ? (projects.value as { projects: Array<{ id_prefix: string }> }).projects.map((p) => p.id_prefix) : [];
    expect(prefixes).toEqual(["OC"]);
    const list = await invokeTool(world.db, member, "task_list", {});
    expect(list.ok && shortIds(list.value)).toEqual([linkedCard]);
  });

  it("the server instructions carry only the linked project's context", async () => {
    await world.db.update(project).set({ context: "contexto do OC" }).where(eq(project.id, world.projectId));
    await world.db.update(project).set({ context: "contexto LATERAL" }).where(eq(project.id, sideProjectId));
    const server = await createOverclickMcpServer({ db: world.db, ctx: await asMember() });
    const inner = server.server as unknown as { _instructions?: string };
    expect(inner._instructions).toContain("contexto do OC");
    expect(inner._instructions).not.toContain("LATERAL");
  });

  it("the admin still sees every project and card", async () => {
    const list = await invokeTool(world.db, admin, "task_list", {});
    expect(list.ok && shortIds(list.value)).toEqual([linkedCard, sideCard].sort());
  });
});
