import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { executionAttempt, workspace } from "@agent-board/db";
import {
  ExecutorsUpdateFullOutputSchema,
  TaskClaimOutputSchema,
  TaskCreateFullOutputSchema as TaskCreateOutputSchema,
  toolContracts,
} from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createOverclickMcpServer } from "./server";
import { closeTestWorld, createTestWorld, TEST_EXECUTORS, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

/**
 * The board records the harness that ran and never chooses one (E2): the
 * Overclock app decides the CLI, the model and the effort. executors_update
 * stays in the contract for one release, accepted and ignored with a warning
 * in the OCL-202 pattern, and a claim is no longer checked against a list.
 */
describe("the executor list is no longer the board's to keep (E2)", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  function worker() {
    return {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "test-agent",
      canManage: false,
    };
  }

  function manager() {
    return {
      tokenId: world.manageTokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "owner-console",
      canManage: true,
    };
  }

  async function storedWorkspace() {
    const [ws] = await world.db
      .select()
      .from(workspace)
      .where(eq(workspace.id, world.workspaceId))
      .limit(1);
    return ws!;
  }

  async function createCard(title: string) {
    const created = await invokeTool(world.db, worker(), "task_create", {
      project_id: world.projectId,
      title,
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem: { cli: "codex" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("task_create failed");
    return TaskCreateOutputSchema.parse(created.value).task;
  }

  it("answers executors_update with ok and an 'ignored' warning, and writes nothing", async () => {
    world = await createTestWorld();
    const before = JSON.stringify((await storedWorkspace()).executors);

    const updated = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude",
      add_models: ["opus-9"],
      return: "ack",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    // The compact ack still matches the published contract.
    const ack = toolContracts.executors_update.output.parse(updated.value) as {
      id?: string;
      removed: boolean;
      changed: Record<string, unknown>;
      warnings?: string[];
    };
    expect(ack).toMatchObject({ id: "claude-code", removed: false, changed: {} });
    expect(ack.warnings?.[0]).toMatch(/executors_update was ignored/);
    expect(ack.warnings?.[0]).toContain("Overclock app");
    expect(JSON.stringify((await storedWorkspace()).executors)).toBe(before);
  });

  it("ignores a remove and a full return alike, and reads the config back untouched", async () => {
    world = await createTestWorld();
    const removed = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude-code",
      remove: true,
      return: "full",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const out = ExecutorsUpdateFullOutputSchema.parse(removed.value);
    expect(out.removed).toBe(false);
    expect(out.updated).toBe("claude-code");
    expect(out.executors.map((item) => item.id)).toEqual(TEST_EXECUTORS.map((item) => item.id));
    expect((removed.value as { warnings?: string[] }).warnings?.[0]).toMatch(/ignored/);
    expect((await storedWorkspace()).executors).toHaveLength(TEST_EXECUTORS.length);

    // A cli the board never heard of is not NOT_FOUND any more: nothing is
    // looked up, so there is nothing to miss.
    const unknown = await invokeTool(world.db, manager(), "executors_update", {
      cli: "nothing-here",
      remove: true,
    });
    expect(unknown.ok).toBe(true);
  });

  it("still refuses a worker token: the contract keeps its manage flag", async () => {
    world = await createTestWorld();
    const denied = await invokeTool(world.db, worker(), "executors_update", {
      cli: "codex",
      add_models: ["gpt-5.6-sol"],
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("PERMISSION_DENIED");
  });

  it("still validates the input it ignores: the contract did not change", async () => {
    world = await createTestWorld();
    const empty = await invokeTool(world.db, manager(), "executors_update", {
      cli: "claude-code",
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe("INVALID_ARGUMENT");
  });

  it("lets a claim through on a model and a cli nobody registered, and records the attempt", async () => {
    world = await createTestWorld();
    const card = await createCard("Claimed on a model the board never listed");
    const claimed = await invokeTool(world.db, worker(), "task_claim", {
      task_id: card.short_id,
      executor: { cli: "grok", model: "grok-4.6", effort: "high", session_id: "s-grok" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimOutputSchema.parse(claimed.value);
    expect(out.task.executor).toEqual({ cli: "grok", model: "grok-4-6", effort: "high" });

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.model).toBe("grok-4-6");
    expect(attempt?.modelSource).toBe("declared");
    expect(JSON.parse(attempt!.executor!)).toMatchObject({ cli: "grok", effort: "high" });

    // Nothing is learned into a list any more: the claim is the record.
    expect((await storedWorkspace()).seenExecutors).toEqual([]);

    const other = await createCard("A cli that is not in any catalog");
    const odd = await invokeTool(world.db, worker(), "task_claim", {
      task_id: other.short_id,
      executor: { cli: "some-new-cli", model: "whatever-1" },
    });
    expect(odd.ok).toBe(true);
  });

  it("publishes task_claim's model as free text, never a menu of the registered ones", async () => {
    world = await createTestWorld();
    const server = await createOverclickMcpServer({ db: world.db, ctx: worker() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "e2-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = (await client.listTools()).tools;
      const claim = tools.find((tool) => tool.name === "task_claim");
      const executor = (claim?.inputSchema.properties as Record<string, any>).executor;
      const model = executor.properties.model;
      expect(model.type).toBe("string");
      expect(model).not.toHaveProperty("enum");

      const update = tools.find((tool) => tool.name === "executors_update");
      expect(update?.description).toMatch(/ignored/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
