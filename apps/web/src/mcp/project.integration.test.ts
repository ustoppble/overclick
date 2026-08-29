import { project, projectContextAudit, workspace } from "@agent-board/db";
import { eq } from "drizzle-orm";
import {
  ProjectCreateOutputSchema,
  ProjectDeleteOutputSchema,
  ProjectGetOutputSchema,
  ProjectListOutputSchema,
  ProjectUpdateFullOutputSchema as ProjectUpdateOutputSchema,
  TaskCreateFullOutputSchema as TaskCreateOutputSchema,
  TaskClaimOutputSchema,
  TaskGetOutputSchema,
  TaskListOutputSchema,
  TaskUpdateFullOutputSchema as TaskUpdateOutputSchema,
} from "@agent-board/mcp-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeTestWorld,
  createTestWorld,
  insertOrganization,
  type TestWorld,
} from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

const origem = { session_id: "sess_fresh", cli: "claude-code" };

describe("projects over MCP", () => {
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

  function cardArgs(projectRef: string) {
    return {
      project_id: projectRef,
      title: "Primeiro card",
      type: "feature" as const,
      o_que: "Fechar o loop.",
      por_que: "Sem projeto não há card.",
      como_confirmo: [{ step: "roda o fluxo", expected: "card criado" }],
      mode: "solo" as const,
      origem,
    };
  }

  it("creates a project and a card in it using only MCP, no database access", async () => {
    world = await createTestWorld();

    const created = await invokeTool(world.db, ctx(), "project_create", {
      name: "Agent Board",
      repo_url: "https://github.com/ustoppble/overclick",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const out = ProjectCreateOutputSchema.parse(created.value);
    expect(out.project.id_prefix).toBe("AB");
    expect(out.project.name).toBe("Agent Board");
    expect(out.project.repo_url).toBe("https://github.com/ustoppble/overclick");
    expect(out.project.next_number).toBe(1);
    expect(out.project.cards).toEqual({
      total: 0,
      aberto: 0,
      em_execucao: 0,
      feito: 0,
      validado: 0,
      descartado: 0,
    });

    const listed = await invokeTool(world.db, ctx(), "project_list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const list = ProjectListOutputSchema.parse(listed.value);
    expect(list.projects.map((row) => row.id_prefix)).toEqual(["OC", "AB"]);

    const byUuid = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      cardArgs(out.project.id),
    );
    expect(byUuid.ok).toBe(true);
    if (!byUuid.ok) return;
    expect(TaskCreateOutputSchema.parse(byUuid.value).task.short_id).toBe("AB-1");

    const byPrefix = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      cardArgs("ab"),
    );
    expect(byPrefix.ok).toBe(true);
    if (!byPrefix.ok) return;
    const second = TaskCreateOutputSchema.parse(byPrefix.value);
    expect(second.task.short_id).toBe("AB-2");
    expect(second.task.project_id).toBe(out.project.id);
  });

  it("counts cards by status in project_list", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "project_create", {
      name: "Counting",
    });
    if (!created.ok) throw new Error("project_create failed");
    const proj = ProjectCreateOutputSchema.parse(created.value).project;

    for (const _ of [1, 2, 3]) {
      const card = await invokeTool(
        world.db,
        ctx(),
        "task_create",
        cardArgs(proj.id_prefix),
      );
      expect(card.ok).toBe(true);
    }
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: `${proj.id_prefix}-1`,
      executor: { cli: "claude-code", model: "sonnet-5" },
    });
    expect(claimed.ok).toBe(true);

    const listed = await invokeTool(world.db, ctx(), "project_list", {});
    if (!listed.ok) throw new Error("project_list failed");
    const row = ProjectListOutputSchema.parse(listed.value).projects.find(
      (item) => item.id === proj.id,
    );
    expect(row?.cards).toEqual({
      total: 3,
      aberto: 2,
      em_execucao: 1,
      feito: 0,
      validado: 0,
      descartado: 0,
    });
    expect(row?.next_number).toBe(4);
  });

  it("creates, reads, updates and summarizes project context and current_version", async () => {
    world = await createTestWorld();
    const context = "\n# Architecture\n\n- apps/web\n- packages/db\n";
    const created = await invokeTool(world.db, ctx(), "project_create", {
      name: "Documented project",
      id_prefix: "DOC",
      context,
      current_version: "1.3.5",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(ProjectCreateOutputSchema.parse(created.value).project).toMatchObject({
      context,
      current_version: "1.3.5",
      has_context: true,
    });

    const got = await invokeTool(world.db, ctx(), "project_get", {
      project_id: "doc",
      view: "briefing",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(ProjectGetOutputSchema.parse(got.value).project.context).toBe(context);

    const listed = await invokeTool(world.db, ctx(), "project_list", {});
    if (!listed.ok) throw new Error("project_list failed");
    const summary = ProjectListOutputSchema.parse(listed.value).projects.find(
      (row) => row.id_prefix === "DOC",
    );
    expect(summary?.has_context).toBe(true);
    expect(summary).not.toHaveProperty("context");

    const updated = await invokeTool(world.db, ctx(), "project_update", {
      project_id: "DOC",
      context: "# New context",
      current_version: "1.4.0",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(ProjectUpdateOutputSchema.parse(updated.value).project).toMatchObject({
      context: "# New context",
      current_version: "1.4.0",
    });

    const card = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      cardArgs("DOC"),
    );
    if (!card.ok) throw new Error("task_create failed");
    const taskId = TaskCreateOutputSchema.parse(card.value).task.short_id;
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: taskId,
      executor: { cli: "claude-code", model: "sonnet-5" },
    });
    if (!claimed.ok) throw new Error("task_claim failed");
    const claimBriefing = TaskClaimOutputSchema.parse(claimed.value).briefing_markdown;
    expect(claimBriefing).toContain("## Project context");
    expect(claimBriefing).toContain("# New context");
    expect(claimBriefing).toContain("current_version: 1.4.0");
    expect(claimBriefing.indexOf("## Project context")).toBeGreaterThan(
      claimBriefing.indexOf("## Missão"),
    );

    const taskGot = await invokeTool(world.db, ctx(), "task_get", {
      task_id: taskId,
      view: "briefing",
    });
    if (!taskGot.ok) throw new Error("task_get failed");
    expect(TaskGetOutputSchema.parse(taskGot.value).briefing_markdown).toContain(
      "# New context",
    );

    const tooLong = await invokeTool(world.db, ctx(), "project_update", {
      project_id: "DOC",
      context: "x".repeat(32_001),
    });
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.error.code).toBe("INVALID_ARGUMENT");
    expect(tooLong.error.message).toContain("32000");
  });

  it("round-trips context sources and records manual updates", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "project_create", {
      name: "Synced project",
      id_prefix: "SYN",
      context_source: {
        releases_repo: "owner/releases",
        context_file: "owner/releases:context.md",
        refresh: "daily",
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const projectOut = ProjectCreateOutputSchema.parse(created.value).project;
    expect(projectOut.context_source).toEqual({
      releases_repo: "owner/releases",
      context_file: "owner/releases:context.md",
      refresh: "daily",
    });
    expect(projectOut.latest_prerelease).toBeNull();
    expect(projectOut.context_updated_at).not.toBeNull();

    const got = await invokeTool(world.db, ctx(), "project_get", {
      project_id: "SYN",
      view: "full",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(ProjectGetOutputSchema.parse(got.value).project.context_source).toEqual(
      projectOut.context_source,
    );

    const updated = await invokeTool(world.db, ctx(), "project_update", {
      project_id: "SYN",
      context: "# Manual context",
    });
    expect(updated.ok).toBe(true);
    const audits = await world.db
      .select({ source: projectContextAudit.source })
      .from(projectContextAudit)
      .where(eq(projectContextAudit.projectId, projectOut.id));
    expect(audits.some((row) => row.source === "manual")).toBe(true);
  });

  it("takes an explicit prefix and refuses one already in use", async () => {
    world = await createTestWorld();

    const explicit = await invokeTool(world.db, ctx(), "project_create", {
      name: "Agent Board",
      id_prefix: "agb",
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(ProjectCreateOutputSchema.parse(explicit.value).project.id_prefix).toBe(
      "AGB",
    );

    const clash = await invokeTool(world.db, ctx(), "project_create", {
      name: "Another Great Board",
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.error.code).toBe("INVALID_ARGUMENT");
    expect(clash.error.message).toContain("AGB");
    expect(clash.error.message).toContain("already used");

    // The prefix of the seeded project is taken too, whatever the casing.
    const seeded = await invokeTool(world.db, ctx(), "project_create", {
      name: "Outro",
      id_prefix: "oc",
    });
    expect(seeded.ok).toBe(false);
  });

  it("rejects an invalid prefix and a name it cannot derive one from", async () => {
    world = await createTestWorld();

    const tooLong = await invokeTool(world.db, ctx(), "project_create", {
      name: "Board",
      id_prefix: "TOOLONG",
    });
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.error.code).toBe("INVALID_ARGUMENT");
    expect(tooLong.error.message).toContain("2 to 4 letters or digits");

    const underivable = await invokeTool(world.db, ctx(), "project_create", {
      name: "!!!",
    });
    expect(underivable.ok).toBe(false);
    if (underivable.ok) return;
    expect(underivable.error.code).toBe("INVALID_ARGUMENT");
    expect(underivable.error.message).toContain("id_prefix");
  });

  it("points an unknown project ref at project_list instead of leaking SQL", async () => {
    world = await createTestWorld();

    const created = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      cardArgs("NOPE"),
    );
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("NOT_FOUND");
    expect(created.error.message).toContain("project_list");
    expect(created.error.message).not.toContain("select");

    const listed = await invokeTool(world.db, ctx(), "task_list", {
      project_id: "NOPE",
    });
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error.code).toBe("NOT_FOUND");
    expect(listed.error.message).toContain("project_list");
  });

  it("filters task_list by the project prefix", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "project_create", {
      name: "Side Quest",
    });
    if (!created.ok) throw new Error("project_create failed");
    const proj = ProjectCreateOutputSchema.parse(created.value).project;
    const card = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      cardArgs(proj.id),
    );
    expect(card.ok).toBe(true);

    const listed = await invokeTool(world.db, ctx(), "task_list", {
      project_id: "sq",
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const out = TaskListOutputSchema.parse(listed.value);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]?.short_id).toBe("SQ-1");
  });

  it("never shows or resolves a project from another workspace", async () => {
    world = await createTestWorld();

    const [otherWs] = await world.db
      .insert(workspace)
      .values({ name: "Other", executors: [] })
      .returning({ id: workspace.id });
    if (!otherWs) throw new Error("failed to insert other workspace");
    await world.db.insert(project).values({
      workspaceId: otherWs.id,
      organizationId: await insertOrganization(world.db, otherWs.id),
      name: "Other Board",
      idPrefix: "ZZ",
      nextNumber: 1,
    });

    const listed = await invokeTool(world.db, ctx(), "project_list", {});
    if (!listed.ok) throw new Error("project_list failed");
    const out = ProjectListOutputSchema.parse(listed.value);
    expect(out.projects.map((row) => row.id_prefix)).not.toContain("ZZ");

    const created = await invokeTool(
      world.db,
      ctx(),
      "task_create",
      cardArgs("ZZ"),
    );
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("NOT_FOUND");

    // The same prefix is free in this workspace: uniqueness is per workspace.
    const mine = await invokeTool(world.db, ctx(), "project_create", {
      name: "Zulu Zone",
    });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    expect(ProjectCreateOutputSchema.parse(mine.value).project.id_prefix).toBe("ZZ");
  });

  it("renames a project and shows the new name in project_list", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "project_create", {
      name: "Funil",
    });
    if (!created.ok) throw new Error("project_create failed");
    const proj = ProjectCreateOutputSchema.parse(created.value).project;

    const renamed = await invokeTool(world.db, ctx(), "project_update", {
      project_id: proj.id_prefix,
      name: "Marketing",
      repo_url: "https://github.com/ustoppble/overclick",
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    const out = ProjectUpdateOutputSchema.parse(renamed.value).project;
    expect(out.name).toBe("Marketing");
    expect(out.repo_url).toBe("https://github.com/ustoppble/overclick");
    // The prefix is what the cards carry: a rename never touches it.
    expect(out.id_prefix).toBe("FUN");

    const listed = await invokeTool(world.db, ctx(), "project_list", {});
    if (!listed.ok) throw new Error("project_list failed");
    const row = ProjectListOutputSchema.parse(listed.value).projects.find(
      (item) => item.id === proj.id,
    );
    expect(row?.name).toBe("Marketing");

    const cleared = await invokeTool(world.db, ctx(), "project_update", {
      project_id: proj.id,
      repo_url: null,
    });
    if (!cleared.ok) throw new Error("project_update failed");
    expect(ProjectUpdateOutputSchema.parse(cleared.value).project.repo_url).toBeNull();
  });

  it("refuses a prefix change while the project holds cards and names the way out", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "project_create", {
      name: "Funil",
    });
    if (!created.ok) throw new Error("project_create failed");
    const proj = ProjectCreateOutputSchema.parse(created.value).project;

    // Empty, the prefix is still free to change.
    const empty = await invokeTool(world.db, ctx(), "project_update", {
      project_id: proj.id,
      id_prefix: "fnl",
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(ProjectUpdateOutputSchema.parse(empty.value).project.id_prefix).toBe("FNL");

    const card = await invokeTool(world.db, ctx(), "task_create", cardArgs("FNL"));
    expect(card.ok).toBe(true);

    const blocked = await invokeTool(world.db, ctx(), "project_update", {
      project_id: proj.id,
      id_prefix: "MKT",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.code).toBe("INVALID_ARGUMENT");
    expect(blocked.error.message).toContain("1 card");
    expect(blocked.error.message).toContain("FNL");
    expect(blocked.error.message).toContain("task_update");
    expect(blocked.error.message).toContain("project_id");

    // The name still moves: only the prefix is frozen.
    const renamed = await invokeTool(world.db, ctx(), "project_update", {
      project_id: proj.id,
      name: "Funil de conteúdo",
    });
    expect(renamed.ok).toBe(true);

    // A prefix another project already holds is a named error, not a constraint
    // violation, even on an empty project.
    const other = await invokeTool(world.db, ctx(), "project_create", {
      name: "Marketing",
    });
    if (!other.ok) throw new Error("project_create failed");
    const taken = await invokeTool(world.db, ctx(), "project_update", {
      project_id: ProjectCreateOutputSchema.parse(other.value).project.id,
      id_prefix: "FNL",
    });
    expect(taken.ok).toBe(false);
    if (taken.ok) return;
    expect(taken.error.code).toBe("INVALID_ARGUMENT");
    expect(taken.error.message).toContain("already used");
  });

  it("deletes an empty project, refuses one with cards and cascades under force", async () => {
    world = await createTestWorld();
    const withCards = await invokeTool(world.db, ctx(), "project_create", {
      name: "Funil",
    });
    if (!withCards.ok) throw new Error("project_create failed");
    const doomed = ProjectCreateOutputSchema.parse(withCards.value).project;
    const empty = await invokeTool(world.db, ctx(), "project_create", {
      name: "Marketing",
      id_prefix: "MKT",
    });
    if (!empty.ok) throw new Error("project_create failed");
    const spare = ProjectCreateOutputSchema.parse(empty.value).project;

    for (const _ of [1, 2]) {
      const card = await invokeTool(world.db, ctx(), "task_create", cardArgs("FUN"));
      expect(card.ok).toBe(true);
    }
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: "FUN-1",
      executor: { cli: "claude-code", model: "sonnet-5" },
    });
    expect(claimed.ok).toBe(true);

    const refused = await invokeTool(world.db, ctx(), "project_delete", {
      project_id: "FUN",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_ARGUMENT");
    expect(refused.error.message).toContain("2 cards");
    expect(refused.error.message).toContain("force: true");

    const stillThere = await invokeTool(world.db, ctx(), "task_list", {
      project_id: "FUN",
    });
    if (!stillThere.ok) throw new Error("task_list failed");
    expect(TaskListOutputSchema.parse(stillThere.value).tasks).toHaveLength(2);

    const emptied = await invokeTool(world.db, ctx(), "project_delete", {
      project_id: spare.id,
    });
    expect(emptied.ok).toBe(true);
    if (!emptied.ok) return;
    const gone = ProjectDeleteOutputSchema.parse(emptied.value);
    expect(gone.tasks_deleted).toBe(0);
    expect(gone.id_prefix).toBe("MKT");

    const forced = await invokeTool(world.db, ctx(), "project_delete", {
      project_id: "fun",
      force: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    const destroyed = ProjectDeleteOutputSchema.parse(forced.value);
    expect(destroyed.project_id).toBe(doomed.id);
    expect(destroyed.tasks_deleted).toBe(2);
    expect(destroyed.attempts_deleted).toBe(1);

    // Only the two named projects left; the seeded one never moved.
    const listed = await invokeTool(world.db, ctx(), "project_list", {});
    if (!listed.ok) throw new Error("project_list failed");
    expect(
      ProjectListOutputSchema.parse(listed.value).projects.map((row) => row.id_prefix),
    ).toEqual(["OC"]);
  });

  it("moves a card between projects, restamping the short id and keeping the old one", async () => {
    world = await createTestWorld();
    const source = await invokeTool(world.db, ctx(), "project_create", {
      name: "Funil",
    });
    if (!source.ok) throw new Error("project_create failed");
    const dest = await invokeTool(world.db, ctx(), "project_create", {
      name: "Marketing",
      id_prefix: "MKT",
    });
    if (!dest.ok) throw new Error("project_create failed");
    const target = ProjectCreateOutputSchema.parse(dest.value).project;

    // Two cards already in the destination, so the numbering has to continue
    // from where it is instead of restarting.
    for (const _ of [1, 2]) {
      const filler = await invokeTool(world.db, ctx(), "task_create", cardArgs("MKT"));
      expect(filler.ok).toBe(true);
    }
    const created = await invokeTool(world.db, ctx(), "task_create", {
      ...cardArgs("FUN"),
      mission: world.missionId,
    });
    if (!created.ok) throw new Error("task_create failed");
    const card = TaskCreateOutputSchema.parse(created.value).task;
    expect(card.short_id).toBe("FUN-1");

    const moved = await invokeTool(world.db, ctx(), "task_update", {
      task_id: "FUN-1",
      project_id: "mkt",
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const out = TaskUpdateOutputSchema.parse(moved.value);
    expect(out.task.short_id).toBe("MKT-3");
    expect(out.task.project_id).toBe(target.id);
    expect(out.task.previous_short_ids).toEqual(["FUN-1"]);
    // Missions are workspace wide and cross projects by design.
    expect(out.task.mission_id).toBe(world.missionId);
    expect(out.project_move?.short_ids).toEqual([{ from: "FUN-1", to: "MKT-3" }]);
    expect(out.project_move?.from_prefix).toBe("FUN");
    expect(out.project_move?.to_prefix).toBe("MKT");
    expect(out.subtasks_moved).toBe(0);

    // The destination counter advanced, so the next card there does not collide.
    const next = await invokeTool(world.db, ctx(), "task_create", cardArgs("MKT"));
    if (!next.ok) throw new Error("task_create failed");
    expect(TaskCreateOutputSchema.parse(next.value).task.short_id).toBe("MKT-4");

    // The card answers to its new id and left the source project behind.
    const sourceCards = await invokeTool(world.db, ctx(), "task_list", {
      project_id: "FUN",
    });
    if (!sourceCards.ok) throw new Error("task_list failed");
    expect(TaskListOutputSchema.parse(sourceCards.value).tasks).toHaveLength(0);

    const byNewId = await invokeTool(world.db, ctx(), "task_get", {
      task_id: "MKT-3",
    });
    expect(byNewId.ok).toBe(true);

    // Naming the project the card already sits in changes nothing.
    const noop = await invokeTool(world.db, ctx(), "task_update", {
      task_id: "MKT-3",
      project_id: "MKT",
    });
    if (!noop.ok) throw new Error("task_update failed");
    const same = TaskUpdateOutputSchema.parse(noop.value);
    expect(same.task.short_id).toBe("MKT-3");
    expect(same.project_move).toBeUndefined();

    const nowhere = await invokeTool(world.db, ctx(), "task_update", {
      task_id: "MKT-3",
      project_id: "NOPE",
    });
    expect(nowhere.ok).toBe(false);
    if (nowhere.ok) return;
    expect(nowhere.error.code).toBe("NOT_FOUND");
    expect(nowhere.error.message).toContain("project_list");
  });

  it("takes the subtasks with the parent and refuses to move one on its own", async () => {
    world = await createTestWorld();
    const source = await invokeTool(world.db, ctx(), "project_create", {
      name: "Funil",
    });
    if (!source.ok) throw new Error("project_create failed");
    const dest = await invokeTool(world.db, ctx(), "project_create", {
      name: "Marketing",
      id_prefix: "MKT",
    });
    if (!dest.ok) throw new Error("project_create failed");
    const target = ProjectCreateOutputSchema.parse(dest.value).project;

    const created = await invokeTool(world.db, ctx(), "task_create", {
      ...cardArgs("FUN"),
      mode: "team" as const,
      subtasks: [
        { title: "Primeira", scope: "backend", boundary: "sem tocar no front" },
        { title: "Segunda", scope: "frontend", boundary: "sem tocar no back" },
      ],
    });
    if (!created.ok) throw new Error("task_create failed");
    const family = TaskCreateOutputSchema.parse(created.value);
    expect(family.subtasks.map((child) => child.short_id)).toEqual([
      "FUN-1.1",
      "FUN-1.2",
    ]);

    const orphan = await invokeTool(world.db, ctx(), "task_update", {
      task_id: "FUN-1.1",
      project_id: "MKT",
    });
    expect(orphan.ok).toBe(false);
    if (orphan.ok) return;
    expect(orphan.error.code).toBe("INVALID_ARGUMENT");
    expect(orphan.error.message).toContain("parent");

    const moved = await invokeTool(world.db, ctx(), "task_update", {
      task_id: "FUN-1",
      project_id: "MKT",
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const out = TaskUpdateOutputSchema.parse(moved.value);
    expect(out.task.short_id).toBe("MKT-1");
    expect(out.subtasks_moved).toBe(2);
    expect(out.project_move?.short_ids).toEqual([
      { from: "FUN-1", to: "MKT-1" },
      { from: "FUN-1.1", to: "MKT-1.1" },
      { from: "FUN-1.2", to: "MKT-1.2" },
    ]);

    const landed = await invokeTool(world.db, ctx(), "task_list", {
      project_id: target.id,
    });
    if (!landed.ok) throw new Error("task_list failed");
    const tasks = TaskListOutputSchema.parse(landed.value).tasks;
    expect(tasks.map((row) => row.short_id).sort()).toEqual([
      "MKT-1",
      "MKT-1.1",
      "MKT-1.2",
    ]);

    const child = await invokeTool(world.db, ctx(), "task_get", {
      task_id: "MKT-1.2",
    });
    expect(child.ok).toBe(true);

    const left = await invokeTool(world.db, ctx(), "task_list", {
      project_id: "FUN",
    });
    if (!left.ok) throw new Error("task_list failed");
    expect(TaskListOutputSchema.parse(left.value).tasks).toHaveLength(0);
  });

  it("applies granular context updates to the current blob and guards stale rewrites", async () => {
    world = await createTestWorld();
    const initial = [
      "# Project",
      "",
      "## Alpha",
      "one",
      "",
      "## Beta",
      "two",
    ].join("\n");
    const seeded = await invokeTool(world.db, ctx(), "project_update", {
      project_id: world.projectId,
      context: initial,
    });
    expect(seeded.ok).toBe(true);

    const [alpha, beta] = await Promise.all([
      invokeTool(world.db, ctx(), "project_update", {
        project_id: world.projectId,
        context_ops: [
          { op: "replace_section", heading: "Alpha", text: "alpha changed" },
        ],
      }),
      invokeTool(world.db, ctx(), "project_update", {
        project_id: world.projectId,
        context_ops: [
          { op: "replace_section", heading: "Beta", text: "beta changed" },
        ],
      }),
    ]);
    expect(alpha.ok).toBe(true);
    expect(beta.ok).toBe(true);

    const got = await invokeTool(world.db, ctx(), "project_get", {
      project_id: world.projectId,
      view: "briefing",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(ProjectGetOutputSchema.parse(got.value).project.context).toContain(
      "## Alpha\nalpha changed",
    );
    expect(ProjectGetOutputSchema.parse(got.value).project.context).toContain(
      "## Beta\nbeta changed",
    );

    const stale = await invokeTool(world.db, ctx(), "project_update", {
      project_id: world.projectId,
      context: "# stale full rewrite",
      expected_len: initial.length,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("INVALID_ARGUMENT");

    const legacy = await invokeTool(world.db, ctx(), "project_update", {
      project_id: world.projectId,
      context: "# intentional full rewrite",
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(ProjectUpdateOutputSchema.parse(legacy.value).project.context).toBe(
      "# intentional full rewrite",
    );
  });
});
