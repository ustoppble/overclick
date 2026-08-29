import {
  TaskCreateFullOutputSchema as TaskCreateOutputSchema,
  TaskSearchOutputSchema,
} from "@agent-board/mcp-core";
import { project } from "@agent-board/db";
import { afterEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

const origem = { session_id: "sess_search", cli: "overclock" };

describe("task_search", () => {
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

  async function card(
    title: string,
    extra: Partial<{
      o_que: string;
      por_que: string;
      type: "feature" | "bug" | "rfc";
      project_id: string;
    }> = {},
  ) {
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: extra.project_id ?? world.projectId,
      title,
      type: extra.type ?? "bug",
      o_que: extra.o_que ?? "x",
      por_que: extra.por_que ?? "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("card not created");
    return TaskCreateOutputSchema.parse(created.value).task;
  }

  it("finds cards by words in title, o_que, por_que and comments, best match first", async () => {
    world = await createTestWorld();
    const byTitle = await card("Terminal panes go black under memory pressure");
    const byBody = await card("Odd rendering", {
      o_que: "black panes after the machine swaps",
    });
    const byWhy = await card("Slow start", {
      por_que: "users see black screens for a while",
    });
    const byComment = await card("Unrelated title");
    await invokeTool(world.db, ctx(), "task_update", {
      task_id: byComment.id,
      comment: "reporter says the panes turn black too",
      comment_kind: "report",
    });
    await card("Login button misaligned");

    const res = await invokeTool(world.db, ctx(), "task_search", {
      q: "black panes",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = TaskSearchOutputSchema.parse(res.value);
    // The default hit is the operational minimum: no uuid, no counts, no
    // resolved_in — every tool already accepts short_id.
    const shortIds = out.tasks.map((t) => t.short_id);
    expect(shortIds).toContain(byTitle.short_id);
    expect(shortIds).toContain(byBody.short_id);
    expect(shortIds).toContain(byWhy.short_id);
    expect(shortIds).toContain(byComment.short_id);
    expect(out.tasks[0]?.short_id).toBe(byTitle.short_id);
    const defaultHit = out.tasks.find((t) => t.short_id === byComment.short_id);
    expect(defaultHit?.o_que).toBe("x");
    expect(defaultHit).not.toHaveProperty("id");
    expect(defaultHit).not.toHaveProperty("resolved_in");
    expect(defaultHit).not.toHaveProperty("comments_count");
    expect(defaultHit).not.toHaveProperty("reports_count");
    expect(defaultHit).not.toHaveProperty("updated_at");

    // include: ["all"] reproduces the pre-OCL-96 full hit.
    const full = await invokeTool(world.db, ctx(), "task_search", {
      q: "black panes",
      include: ["all"],
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const fullOut = TaskSearchOutputSchema.parse(full.value);
    const hit = fullOut.tasks.find((t) => t.id === byComment.id);
    expect(hit?.reports_count).toBe(1);
    expect(hit?.comments_count).toBe(1);
    // Unset resolved_in is omitted, not sent as null.
    expect(hit).not.toHaveProperty("resolved_in");
    expect(hit?.o_que).toBe("x");
  });

  it("returns [] when nothing matches and truncates o_que to 300 chars", async () => {
    world = await createTestWorld();
    await card("Long body", { o_que: "z".repeat(1000) });
    const none = await invokeTool(world.db, ctx(), "task_search", {
      q: "unicorn sparkles",
    });
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(TaskSearchOutputSchema.parse(none.value).tasks).toEqual([]);

    const some = await invokeTool(world.db, ctx(), "task_search", {
      q: "long body",
    });
    expect(some.ok).toBe(true);
    if (!some.ok) return;
    const out = TaskSearchOutputSchema.parse(some.value);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]?.o_que).toHaveLength(300);
  });

  it("filters by project (prefix or uuid), type, status, and honours limit ≤ 20", async () => {
    world = await createTestWorld();
    const [other] = await world.db
      .insert(project)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        name: "Other",
        idPrefix: "OTH",
        nextNumber: 1,
      })
      .returning({ id: project.id });
    if (!other) throw new Error("no project");
    const inMain = await card("Search scope alpha");
    const inOther = await card("Search scope beta", { project_id: other.id });
    const feature = await card("Search scope gamma", { type: "feature" });
    await invokeTool(world.db, ctx(), "task_update", {
      task_id: inMain.id,
      resolved_in: "v1.2.0",
    });
    await invokeTool(world.db, ctx(), "task_update", {
      task_id: inOther.id,
      resolved_in: "v1.1.0",
    });

    const byPrefix = await invokeTool(world.db, ctx(), "task_search", {
      q: "search scope",
      project_id: "OTH",
    });
    expect(byPrefix.ok).toBe(true);
    if (!byPrefix.ok) return;
    expect(
      TaskSearchOutputSchema.parse(byPrefix.value).tasks.map((t) => t.short_id),
    ).toEqual([inOther.short_id]);

    const byType = await invokeTool(world.db, ctx(), "task_search", {
      q: "search scope",
      type: "feature",
    });
    expect(byType.ok).toBe(true);
    if (!byType.ok) return;
    expect(
      TaskSearchOutputSchema.parse(byType.value).tasks.map((t) => t.short_id),
    ).toEqual([feature.short_id]);

    const byRelease = await invokeTool(world.db, ctx(), "task_search", {
      q: "search scope",
      resolved_in: "v1.2.0",
    });
    expect(byRelease.ok).toBe(true);
    if (!byRelease.ok) return;
    expect(
      TaskSearchOutputSchema.parse(byRelease.value).tasks.map((t) => t.short_id),
    ).toEqual([inMain.short_id]);

    const missingRelease = await invokeTool(world.db, ctx(), "task_search", {
      q: "search scope",
      resolved_in: "v9.9.9",
    });
    expect(missingRelease.ok).toBe(true);
    if (!missingRelease.ok) return;
    expect(TaskSearchOutputSchema.parse(missingRelease.value).tasks).toEqual([]);

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: inMain.id,
    });
    expect(claimed.ok).toBe(true);
    const byStatus = await invokeTool(world.db, ctx(), "task_search", {
      q: "search scope",
      status: ["em_execucao"],
    });
    expect(byStatus.ok).toBe(true);
    if (!byStatus.ok) return;
    expect(
      TaskSearchOutputSchema.parse(byStatus.value).tasks.map((t) => t.short_id),
    ).toEqual([inMain.short_id]);

    for (let i = 0; i < 25; i++) await card(`Search scope bulk ${i}`);
    const capped = await invokeTool(world.db, ctx(), "task_search", {
      q: "search scope",
      limit: 20,
    });
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(TaskSearchOutputSchema.parse(capped.value).tasks).toHaveLength(20);

    const dflt = await invokeTool(world.db, ctx(), "task_search", {
      q: "search scope",
    });
    expect(dflt.ok).toBe(true);
    if (!dflt.ok) return;
    expect(TaskSearchOutputSchema.parse(dflt.value).tasks).toHaveLength(5);

    const tooMany = await invokeTool(world.db, ctx(), "task_search", {
      q: "search scope",
      limit: 21,
    });
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.error.code).toBe("INVALID_ARGUMENT");
  });

  it("never sees another workspace's cards and returns NOT_FOUND for an unknown project", async () => {
    world = await createTestWorld();
    await card("Private to this workspace");
    const foreign = await invokeTool(
      world.db,
      {
        tokenId: world.tokenId,
        workspaceId: "00000000-0000-4000-8000-000000000bad",
        tokenLabel: "x",
      },
      "task_search",
      { q: "private" },
    );
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(TaskSearchOutputSchema.parse(foreign.value).tasks).toEqual([]);

    const noProj = await invokeTool(world.db, ctx(), "task_search", {
      q: "private",
      project_id: "NOPE",
    });
    expect(noProj.ok).toBe(false);
    if (noProj.ok) return;
    expect(noProj.error.code).toBe("NOT_FOUND");
  });

  it("falls back to substring match when the query is a single fragment tsquery would drop", async () => {
    world = await createTestWorld();
    const c = await card("Card AGB-4711 dependency");
    const res = await invokeTool(world.db, ctx(), "task_search", { q: "4711" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(
      TaskSearchOutputSchema.parse(res.value).tasks.map((t) => t.short_id),
    ).toEqual([c.short_id]);
  });
});
