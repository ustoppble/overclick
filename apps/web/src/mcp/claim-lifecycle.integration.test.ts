import {
  TaskClaimOutputSchema,
  TaskCreateOutputSchema,
  TaskHeartbeatOutputSchema,
  TaskReleaseOutputSchema,
} from "@agent-board/mcp-core";
import {
  executionAttempt,
  taskComment,
} from "@agent-board/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeTool } from "./tools";

const origem = { cli: "overclock", session_id: "claim-lifecycle-test" };

describe("orphaned claim lifecycle", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  const ctxA = () => ({
    tokenId: world.tokenId,
    workspaceId: world.workspaceId,
    tokenLabel: "executor-a",
  });
  const ctxB = () => ({
    tokenId: world.secondTokenId,
    workspaceId: world.workspaceId,
    tokenLabel: "executor-b",
  });
  const manager = () => ({
    tokenId: world.manageTokenId,
    workspaceId: world.workspaceId,
    tokenLabel: "owner-console",
    canManage: true,
  });

  async function card(title: string) {
    const created = await invokeTool(world.db, ctxA(), "task_create", {
      project_id: world.projectId,
      title,
      type: "bug",
      o_que: "O claim pode ser liberado ou expirar.",
      por_que: "Um executor pode morrer.",
      como_confirmo: [{ step: "retoma", expected: "novo attempt" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("card creation failed");
    return TaskCreateOutputSchema.parse(created.value).task;
  }

  it("releases through the claiming token, preserves usage and allows a new claim", async () => {
    world = await createTestWorld();
    const created = await card("Release owned claim");
    await invokeTool(world.db, ctxA(), "task_claim", { task_id: created.id });
    await invokeTool(world.db, ctxA(), "task_update", {
      task_id: created.id,
      usage: { tokens_in: 120, tokens_out: 30, duration_ms: 2_000, turns: 2 },
    });

    const released = await invokeTool(world.db, ctxA(), "task_release", {
      task_id: created.short_id,
      reason: "executor process stopped",
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    const out = TaskReleaseOutputSchema.parse(released.value);
    expect(out.task.status).toBe("aberto");
    expect(out.task.claimed_by).toBeNull();
    expect(out.attempt.result).toBe("abandoned");
    expect(out.attempt.result_note).toBe("executor process stopped");
    expect(out.attempt.usage?.tokens_in).toBe(120);

    const reclaimed = await invokeTool(world.db, ctxB(), "task_claim", {
      task_id: created.id,
    });
    expect(reclaimed.ok).toBe(true);
  });

  it("denies another worker token but lets a manage token release", async () => {
    world = await createTestWorld();
    const created = await card("Release authorization");
    await invokeTool(world.db, ctxA(), "task_claim", { task_id: created.id });

    const denied = await invokeTool(world.db, ctxB(), "task_release", {
      task_id: created.id,
      reason: "not mine",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("PERMISSION_DENIED");

    const released = await invokeTool(world.db, manager(), "task_release", {
      task_id: created.id,
      reason: "human confirmed the executor is gone",
    });
    expect(released.ok).toBe(true);
  });

  it("reclaims a stale lease, abandons the old attempt and records the takeover", async () => {
    world = await createTestWorld();
    const created = await card("Stale reclaim");
    await invokeTool(world.db, ctxA(), "task_claim", { task_id: created.id });
    await world.db
      .update(executionAttempt)
      .set({ lastActivityAt: new Date(Date.now() - 61 * 60_000) })
      .where(eq(executionAttempt.taskId, created.id));

    const reclaimed = await invokeTool(world.db, ctxB(), "task_claim", {
      task_id: created.id,
      executor: { cli: "claude-code", model: "fable-5" },
    });
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    const out = TaskClaimOutputSchema.parse(reclaimed.value);
    expect(out.reclaimed_stale).toBe(true);
    expect(out.briefing_markdown).toContain("## Expired claim takeover");

    const attempts = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, created.id))
      .orderBy(asc(executionAttempt.startedAt));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.result).toBe("abandoned");
    expect(attempts[0]?.resultNote).toBe("stale");
    expect(attempts[1]?.finishedAt).toBeNull();

    const events = await world.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, created.id));
    expect(events.some((event) => event.kind === "claim_stale")).toBe(true);
  });

  it("protects an active lease and lets heartbeat renew a long run", async () => {
    world = await createTestWorld();
    const created = await card("Active claim");
    await invokeTool(world.db, ctxA(), "task_claim", { task_id: created.id });

    const denied = await invokeTool(world.db, ctxB(), "task_claim", {
      task_id: created.id,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("ALREADY_CLAIMED");

    const beat = await invokeTool(world.db, ctxA(), "task_heartbeat", {
      task_id: created.short_id,
    });
    expect(beat.ok).toBe(true);
    if (!beat.ok) return;
    const lease = TaskHeartbeatOutputSchema.parse(beat.value);
    expect(new Date(lease.expires_at).getTime()).toBeGreaterThan(
      new Date(lease.last_activity_at).getTime(),
    );

    const stillDenied = await invokeTool(world.db, ctxB(), "task_claim", {
      task_id: created.id,
    });
    expect(stillDenied.ok).toBe(false);
    if (!stillDenied.ok) expect(stillDenied.error.code).toBe("ALREADY_CLAIMED");
  });
});
