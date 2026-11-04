import { project, projectMember, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../../../mcp/test-db";
import { linkedProjectName } from "./linked-project";

/**
 * "Meu agente" prints one project name in the connect commands. For a member
 * it may only be a project an admin linked to them, never the first project of
 * their organization.
 */
describe("account/agent: the project name shown to a member", () => {
  let world: TestWorld;
  let memberId: string;

  beforeEach(async () => {
    world = await createTestWorld();
    const [m] = await world.db
      .insert(user)
      .values({ email: "member@example.test", role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    memberId = m!.id;
  });

  afterEach(async () => {
    await closeTestWorld(world);
  });

  const asMember = () => ({ userId: memberId, role: "member" as const, organizationId: world.organizationId });

  it("returns null for a member with no linked project, even though the organization has projects", async () => {
    const [p] = await world.db.select({ name: project.name }).from(project);
    expect(p?.name).toBeTruthy();
    expect(await linkedProjectName(world.db, world.workspaceId, asMember())).toBeNull();
  });

  it("returns a linked project's name, and never an unlinked one", async () => {
    const [secret] = await world.db
      .insert(project)
      .values({ workspaceId: world.workspaceId, organizationId: world.organizationId, name: "Projeto sigiloso", idPrefix: "SIG", nextNumber: 1 })
      .returning({ id: project.id });
    expect(secret).toBeTruthy();
    await world.db.insert(projectMember).values({ projectId: world.projectId, userId: memberId });
    const [linked] = await world.db.select({ name: project.name }).from(project).where(eq(project.id, world.projectId));
    const name = await linkedProjectName(world.db, world.workspaceId, asMember());
    expect(name).toBe(linked!.name);
    expect(name).not.toBe("Projeto sigiloso");
  });

  it("returns the first project for an admin, who has no fence", async () => {
    const name = await linkedProjectName(world.db, world.workspaceId, {
      userId: world.adminUserId,
      role: "admin",
      organizationId: null,
    });
    expect(name).toBeTruthy();
  });

  it("returns null for a principal that cannot be identified", async () => {
    expect(await linkedProjectName(world.db, world.workspaceId, null)).toBeNull();
  });
});
