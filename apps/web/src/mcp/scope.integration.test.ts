import { mcpToken, mission, organization, project, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authContextForUser } from "../lib/scope";
import { authenticateBearer } from "./auth";
import { createOverclickMcpServer } from "./server";
import {
  closeTestWorld,
  createTestWorld,
  insertSideProject,
  linkProjects,
  type TestWorld,
} from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";
import { generateTokenSecret, hashToken } from "./token";
import type { AuthContext } from "./types";

const origem = { session_id: "sess_scope", cli: "test" };
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  ...extra,
});

describe("MCP scope: a member only reaches what is theirs (OCL-220)", () => {
  let world: TestWorld;
  let admin: AuthContext;
  let member: AuthContext;
  let memberId: string;
  let otherOrgId: string;
  let otherProjectId: string;
  let sideProjectId: string;
  let memberSecret: string;
  let adminCard: string;
  let memberCard: string;

  const asAdmin = () => admin;
  const asMember = () => member;

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
    memberSecret = generateTokenSecret();
    await world.db.insert(mcpToken).values({
      workspaceId: world.workspaceId,
      ownerUserId: memberId,
      label: "member-agent",
      hash: hashToken(memberSecret),
      tokenPrefix: memberSecret.slice(0, 12),
      canManage: true,
    });
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
    // The member works on OC; the admin's card sits in a project of the same
    // organization the member is not linked to.
    await linkProjects(world.db, memberId, [world.projectId]);
    sideProjectId = await insertSideProject(world.db, world);

    admin = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin",
      canManage: true,
    };
    const auth = await authenticateBearer(world.db, `Bearer ${memberSecret}`);
    if (!auth.ok) throw new Error("member token should authenticate");
    member = auth.ctx;

    const a = await invokeTool(world.db, admin, "task_create", card("do admin", { project_id: sideProjectId, mission: world.missionId }));
    const m1 = await invokeTool(world.db, member, "task_create", card("do member", { project_id: world.projectId }));
    if (!a.ok || !m1.ok) throw new Error("fixture cards failed");
    adminCard = (a.value as { task: { short_id: string } }).task.short_id;
    memberCard = (m1.value as { task: { short_id: string } }).task.short_id;
  });

  afterEach(async () => {
    await closeTestWorld(world);
  });

  it("reads: lists, search, get and aggregates hold only the member's rows", async () => {
    const list = await invokeTool(world.db, member, "task_list", {});
    expect(list.ok && (list.value as { tasks: Array<{ short_id: string }> }).tasks.map((t) => t.short_id)).toEqual([memberCard]);

    const search = await invokeTool(world.db, member, "task_search", { q: "do" });
    expect(search.ok && (search.value as { tasks: Array<{ short_id: string }> }).tasks.map((t) => t.short_id)).toEqual([memberCard]);

    expect((await invokeTool(world.db, member, "task_get", { task_id: memberCard })).ok).toBe(true);

    const orgs = await invokeTool(world.db, member, "organization_list", {});
    const names = orgs.ok ? (orgs.value as { organizations: Array<{ name: string; counts: { cards: number } }> }).organizations : [];
    expect(names.map((o) => o.name)).toEqual(["General"]);
    expect(names[0]?.counts.cards).toBe(1);

    const projects = await invokeTool(world.db, member, "project_list", { view: "full" });
    const rows = projects.ok ? (projects.value as { projects: Array<{ id_prefix: string; cards: { total: number } }> }).projects : [];
    expect(rows.map((p) => p.id_prefix)).toEqual(["OC"]);
    expect(rows[0]?.cards.total).toBe(1);

    // The admin's mission is invisible; the member has none yet.
    const missions = await invokeTool(world.db, member, "mission_list", {});
    expect(missions.ok && (missions.value as { missions: unknown[] }).missions).toEqual([]);
    const got = await invokeTool(world.db, member, "mission_get", { mission_id: world.missionId });
    expect(got.ok).toBe(false);

    const insights = await invokeTool(world.db, member, "insights_query", { group_by: "card" });
    expect(insights.ok).toBe(true);
    if (insights.ok) {
      const cards = (insights.value as { cards: Array<{ short_id: string }> }).cards;
      expect(cards.every((c) => c.short_id !== adminCard)).toBe(true);
    }
  });

  it("writes on the admin's card answer exactly like a card that does not exist", async () => {
    const ghost = await invokeTool(world.db, member, "task_get", { task_id: "OC-999" });
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
      const real = await invokeTool(world.db, member, tool, { task_id: adminCard, ...extra });
      const fake = await invokeTool(world.db, member, tool, { task_id: "OC-999", ...extra });
      expect(real.ok, tool).toBe(false);
      if (!real.ok && !fake.ok) {
        expect(real.error.code, tool).toBe(fake.error.code);
        expect(real.error.message.replace(adminCard, "X"), tool).toBe(fake.error.message.replace("OC-999", "X"));
      }
    }
    if (!ghost.ok) expect(ghost.error.code).toBe("NOT_FOUND");
    const still = await invokeTool(world.db, admin, "task_get", { task_id: adminCard });
    expect(still.ok && (still.value as { task: { status: string } }).task.status).toBe("aberto");
  });

  it("creates: authored by the member, refused outside their organization, mission and parent", async () => {
    const list = await invokeTool(world.db, admin, "task_list", { include: ["all"] });
    expect(list.ok && (list.value as { tasks: unknown[] }).tasks.length).toBe(2);

    const elsewhere = await invokeTool(world.db, member, "task_create", card("x", { project_id: otherProjectId }));
    expect(!elsewhere.ok && elsewhere.error.code).toBe("NOT_FOUND");
    const adminMission = await invokeTool(world.db, member, "task_create", card("x", { project_id: world.projectId, mission: world.missionId }));
    expect(!adminMission.ok && adminMission.error.code).toBe("NOT_FOUND");
    const adminParent = await invokeTool(world.db, member, "task_create", card("x", { project_id: world.projectId, parent: adminCard }));
    expect(!adminParent.ok && adminParent.error.code).toBe("NOT_FOUND");
    const noRepo = await invokeTool(world.db, member, "task_create", card("x", { repo: "github.com/none/none" }));
    expect(noRepo.ok).toBe(false);
  });

  it("refuses the member's project, organization, mission-of-others and config writes", async () => {
    const attempts: Array<[Parameters<typeof invokeTool>[2], unknown]> = [
      ["organization_create", { name: "Nova" }],
      ["organization_update", { organization_id: world.organizationId, name: "Renomeada" }],
      ["organization_delete", { organization_id: world.organizationId }],
      ["project_create", { name: "Novo", organization: world.organizationId }],
      ["project_update", { project_id: world.projectId, name: "Renomeado" }],
      ["project_delete", { project_id: world.projectId }],
      ["project_context_refresh", { project_id: world.projectId }],
      ["mission_update", { mission_id: world.missionId, title: "sequestrada" }],
      ["mission_delete", { mission_id: world.missionId }],
      ["executors_update", { cli: "x", add_models: ["m"] }],
      ["task_update", { task_id: memberCard, status: "descartado", comment: "x" }],
    ];
    for (const [tool, args] of attempts) {
      const result = await invokeTool(world.db, member, tool, args);
      expect(result.ok, tool).toBe(false);
    }
    // canManage on the token did not give the member the workspace.
    const denied = await invokeTool(world.db, member, "executors_update", { cli: "x", add_models: ["m"] });
    expect(!denied.ok && denied.error.code).toBe("PERMISSION_DENIED");

    const [m] = await world.db.select().from(mission).where(eq(mission.id, world.missionId));
    expect(m?.title).toBe("Norte do board");
    const [o] = await world.db.select().from(organization).where(eq(organization.id, world.organizationId));
    expect(o?.name).toBe("General");
  });

  it("a member's own mission works for them and stays hidden from another member", async () => {
    const created = await invokeTool(world.db, member, "mission_create", { title: "Minha" });
    expect(created.ok).toBe(true);
    const list = await invokeTool(world.db, member, "mission_list", {});
    expect(list.ok && (list.value as { missions: Array<{ title: string }> }).missions.map((x) => x.title)).toEqual(["Minha"]);
    const adminList = await invokeTool(world.db, admin, "mission_list", {});
    expect(adminList.ok && (adminList.value as { missions: unknown[] }).missions.length).toBe(2);
  });

  it("a deactivated owner's token is refused before any tool runs (OCL-222)", async () => {
    await world.db.update(user).set({ active: false }).where(eq(user.id, memberId));
    const auth = await authenticateBearer(world.db, `Bearer ${memberSecret}`);
    expect(auth).toMatchObject({ ok: false, code: "TOKEN_REVOKED" });
  });

  it("the server instructions and context resources list only the member's projects", async () => {
    await world.db.update(project).set({ context: "contexto do OC" }).where(eq(project.id, world.projectId));
    await world.db.update(project).set({ context: "contexto SECRETO" }).where(eq(project.id, otherProjectId));
    const seen = async (ctx: AuthContext) => {
      const server = await createOverclickMcpServer({ db: world.db, ctx });
      const inner = server.server as unknown as { _instructions?: string };
      const resources = (server as unknown as { _registeredResources: Record<string, unknown> })._registeredResources;
      return { instructions: inner._instructions ?? "", uris: Object.keys(resources) };
    };
    const forMember = await seen(member);
    expect(forMember.instructions).toContain("contexto do OC");
    expect(forMember.instructions).not.toContain("SECRETO");
    expect(forMember.uris.some((u) => u.includes("/OT/"))).toBe(false);
    const forAdmin = await seen(admin);
    expect(forAdmin.instructions).toContain("SECRETO");
  });

  it("the admin still sees everything, the member's card included", async () => {
    const list = await invokeTool(world.db, admin, "task_list", {});
    expect(list.ok && (list.value as { tasks: Array<{ short_id: string }> }).tasks.map((t) => t.short_id).sort()).toEqual([adminCard, memberCard].sort());
    const get = await invokeTool(world.db, admin, "task_get", { task_id: memberCard });
    expect(get.ok).toBe(true);
    const orgs = await invokeTool(world.db, admin, "organization_list", {});
    expect(orgs.ok && (orgs.value as { organizations: unknown[] }).organizations.length).toBe(2);
    const created = await invokeTool(world.db, admin, "task_create", card("no outro org", { project_id: otherProjectId }));
    expect(created.ok).toBe(true);
  });

  it("a signed-in admin's web action still claims-releases and discards a member's card", async () => {
    const acting = await authContextForUser(
      world.db,
      { userId: world.adminUserId, email: "admin@example.test" },
      world.workspaceId,
    );
    expect(acting?.role).toBe("admin");
    const discarded = await invokeTool(world.db, acting!, "task_update", {
      task_id: memberCard,
      status: "descartado",
      comment: "not needed",
    });
    expect(discarded.ok).toBe(true);
    // A member's session carries the member's scope and no manage authority.
    const asUser = await authContextForUser(
      world.db,
      { userId: memberId, email: "member@example.test" },
      world.workspaceId,
    );
    expect(asUser?.canManage).toBe(false);
    const other = await invokeTool(world.db, asUser!, "task_get", { task_id: adminCard });
    expect(other.ok).toBe(false);
  });
});
