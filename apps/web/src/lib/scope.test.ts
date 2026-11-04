import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { mission, organization, project, projectMember, task, user } from "@agent-board/db";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { invokeToolForTests } from "../mcp/test-tools";
import { authenticateBearer } from "../mcp/auth";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import {
  canManageStructure,
  canManageToken,
  canManageWorkspace,
  canSeeOrganization,
  missionScope,
  organizationScope,
  principalFromAuth,
  principalFromUserId,
  projectScope,
  taskScope,
  type Principal,
} from "./scope";

const admin: Principal = { userId: "u-admin", role: "admin", organizationId: null };
const member: Principal = { userId: "u-member", role: "member", organizationId: "org-a" };

describe("scope: pure rules", () => {
  it("admin sees and manages everything", () => {
    expect(canSeeOrganization(admin, { id: "org-z" })).toBe(true);
    expect(canManageWorkspace(admin)).toBe(true);
    expect(canManageStructure(admin)).toBe(true);
    expect(canManageToken(admin, { ownerUserId: "u-member" })).toBe(true);
  });

  it("member sees only the organization of their own", () => {
    expect(canSeeOrganization(member, { id: "org-a" })).toBe(true);
    expect(canSeeOrganization(member, { id: "org-b" })).toBe(false);
    const orphan: Principal = { ...member, organizationId: null };
    expect(canSeeOrganization(orphan, { id: "org-a" })).toBe(false);
  });

  it("member does not manage the workspace, structure or other people's tokens", () => {
    expect(canManageWorkspace(member)).toBe(false);
    expect(canManageStructure(member)).toBe(false);
    expect(canManageToken(member, { ownerUserId: "u-admin" })).toBe(false);
    expect(canManageToken(member, { ownerUserId: null })).toBe(false);
    expect(canManageToken(member, { ownerUserId: "u-member" })).toBe(true);
  });

  it("nobody identified gets nothing", () => {
    expect(canSeeOrganization(null, { id: "o" })).toBe(false);
    expect(canManageWorkspace(null)).toBe(false);
    expect(principalFromAuth({ tokenId: "t", workspaceId: "w", tokenLabel: "x" })).toBeNull();
    expect(
      principalFromAuth({ tokenId: "t", workspaceId: "w", tokenLabel: "x", userId: "u", role: "member", organizationId: "o" }),
    ).toEqual({ userId: "u", role: "member", organizationId: "o" });
  });
});

describe("scope: database filters", () => {
  let world: TestWorld;
  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("filters cards, missions, projects and organizations in SQL, by the member's project links", async () => {
    world = await createTestWorld();
    const { db } = world;
    const [otherOrg] = await db
      .insert(organization)
      .values({ workspaceId: world.workspaceId, name: "Other" })
      .returning({ id: organization.id });
    const [emp] = await db
      .insert(user)
      .values({ email: "emp@example.test", passwordHash: "x", role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    await db.insert(project).values({ workspaceId: world.workspaceId, organizationId: otherOrg!.id, name: "Hidden", idPrefix: "HID" });
    const [side] = await db
      .insert(project)
      .values({ workspaceId: world.workspaceId, organizationId: world.organizationId, name: "Side", idPrefix: "SD" })
      .returning({ id: project.id });
    await db.insert(projectMember).values({ projectId: world.projectId, userId: emp!.id });
    await db.insert(task).values([
      { projectId: world.projectId, shortId: "OC-1", title: "legacy" },
      { projectId: world.projectId, shortId: "OC-2", title: "admin's", createdByUserId: world.adminUserId },
      { projectId: world.projectId, shortId: "OC-3", title: "mine", createdByUserId: emp!.id },
      { projectId: side!.id, shortId: "SD-1", title: "side", createdByUserId: world.adminUserId },
    ]);
    await db.insert(mission).values({
      workspaceId: world.workspaceId,
      organizationId: world.organizationId,
      title: "mine",
      createdByUserId: emp!.id,
    });

    const adminP = await principalFromUserId(db, world.adminUserId);
    const memberP = await principalFromUserId(db, emp!.id);
    expect(adminP?.role).toBe("admin");
    expect(memberP).toEqual({ userId: emp!.id, role: "member", organizationId: world.organizationId });

    const titles = async (p: typeof adminP) =>
      (await db.select({ t: task.title }).from(task).where(and(taskScope(p)))).map((r) => r.t).sort();
    expect(await titles(adminP)).toEqual(["admin's", "legacy", "mine", "side"]);
    // Every card of the linked project, whoever wrote it; none of the other.
    expect(await titles(memberP)).toEqual(["admin's", "legacy", "mine"]);
    expect(await titles(null)).toEqual([]);

    const missions = async (p: typeof adminP) =>
      (await db.select({ t: mission.title }).from(mission).where(and(missionScope(p)))).length;
    expect(await missions(adminP)).toBe(2); // fixture mission + the member's
    expect(await missions(memberP)).toBe(1);

    const projects = async (p: typeof adminP) =>
      (await db.select({ n: project.name }).from(project).where(and(projectScope(p)))).map((r) => r.n).sort();
    expect(await projects(adminP)).toEqual(["Hidden", "OverClick", "Side"]);
    expect(await projects(memberP)).toEqual(["OverClick"]);

    const orgs = async (p: typeof adminP) =>
      (await db.select({ id: organization.id }).from(organization).where(and(organizationScope(p)))).length;
    expect(await orgs(adminP)).toBe(3 - 1); // General + Other
    expect(await orgs(memberP)).toBe(1);

    // No link: no project and no card, the organization still theirs.
    await db.delete(projectMember).where(eq(projectMember.userId, emp!.id));
    expect(await titles(memberP)).toEqual([]);
    expect(await projects(memberP)).toEqual([]);
    expect(await orgs(memberP)).toBe(1);
  });

  it("an inactive user has no principal", async () => {
    world = await createTestWorld();
    await world.db.update(user).set({ active: false }).where(eq(user.id, world.adminUserId));
    expect(await principalFromUserId(world.db, world.adminUserId)).toBeNull();
  });
});

describe("authorship over MCP", () => {
  let world: TestWorld;
  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("the token carries its owner's identity", async () => {
    world = await createTestWorld();
    const result = await authenticateBearer(world.db, `Bearer ${world.secret}`);
    expect(result.ok && result.ctx).toMatchObject({ userId: world.adminUserId, role: "admin", organizationId: null });
  });

  it("a card and a mission created with a token record the token's owner", async () => {
    world = await createTestWorld();
    const auth = await authenticateBearer(world.db, `Bearer ${world.secret}`);
    if (!auth.ok) throw new Error("auth failed");
    const madeMission = await invokeToolForTests(world.db, auth.ctx, "mission_create", { title: "Authored" });
    const madeTask = await invokeToolForTests(world.db, auth.ctx, "task_create", {
      project_id: world.projectId,
      title: "Authored card",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      mode: "team",
      subtasks: [{ title: "sub", scope: "s", boundary: "b" }],
    });
    if (!madeMission.ok) throw new Error(JSON.stringify(madeMission));
    if (!madeTask.ok) throw new Error(JSON.stringify(madeTask));
    const missions = await world.db.select().from(mission).where(eq(mission.title, "Authored"));
    expect(missions[0]?.createdByUserId).toBe(world.adminUserId);
    const tasks = await world.db.select().from(task).where(eq(task.projectId, world.projectId));
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    for (const row of tasks) expect(row.createdByUserId).toBe(world.adminUserId);
  });
});

describe("migration 0041 backfill", () => {
  it("makes the existing user admin and owns every token, leaving cards and missions unauthored", async () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/drizzle");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const client = new PGlite();
    const apply = async (file: string) => {
      for (const s of readFileSync(resolve(dir, file), "utf8").split("--> statement-breakpoint")) {
        if (s.trim()) await client.exec(s.trim());
      }
    };
    const target = files.findIndex((f) => f.startsWith("0041_"));
    for (const f of files.slice(0, target)) await apply(f);
    await client.exec(`
      INSERT INTO workspace (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'W');
      INSERT INTO "user" (id, email, password_hash) VALUES ('00000000-0000-0000-0000-0000000000a1', 'a@x.test', 'x');
      INSERT INTO mcp_token (workspace_id, label, hash) VALUES ('00000000-0000-0000-0000-000000000001', 't1', 'h1');
      INSERT INTO mcp_token (workspace_id, label, hash, created_by_user_id) VALUES ('00000000-0000-0000-0000-000000000001', 't2', 'h2', '00000000-0000-0000-0000-0000000000a1');
      INSERT INTO mission (workspace_id, organization_id, title) SELECT workspace_id, id, 'm' FROM organization;
    `);
    for (const f of files.slice(target)) await apply(f);
    const users = await client.query<{ role: string; organization_id: string | null }>('SELECT role, organization_id FROM "user"');
    expect(users.rows).toEqual([{ role: "admin", organization_id: null }]);
    const tokens = await client.query<{ owner_user_id: string }>("SELECT owner_user_id FROM mcp_token");
    expect(tokens.rows.map((r) => r.owner_user_id)).toEqual(Array(2).fill("00000000-0000-0000-0000-0000000000a1"));
    const missions = await client.query<{ created_by_user_id: string | null }>("SELECT created_by_user_id FROM mission");
    expect(missions.rows.every((r) => r.created_by_user_id === null)).toBe(true);
    await client.close();
  });
});
