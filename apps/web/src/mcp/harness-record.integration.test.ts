import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { executionAttempt, task } from "@agent-board/db";
import {
  TaskClaimOutputSchema,
  TaskCreateFullOutputSchema,
  TaskGetOutputSchema,
  TaskListOutputSchema,
  TaskSearchOutputSchema,
  TaskUpdateFullOutputSchema,
  toolContracts,
} from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createOverclickMcpServer } from "./server";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

/**
 * OCL-202: the board records which harness ran a card and never decides one.
 * The owner asked for "the harness table" and an agent went to the board's
 * policy instead of the Overclock app's; two tables with one name. The board's
 * copy is gone: cards are born without a harness, the claim records what runs
 * them (cli, model, effort) and the delivery records what it cost.
 */
describe("the board records the harness that ran and never plans one (OCL-202)", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  function ctx() {
    return {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "test-agent",
    };
  }

  const contract = {
    type: "bug" as const,
    o_que: "Login authenticates again.",
    por_que: "Nobody can sign in.",
    como_confirmo: [{ step: "open /login", expected: "lands on home" }],
    origem: { agent: "test" },
  };

  async function createCard(title: string, extra: Record<string, unknown> = {}) {
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title,
      ...contract,
      ...extra,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    return TaskCreateFullOutputSchema.parse(created.value);
  }

  async function storedHarness(taskId: string) {
    const [row] = await world.db.select().from(task).where(eq(task.id, taskId));
    return row?.harness ?? null;
  }

  it("publishes no policy tool, and says where the harness table lives", async () => {
    world = await createTestWorld();
    const server = await createOverclickMcpServer({ db: world.db, ctx: ctx() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ocl-202-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const gone of ["harness_list", "harness_recommend", "harness_set"]) {
        expect(names).not.toContain(gone);
      }
      expect(names).toContain("task_claim");

      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("never decides one");
      expect(instructions).toContain("overclock_list kind: harness");

      const called = await client.callTool({ name: "harness_list", arguments: {} });
      expect(called.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("creates a card with no harness at all", async () => {
    world = await createTestWorld();
    const created = await createCard("Born without a harness");
    expect(created.task).not.toHaveProperty("harness");
    expect(created.task.executor).toBeUndefined();
    expect(created).not.toHaveProperty("warnings");
    expect(await storedHarness(created.task.id)).toBeNull();

    const got = await invokeTool(world.db, ctx(), "task_get", { task_id: created.task.short_id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const read = TaskGetOutputSchema.parse(got.value).task;
    expect(read).not.toHaveProperty("harness");
    expect(read).not.toHaveProperty("executor");
  });

  it("accepts the old harness input with a warning instead of an error, and stores nothing", async () => {
    world = await createTestWorld();
    const legacy = { cli: "codex", model: "gpt-5.6-sol", effort: "xhigh" };
    const created = await createCard("Old client", { harness: legacy });
    expect(created.warnings?.[0]).toMatch(/harness was ignored/);
    expect(await storedHarness(created.task.id)).toBeNull();

    // The compact acknowledgement carries the same warning.
    const ack = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Old client, ack",
      ...contract,
      harness: legacy,
      return: "ack",
    });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    const parsedAck = toolContracts.task_create.output.parse(ack.value) as {
      warnings?: string[];
      changed: Record<string, unknown>;
    };
    expect(parsedAck.warnings?.[0]).toMatch(/harness was ignored/);
    expect(parsedAck.changed).not.toHaveProperty("harness");

    // Subtasks too: a team card with a per-child harness still lands.
    const team = await createCard("Old team card", {
      mode: "team",
      subtasks: [{ title: "part", scope: "x", boundary: "y", harness: legacy }],
    });
    expect(team.warnings?.[0]).toMatch(/harness was ignored/);
    expect(await storedHarness(team.subtasks[0]!.id)).toBeNull();

    // task_update applies the rest of the update and ignores the harness.
    const updated = await invokeTool(world.db, ctx(), "task_update", {
      task_id: created.task.short_id,
      comment: "still editable",
      harness: legacy,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const updatedOut = TaskUpdateFullOutputSchema.parse(updated.value);
    expect(updatedOut.warnings?.[0]).toMatch(/harness was ignored/);
    expect(await storedHarness(created.task.id)).toBeNull();

    // An update that carries nothing but a harness is a no-op with a warning.
    const onlyHarness = await invokeTool(world.db, ctx(), "task_update", {
      task_id: created.task.short_id,
      harness: legacy,
      return: "ack",
    });
    expect(onlyHarness.ok).toBe(true);
    if (!onlyHarness.ok) return;
    const onlyAck = toolContracts.task_update.output.parse(onlyHarness.value) as {
      warnings?: string[];
      changed: Record<string, unknown>;
    };
    expect(onlyAck.warnings?.[0]).toMatch(/harness was ignored/);
    expect(onlyAck.changed).toEqual({});
  });

  it("tolerates include harness on task_list and task_search, with a warning", async () => {
    world = await createTestWorld();
    await createCard("Old queue");
    const listed = await invokeTool(world.db, ctx(), "task_list", { include: ["harness"] });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const list = TaskListOutputSchema.parse(listed.value);
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).not.toHaveProperty("harness");
    expect(list.warnings?.[0]).toMatch(/include harness was ignored/);

    const plain = await invokeTool(world.db, ctx(), "task_list", {});
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(TaskListOutputSchema.parse(plain.value)).not.toHaveProperty("warnings");

    const searched = await invokeTool(world.db, ctx(), "task_search", {
      q: "Old queue",
      include: ["harness"],
    });
    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    expect(TaskSearchOutputSchema.parse(searched.value).warnings?.[0]).toMatch(
      /include harness was ignored/,
    );
  });

  it("records on the card the cli, model and effort the claim runs with", async () => {
    world = await createTestWorld();
    const created = await createCard("Records the run");
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: created.task.short_id,
      executor: { cli: "claude-code", model: "opus-5", effort: "max", session_id: "s-202" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimOutputSchema.parse(claimed.value);
    expect(out.task.executor).toEqual({ cli: "claude-code", model: "opus-5", effort: "max" });
    expect(out.attempt.executor).toMatchObject({ cli: "claude-code", model: "opus-5", effort: "max" });
    expect(out).not.toHaveProperty("harness_divergence");
    expect(out.briefing_markdown).toContain("## Recorded at claim");
    expect(out.briefing_markdown).toContain("- effort: max");
    expect(out.briefing_markdown).not.toContain("## Harness");

    const got = await invokeTool(world.db, ctx(), "task_get", { task_id: created.task.short_id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(TaskGetOutputSchema.parse(got.value).task.executor).toEqual({
      cli: "claude-code",
      model: "opus-5",
      effort: "max",
    });
  });

  it("keeps the record (cli, model, effort, model_source) through claim and deliver on a model nobody registered (E2)", async () => {
    world = await createTestWorld();
    const created = await createCard("Ran on a model outside the old list");
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: created.task.short_id,
      executor: { cli: "codex", model: "gpt-5.6-sol", effort: "xhigh", session_id: "s-e2" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const record = async () => {
      const [attempt] = await world.db
        .select()
        .from(executionAttempt)
        .where(eq(executionAttempt.taskId, created.task.id));
      return {
        cli: JSON.parse(attempt!.executor!).cli,
        effort: JSON.parse(attempt!.executor!).effort,
        model: attempt!.model,
        model_source: attempt!.modelSource,
      };
    };
    const atClaim = await record();
    expect(atClaim).toEqual({
      cli: "codex",
      effort: "xhigh",
      model: "gpt-5-6-sol",
      model_source: "declared",
    });

    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: created.task.short_id,
      summary: "delivered",
      usage: { segments: [{ model: "gpt-5.6-sol", input: 10, output: 5 }], turns: 1 },
    });
    expect(delivered.ok).toBe(true);
    expect(await record()).toEqual(atClaim);

    const got = await invokeTool(world.db, ctx(), "task_get", { task_id: created.task.short_id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(TaskGetOutputSchema.parse(got.value).task.executor).toEqual({
      cli: "codex",
      model: "gpt-5-6-sol",
      effort: "xhigh",
    });
  });

  it("keeps a claim that sends no effort valid, and says the effort went undeclared", async () => {
    world = await createTestWorld();
    const created = await createCard("Old claim without effort");
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: created.task.short_id,
      executor: { cli: "claude-code", model: "sonnet-5", session_id: "s-old" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimOutputSchema.parse(claimed.value);
    expect(out.task.executor).toEqual({ cli: "claude-code", model: "sonnet-5" });
    expect(out.briefing_markdown).toContain("effort: not declared");
  });

  it("hides the planned harness an old card still stores, without erasing it", async () => {
    world = await createTestWorld();
    const [legacy] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        shortId: "OC-90",
        title: "Card from before OCL-202",
        harness: { cli: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
      })
      .returning();

    const got = await invokeTool(world.db, ctx(), "task_get", { task_id: "OC-90", view: "full" });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const read = TaskGetOutputSchema.parse(got.value);
    expect(read.task).not.toHaveProperty("harness");
    expect(read.briefing_markdown).not.toContain("gpt-5.6-sol");

    // The claim takes nothing from the old plan: no model was declared, so
    // none is recorded until the usage measures one.
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: "OC-90",
      executor: { cli: "claude-code", effort: "high", session_id: "s-legacy" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(TaskClaimOutputSchema.parse(claimed.value).task.executor).toEqual({
      cli: "claude-code",
      effort: "high",
    });
    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, legacy!.id));
    expect(attempt?.model).toBeNull();

    // Kept as read-only history in the column: nothing rewrote it.
    expect(await storedHarness(legacy!.id)).toMatchObject({ model: "gpt-5.6-sol", effort: "xhigh" });
  });

  it("claims a reopened card on what the executor declares, never on an escalated model", async () => {
    world = await createTestWorld();
    const created = await createCard("Reopened");
    const first = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: created.task.short_id,
      executor: { cli: "claude-code", model: "sonnet-5", effort: "medium", session_id: "s-1" },
    });
    expect(first.ok).toBe(true);
    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: created.task.short_id,
      summary: "first delivery",
      usage: { segments: [{ model: "sonnet-5", input: 10, output: 5 }], turns: 1 },
    });
    expect(delivered.ok).toBe(true);
    const reopened = await invokeTool(world.db, ctx(), "task_reopen", {
      task_id: created.task.short_id,
      reason: "the test is missing",
    });
    expect(reopened.ok).toBe(true);

    const second = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: created.task.short_id,
      executor: { cli: "claude-code", model: "sonnet-5", effort: "high", session_id: "s-2" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const out = TaskClaimOutputSchema.parse(second.value);
    expect(out.task.executor).toEqual({ cli: "claude-code", model: "sonnet-5", effort: "high" });
    expect(out.briefing_markdown).not.toContain("subiu um elo da cadeia");
    expect(await storedHarness(created.task.id)).toBeNull();
  });
});
