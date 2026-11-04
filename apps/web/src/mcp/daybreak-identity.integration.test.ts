import { executionAttempt, task, workspace } from "@agent-board/db";
import { InsightsQueryOutputSchema, TaskClaimOutputSchema } from "@agent-board/mcp-core";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindRecipeSettings } from "@agent-board/db/domain";
import { closeTestWorld, createTestWorld, TEST_EXECUTORS, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";
import { identityFromTranscript } from "./transcript-model";

const daybreak = "gpt-daybreak-blue-latest";
describe("Daybreak executor identity (OCL-190)", () => {
  let world: TestWorld;
  const dirs: string[] = [];
  afterEach(async () => {
    if (world) await closeTestWorld(world);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const ctx = () => ({ workspaceId: world.workspaceId, tokenId: world.tokenId, tokenLabel: "test" });
  async function setup() {
    world = await createTestWorld({ executors: [...TEST_EXECUTORS,
      { id: "codex", label: "Codex", enabled: true, models: [daybreak, "gpt-5.6-sol", "gpt-6-astra"] },
    ] });
  }

  it.each([[daybreak, daybreak], ["gpt-5.6-sol", "gpt-5-6-sol"], ["gpt-6-astra", "gpt-6-astra"]])(
    "preserves the effective identity on claim for %s", async (declared, expected) => {
      await setup();
      const [card] = await world.db.insert(task).values({ projectId: world.projectId, shortId: "OC-1", title: "Identity" }).returning();
      const result = await invokeTool(world.db, ctx(), "task_claim", { task_id: card!.id,
        executor: { cli: "codex", model: declared, effort: "max", session_id: "identity-session" } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const claimed = TaskClaimOutputSchema.parse(result.value);
      expect(claimed.attempt.executor).toMatchObject({ model: expected, effort: "max" });
      if (declared) expect(claimed.attempt.executor.model_source).toBe("declared");
      expect(claimed.usage_recipe?.command).toContain(`codex_model=${expected}`);
      expect((await world.db.select().from(executionAttempt))[0]?.model).toBe(expected);
      expect(claimed.task.executor).toMatchObject({ cli: "codex", model: expected, effort: "max" });
    },
  );

  it("never takes the model from a planned harness an old card still carries (OCL-202)", async () => {
    await setup();
    const [card] = await world.db.insert(task).values({ projectId: world.projectId, shortId: "OC-1", title: "Legacy plan",
      harness: { cli: "codex", model: daybreak, effort: "max" } }).returning();
    const result = await invokeTool(world.db, ctx(), "task_claim", { task_id: card!.id,
      executor: { cli: "codex", effort: "high", session_id: "legacy-session" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const claimed = TaskClaimOutputSchema.parse(result.value);
    expect(claimed.attempt.executor.model).toBeUndefined();
    expect(claimed.attempt.executor.model_source).toBeUndefined();
    expect(claimed.task.executor).toEqual({ cli: "codex", effort: "high" });
    // The plan is not erased: it stays in the column, unread.
    expect((await world.db.select().from(task))[0]?.harness).toMatchObject({ model: daybreak });
  });

  it("takes the card on a model the workspace never registered and records it (E2)", async () => {
    await setup();
    const [card] = await world.db.insert(task).values({ projectId: world.projectId, shortId: "OC-1", title: "Unlisted" }).returning();
    expect((await invokeTool(world.db, ctx(), "task_claim", { task_id: card!.id,
      executor: { cli: "codex", model: "unknown-model" } })).ok).toBe(true);
    expect((await world.db.select().from(task))[0]?.status).toBe("em_execucao");
    expect((await world.db.select().from(executionAttempt))[0]?.model).toBe("unknown-model");
  });

  it("keeps measured Daybreak tokens distinct through recipe, delivery and Insights", async () => {
    await setup();
    await world.db.update(workspace).set({ pricingEnabled: true }).where(eq(workspace.id, world.workspaceId));
    const [card] = await world.db.insert(task).values({ projectId: world.projectId, shortId: "OC-1", title: "Measured Daybreak",
      harness: { cli: "codex", model: daybreak, effort: "max" } }).returning();
    const result = await invokeTool(world.db, ctx(), "task_claim", { task_id: card!.id,
      executor: { cli: "codex", model: daybreak, effort: "max", session_id: "daybreak-fixture" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const claimed = TaskClaimOutputSchema.parse(result.value);
    const dir = mkdtempSync(join(tmpdir(), "ocl-190-"));
    dirs.push(dir);
    const transcript = join(dir, "rollout-fixture.jsonl");
    const timestamp = new Date().toISOString();
    writeFileSync(transcript, [
      { timestamp, type: "session_meta", payload: { id: "daybreak-fixture" } },
      { timestamp, type: "turn_context", payload: { model: daybreak, effort: "max" } },
      { timestamp, type: "event_msg", payload: { type: "token_count", info: {
        last_token_usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 20 },
        total_token_usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 20 },
      } } },
    ].map(row => JSON.stringify(row)).join("\n"));
    const measured = JSON.parse(execFileSync("sh", ["-c", bindRecipeSettings(claimed.usage_recipe!.command, { transcript })], { encoding: "utf8" }));
    expect(measured.segments).toEqual([{ model: daybreak, input: 50, output: 20, cache_read: 100, cache_write: 0 }]);
    expect(identityFromTranscript({ cli: "codex", path: transcript })?.model).toBe(daybreak);
    const { transcript: measuredPath, ...usage } = measured;
    expect((await invokeTool(world.db, ctx(), "task_deliver", { task_id: card!.id, summary: "Daybreak measured", usage,
      transcript: { cli: "codex", path: measuredPath, session_id: "daybreak-fixture" } })).ok).toBe(true);
    const [attempt] = await world.db.select().from(executionAttempt);
    expect(attempt).toMatchObject({ model: daybreak, costStatus: "computed", usageSegments: measured.segments });
    expect(Number(attempt?.costUsd)).toBeCloseTo(0.00064);
    const insights = await invokeTool(world.db, ctx(), "insights_query", { group_by: "model" });
    expect(insights.ok).toBe(true);
    if (insights.ok) expect(InsightsQueryOutputSchema.parse(insights.value).groups?.map(row => row.key)).toEqual([daybreak]);
  });
});
