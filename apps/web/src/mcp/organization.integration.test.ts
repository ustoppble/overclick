import {
  MissionCreateOutputSchema,
  MissionGetOutputSchema,
  MissionListOutputSchema,
  MissionUpdateFullOutputSchema as MissionUpdateOutputSchema,
  OrganizationCreateOutputSchema,
  OrganizationDeleteOutputSchema,
  OrganizationGetOutputSchema,
  OrganizationListOutputSchema,
  OrganizationUpdateFullOutputSchema as OrganizationUpdateOutputSchema,
  ProjectCreateOutputSchema,
  ProjectGetOutputSchema,
  ProjectListOutputSchema,
  ProjectUpdateFullOutputSchema as ProjectUpdateOutputSchema,
  TaskClaimOutputSchema,
  TaskCreateFullOutputSchema as TaskCreateOutputSchema,
  TaskListOutputSchema,
  TaskSearchOutputSchema,
} from "@agent-board/mcp-core";
import { afterEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

const origem = { session_id: "sess_org", cli: "claude-code" };

describe("organizations over MCP", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  function ctx() {
    return {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "test",
    };
  }

  function cardArgs(projectRef: string, title = "Primeiro card") {
    return {
      project_id: projectRef,
      title,
      type: "feature" as const,
      o_que: "Fechar o loop.",
      por_que: "Sem organização não há board por negócio.",
      como_confirmo: [{ step: "roda o fluxo", expected: "card criado" }],
      mode: "solo" as const,
      origem,
    };
  }

  /** The second business, so the workspace stops having an obvious answer. */
  async function secondOrganization(name = "Padre Miguel", context?: string) {
    const created = await invokeTool(world.db, ctx(), "organization_create", {
      name,
      ...(context ? { context } : {}),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("organization_create failed");
    return OrganizationCreateOutputSchema.parse(created.value).organization;
  }

  it("creates, reads, renames and lists an organization with its counts", async () => {
    world = await createTestWorld();

    const org = await secondOrganization(
      "Overclock",
      "# Overclock\n\nO IDE multi-agente.",
    );
    expect(org.name).toBe("Overclock");
    expect(org.has_context).toBe(true);
    expect(org.counts).toEqual({ projects: 0, missions: 0, cards: 0 });

    // The name is a handle, not just a label: it resolves like the uuid does.
    const read = await invokeTool(world.db, ctx(), "organization_get", {
      organization_id: "overclock",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(OrganizationGetOutputSchema.parse(read.value).organization.context).toContain(
      "IDE multi-agente",
    );

    const renamed = await invokeTool(world.db, ctx(), "organization_update", {
      organization_id: org.id,
      name: "Overclock Inc",
      return: "full",
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(
      OrganizationUpdateOutputSchema.parse(renamed.value).organization.name,
    ).toBe("Overclock Inc");

    const listed = await invokeTool(world.db, ctx(), "organization_list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const out = OrganizationListOutputSchema.parse(listed.value);
    expect(out.organizations.map((row) => row.name)).toEqual([
      "General",
      "Overclock Inc",
    ]);
    // The fixture's project and mission are already under General.
    const general = out.organizations.find((row) => row.name === "General");
    expect(general?.counts).toEqual({ projects: 1, missions: 1, cards: 0 });
  });

  it("refuses a second organization with the same name", async () => {
    world = await createTestWorld();
    const clash = await invokeTool(world.db, ctx(), "organization_create", {
      name: "general",
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) {
      expect(clash.error.code).toBe("INVALID_ARGUMENT");
      expect(clash.error.message).toContain("already exists");
    }
  });

  it("resolves the only organization when the call omits it", async () => {
    world = await createTestWorld();

    const created = await invokeTool(world.db, ctx(), "project_create", {
      name: "Agent Board",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const project = ProjectCreateOutputSchema.parse(created.value).project;
    expect(project.organization_id).toBe(world.organizationId);
    expect(project.organization_name).toBe("General");

    const mission = await invokeTool(world.db, ctx(), "mission_create", {
      title: "Norte solto",
      objective: "Sem organização declarada.",
    });
    expect(mission.ok).toBe(true);
    if (!mission.ok) return;
    const out = MissionCreateOutputSchema.parse(mission.value).mission;
    expect(out.organization_id).toBe(world.organizationId);
    expect(out.organization_name).toBe("General");
  });

  it("refuses project_create and mission_create when several organizations exist, listing them", async () => {
    world = await createTestWorld();
    await secondOrganization("Overclock");

    const refused = await invokeTool(world.db, ctx(), "project_create", {
      name: "Ambíguo",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("INVALID_ARGUMENT");
      expect(refused.error.message).toContain("General");
      expect(refused.error.message).toContain("Overclock");
    }

    // The refusal is a refusal: no half-created project is left behind.
    const listed = await invokeTool(world.db, ctx(), "project_list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const projects = ProjectListOutputSchema.parse(listed.value).projects;
    expect(projects.map((row) => row.name)).toEqual(["OverClick"]);

    const refusedMission = await invokeTool(world.db, ctx(), "mission_create", {
      title: "Ambígua",
    });
    expect(refusedMission.ok).toBe(false);
    if (!refusedMission.ok) {
      expect(refusedMission.error.code).toBe("INVALID_ARGUMENT");
      expect(refusedMission.error.message).toContain("Overclock");
    }

    // Naming one is all it takes.
    const named = await invokeTool(world.db, ctx(), "project_create", {
      name: "Do Overclock",
      organization: "Overclock",
    });
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(
      ProjectCreateOutputSchema.parse(named.value).project.organization_name,
    ).toBe("Overclock");
  });

  it("refuses an organization that does not exist and says which ones do", async () => {
    world = await createTestWorld();
    const refused = await invokeTool(world.db, ctx(), "project_create", {
      name: "Fantasma",
      organization: "Empresa Que Não Existe",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("NOT_FOUND");
      expect(refused.error.message).toContain("General");
    }
  });

  it("moves a project and a mission to another organization", async () => {
    world = await createTestWorld();
    const overclock = await secondOrganization("Overclock");

    const moved = await invokeTool(world.db, ctx(), "project_update", {
      project_id: "OC",
      organization: "Overclock",
      return: "full",
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const project = ProjectUpdateOutputSchema.parse(moved.value).project;
    expect(project.organization_id).toBe(overclock.id);
    expect(project.organization_name).toBe("Overclock");

    const movedMission = await invokeTool(world.db, ctx(), "mission_update", {
      mission_id: world.missionId,
      organization: overclock.id,
      return: "full",
    });
    expect(movedMission.ok).toBe(true);
    if (!movedMission.ok) return;
    expect(
      MissionUpdateOutputSchema.parse(movedMission.value).mission
        .organization_name,
    ).toBe("Overclock");

    const read = await invokeTool(world.db, ctx(), "mission_get", {
      mission_id: world.missionId,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(
      MissionGetOutputSchema.parse(read.value).mission.organization_id,
    ).toBe(overclock.id);
  });

  it("filters projects, missions, cards and search by organization", async () => {
    world = await createTestWorld();
    const overclock = await secondOrganization("Overclock");

    const created = await invokeTool(world.db, ctx(), "project_create", {
      name: "Site do Overclock",
      organization: "Overclock",
      id_prefix: "SITE",
    });
    if (!created.ok) throw new Error("project_create failed");
    const site = ProjectCreateOutputSchema.parse(created.value).project;

    await invokeTool(world.db, ctx(), "task_create", cardArgs("OC", "Card General"));
    await invokeTool(
      world.db,
      ctx(),
      "task_create",
      cardArgs("SITE", "Card Overclock"),
    );
    await invokeTool(world.db, ctx(), "mission_create", {
      title: "Missão do site",
      organization: "Overclock",
      objective: "Publicar a home.",
    });

    const projects = await invokeTool(world.db, ctx(), "project_list", {
      organization: "Overclock",
    });
    if (!projects.ok) throw new Error("project_list failed");
    expect(
      ProjectListOutputSchema.parse(projects.value).projects.map((row) => row.id),
    ).toEqual([site.id]);

    const missions = await invokeTool(world.db, ctx(), "mission_list", {
      organization: overclock.id,
    });
    if (!missions.ok) throw new Error("mission_list failed");
    expect(
      MissionListOutputSchema.parse(missions.value).missions.map(
        (row) => row.title,
      ),
    ).toEqual(["Missão do site"]);

    const cards = await invokeTool(world.db, ctx(), "task_list", {
      organization: "Overclock",
    });
    if (!cards.ok) throw new Error("task_list failed");
    expect(
      TaskListOutputSchema.parse(cards.value).tasks.map((row) => row.title),
    ).toEqual(["Card Overclock"]);

    const hits = await invokeTool(world.db, ctx(), "task_search", {
      q: "Card",
      organization: "Overclock",
    });
    if (!hits.ok) throw new Error("task_search failed");
    expect(
      TaskSearchOutputSchema.parse(hits.value).tasks.map((row) => row.title),
    ).toEqual(["Card Overclock"]);
  });

  it("returns the organization on every project read", async () => {
    world = await createTestWorld();

    const listed = await invokeTool(world.db, ctx(), "project_list", {});
    if (!listed.ok) throw new Error("project_list failed");
    const [first] = ProjectListOutputSchema.parse(listed.value).projects;
    expect(first?.organization_id).toBe(world.organizationId);
    expect(first?.organization_name).toBe("General");

    const read = await invokeTool(world.db, ctx(), "project_get", {
      project_id: "OC",
    });
    if (!read.ok) throw new Error("project_get failed");
    expect(
      ProjectGetOutputSchema.parse(read.value).project.organization_name,
    ).toBe("General");
  });

  it("refuses to delete an organization that still holds rows, with the counts that block it", async () => {
    world = await createTestWorld();

    const refused = await invokeTool(world.db, ctx(), "organization_delete", {
      organization_id: "General",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("INVALID_ARGUMENT");
      expect(refused.error.message).toContain("1 project");
      expect(refused.error.message).toContain("1 mission");
    }

    const still = await invokeTool(world.db, ctx(), "organization_list", {});
    if (!still.ok) throw new Error("organization_list failed");
    expect(
      OrganizationListOutputSchema.parse(still.value).organizations,
    ).toHaveLength(1);
  });

  it("deletes an empty organization, and hands the rows over with reassign_to", async () => {
    world = await createTestWorld();
    const overclock = await secondOrganization("Overclock");

    const empty = await invokeTool(world.db, ctx(), "organization_delete", {
      organization_id: overclock.id,
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    const emptyOut = OrganizationDeleteOutputSchema.parse(empty.value);
    expect(emptyOut.reassigned_to).toBeNull();
    expect(emptyOut.projects_reassigned).toBe(0);

    const heir = await secondOrganization("Overclock Inc");
    const moved = await invokeTool(world.db, ctx(), "organization_delete", {
      organization_id: "General",
      reassign_to: "Overclock Inc",
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const out = OrganizationDeleteOutputSchema.parse(moved.value);
    expect(out.reassigned_to).toEqual({ id: heir.id, name: "Overclock Inc" });
    expect(out.projects_reassigned).toBe(1);
    expect(out.missions_reassigned).toBe(1);

    // The project and the mission survived the delete and moved together.
    const projects = await invokeTool(world.db, ctx(), "project_list", {});
    if (!projects.ok) throw new Error("project_list failed");
    const [project] = ProjectListOutputSchema.parse(projects.value).projects;
    expect(project?.organization_id).toBe(heir.id);

    const missions = await invokeTool(world.db, ctx(), "mission_list", {});
    if (!missions.ok) throw new Error("mission_list failed");
    const [mission] = MissionListOutputSchema.parse(missions.value).missions;
    expect(mission?.organization_id).toBe(heir.id);

    const left = await invokeTool(world.db, ctx(), "organization_list", {});
    if (!left.ok) throw new Error("organization_list failed");
    const remaining = OrganizationListOutputSchema.parse(left.value);
    expect(remaining.organizations.map((row) => row.name)).toEqual([
      "Overclock Inc",
    ]);
    expect(remaining.organizations[0]?.counts).toEqual({
      projects: 1,
      missions: 1,
      cards: 0,
    });
  });

  it("refuses reassign_to pointing at the organization being deleted", async () => {
    world = await createTestWorld();
    const refused = await invokeTool(world.db, ctx(), "organization_delete", {
      organization_id: "General",
      reassign_to: world.organizationId,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("INVALID_ARGUMENT");
  });

  it("puts the organization context in the claim briefing, above the project block", async () => {
    world = await createTestWorld();

    await invokeTool(world.db, ctx(), "organization_update", {
      organization_id: "General",
      context: "# Regras do negócio\n\nTudo em português com o cliente.",
    });
    await invokeTool(world.db, ctx(), "project_update", {
      project_id: "OC",
      context: "# Regras do repositório\n\nTestes antes do commit.",
      return: "full",
    });

    const created = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      cardArgs("OC", "Card com contexto"),
    );
    if (!created.ok) throw new Error("task_create failed");
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.short_id,
      executor: { cli: "claude-code", model: "opus-5" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const briefing = TaskClaimOutputSchema.parse(claimed.value).briefing_markdown;

    expect(briefing).toContain("## Organization context");
    expect(briefing).toContain("Tudo em português com o cliente.");
    // Above the project block: the business rules come before the repo rules.
    expect(briefing.indexOf("## Organization context")).toBeLessThan(
      briefing.indexOf("## Project context"),
    );
  });
});
