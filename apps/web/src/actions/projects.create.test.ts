import { project, user } from "@agent-board/db";
import { TaskCreateFullOutputSchema } from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeTestWorld,
  createTestWorld,
  insertOrganization,
  type TestWorld,
} from "../mcp/test-db";
import { invokeToolForTests as invokeTool } from "../mcp/test-tools";

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

const { createProjectAction } = await import("./projects");

/**
 * "+ Projeto" in Settings (E5): the same creation `project_create` runs, for
 * the admin at the screen.
 */
describe("createProjectAction", () => {
  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
  });
  afterEach(async () => {
    sessionUserId = "";
    await closeTestWorld(world);
  });

  it("creates the project with its prefix, and the next card is GLX-1", async () => {
    const made = await createProjectAction({
      name: "Galaxy",
      repoUrl: "https://github.com/acme/galaxy",
      prefix: "glx",
    });
    expect(made).toMatchObject({ ok: true, project: { idPrefix: "GLX", name: "Galaxy" } });

    const [row] = await world.db.select().from(project).where(eq(project.idPrefix, "GLX"));
    expect(row?.repoUrl).toBe("https://github.com/acme/galaxy");
    expect(row?.nextNumber).toBe(1);
    expect(row?.organizationId).toBe(world.organizationId);

    const card = await invokeTool(
      world.db,
      { tokenId: world.tokenId, workspaceId: world.workspaceId, tokenLabel: "test" },
      "task_create",
      {
        repo: "https://github.com/acme/galaxy",
        title: "Primeiro card",
        type: "feature",
        o_que: "Abrir o projeto.",
        por_que: "Provar o prefixo.",
        como_confirmo: [{ step: "ver o id", expected: "GLX-1" }],
        mode: "solo",
        origem: { session_id: "sess_e5", cli: "claude-code" },
      },
    );
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    expect(TaskCreateFullOutputSchema.parse(card.value).task.short_id).toBe("GLX-1");
  });

  it("derives the prefix from the name when none is typed", async () => {
    const made = await createProjectAction({ name: "Agent Board", repoUrl: "", prefix: "" });
    expect(made).toMatchObject({ ok: true, project: { idPrefix: "AB" } });
  });

  it("refuses a prefix another project owns, naming that project", async () => {
    const made = await createProjectAction({ name: "Other", repoUrl: "", prefix: "oc" });
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.error).toContain("OC");
    expect(made.error).toContain("OverClick");
    expect(await world.db.select().from(project)).toHaveLength(1);
  });

  it("refuses a prefix that is not 2 to 4 letters or digits", async () => {
    for (const prefix of ["G", "GLXYZ", "G-X"]) {
      expect(await createProjectAction({ name: "Galaxy", repoUrl: "", prefix })).toMatchObject({
        ok: false,
      });
    }
  });

  it("refuses a member, and writes nothing", async () => {
    const [member] = await world.db
      .insert(user)
      .values({
        email: "func@example.test",
        passwordHash: "x",
        role: "member",
        organizationId: world.organizationId,
      })
      .returning({ id: user.id });
    sessionUserId = member!.id;
    const made = await createProjectAction({ name: "Galaxy", repoUrl: "", prefix: "GLX" });
    expect(made).toMatchObject({ ok: false });
    expect(await world.db.select().from(project)).toHaveLength(1);
  });

  it("with several organizations and none chosen, refuses and lists the options", async () => {
    await insertOrganization(world.db, world.workspaceId, "Second");
    const made = await createProjectAction({ name: "Galaxy", repoUrl: "", prefix: "GLX" });
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.error).toContain("General");
    expect(made.error).toContain("Second");
  });

  it("with several organizations, the chosen one owns the project", async () => {
    const second = await insertOrganization(world.db, world.workspaceId, "Second");
    const made = await createProjectAction({
      name: "Galaxy",
      repoUrl: "",
      prefix: "GLX",
      organizationId: second,
    });
    expect(made.ok).toBe(true);
    const [row] = await world.db.select().from(project).where(eq(project.idPrefix, "GLX"));
    expect(row?.organizationId).toBe(second);
  });

  it("without a session, refuses", async () => {
    sessionUserId = "";
    expect(await createProjectAction({ name: "Galaxy", repoUrl: "", prefix: "GLX" })).toMatchObject({
      ok: false,
    });
  });
});
