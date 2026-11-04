import { executionAttempt, task } from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { loadRanClis } from "./recipes";

/**
 * The strip "the CLIs this board runs" on the Recipes tab used to read the
 * enabled executors. That list is gone (E2): the strip reads the CLIs the
 * attempts recorded, so a CLI that ran and was never "enabled" shows up, and
 * one that was enabled and never ran does not.
 */
describe("the CLIs this board runs come from the attempts (E2)", () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  async function ranWith(shortId: string, executor: Record<string, string>) {
    const [row] = await world.db
      .insert(task)
      .values({ projectId: world.projectId, shortId, title: shortId })
      .returning({ id: task.id });
    await world.db
      .insert(executionAttempt)
      .values({ taskId: row!.id, executor: JSON.stringify(executor) });
  }

  it("is empty on a board where nothing ran, whatever the old executor list says", async () => {
    expect(await loadRanClis(world.db, world.workspaceId)).toEqual([]);
  });

  it("lists each CLI that ran once, by its catalog id and label, including one never enabled", async () => {
    await ranWith("OC-1", { cli: "claude" });
    await ranWith("OC-2", { cli: "claude-code" });
    await ranWith("OC-3", { cli: "brand-new-cli" });
    await ranWith("OC-4", { cli: "Codex CLI" });
    // The orchestrator is not a CLI a recipe measures.
    await ranWith("OC-5", { cli: "overclock" });
    await ranWith("OC-6", { agent: "no-cli" });

    expect(await loadRanClis(world.db, world.workspaceId)).toEqual([
      { id: "brand-new-cli", label: "brand-new-cli" },
      { id: "claude-code", label: "Claude Code" },
      { id: "codex", label: "Codex" },
    ]);
  });
});
