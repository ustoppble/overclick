import { executionAttempt, task } from "@agent-board/db";
import { TaskClaimOutputSchema } from "@agent-board/mcp-core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindRecipeSettings } from "@agent-board/db/domain";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

/**
 * OCL-211: usage by reference. The agent names its transcript and the board
 * runs the shipped recipe on it, instead of the agent retyping the numbers the
 * recipe already printed.
 */
describe("usage by reference (OCL-211)", () => {
  let world: TestWorld;
  const dirs: string[] = [];
  // The fixtures live in the temp folder, which is not a transcript folder
  // unless the operator's list says so.
  beforeEach(() => {
    vi.stubEnv("OVERCLICK_TRANSCRIPT_DIRS", tmpdir());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (world) await closeTestWorld(world);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const ctx = () => ({ workspaceId: world.workspaceId, tokenId: world.tokenId, tokenLabel: "test" });

  async function claimCard() {
    world = await createTestWorld();
    const [card] = await world.db
      .insert(task)
      .values({ projectId: world.projectId, shortId: "OC-1", title: "Usage by reference" })
      .returning();
    const result = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card!.id,
      executor: { cli: "claude", model: "opus-5", effort: "high", session_id: "ref-session" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("claim failed");
    return { card: card!, claimed: TaskClaimOutputSchema.parse(result.value) };
  }

  /**
   * A Claude Code session: one line from before the claim, then a response
   * written as three lines under one message.id, then a second response.
   */
  function writeTranscript(): string {
    const dir = mkdtempSync(join(tmpdir(), "ocl-211-"));
    dirs.push(dir);
    const file = join(dir, "session.jsonl");
    const before = new Date(Date.now() - 60_000).toISOString();
    const after = new Date(Date.now() + 1_000).toISOString();
    const usageA = { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 160, cache_creation_input_tokens: 5 };
    const usageB = { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 3 };
    const rows = [
      { timestamp: before, type: "assistant", message: { id: "msg_0", model: "claude-opus-5", usage: usageA } },
      { timestamp: after, type: "assistant", message: { id: "msg_a", model: "claude-opus-5", usage: usageA } },
      { timestamp: after, type: "assistant", message: { id: "msg_a", model: "claude-opus-5", usage: usageA } },
      { timestamp: after, type: "assistant", message: { id: "msg_a", model: "claude-opus-5", usage: usageA } },
      { timestamp: after, type: "assistant", message: { id: "msg_b", model: "claude-opus-5", usage: usageB } },
    ];
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
    return file;
  }

  it("measures usage from the transcript path when the delivery sends no numbers", async () => {
    const { card, claimed } = await claimCard();
    const file = writeTranscript();

    // What the agent would have typed: the claim's own recipe, run by hand.
    const manual = JSON.parse(
      execFileSync("sh", ["-c", bindRecipeSettings(claimed.usage_recipe!.command, { transcript: file })], {
        encoding: "utf8",
      }),
    );
    expect(manual).toMatchObject({ turns: 2, estimated: false });

    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "Delivered by reference",
      transcript: { path: file },
      return: "ack",
    });
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    const ack = delivered.value as { changed: Record<string, unknown>; telemetry_incomplete_reason?: string };
    expect(ack.changed).toMatchObject({ usage_recorded: true, telemetry_incomplete: false });
    expect(ack.telemetry_incomplete_reason).toBeUndefined();

    const [attempt] = await world.db.select().from(executionAttempt);
    // Same numbers as the recipe, and the message.id dedupe with them: the
    // three-line response counts once, the line before the claim not at all.
    // The board stores model keys normalized for pricing (claude-opus-5 is
    // opus-5); the counters are the recipe's, untouched.
    expect(manual.segments).toEqual([
      { model: "claude-opus-5", input: 130, output: 50, cache_read: 260, cache_write: 8 },
    ]);
    expect(attempt?.usageSegments).toEqual([
      { model: "opus-5", input: 130, output: 50, cache_read: 260, cache_write: 8 },
    ]);
    expect(attempt).toMatchObject({ turns: 2, usageEstimated: false });
    expect(attempt?.durationMs).toBe(attempt?.serverDurationMs);
  });

  it("keeps the numbers the agent sent over the transcript", async () => {
    const { card } = await claimCard();
    const file = writeTranscript();
    const sent = [{ model: "opus-5", input: 1, output: 2, cache_read: 3, cache_write: 4 }];

    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "Explicit usage",
      usage: { segments: sent, turns: 7, duration_ms: 1000 },
      transcript: { path: file },
    });
    expect(delivered.ok).toBe(true);
    const [attempt] = await world.db.select().from(executionAttempt);
    expect(attempt?.usageSegments).toEqual(sent);
    expect(attempt?.turns).toBe(7);
  });

  it("answers a delivery with no usage and no reference exactly as before", async () => {
    const { card } = await claimCard();
    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "Nothing sent",
      return: "ack",
    });
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(delivered.value).toMatchObject({
      changed: { telemetry_incomplete: true },
      telemetry_incomplete_reason: "no usage was sent — send it with task_update, measured or estimated",
    });
    const [attempt] = await world.db.select().from(executionAttempt);
    expect(attempt?.usageSegments).toBeNull();
  });

  it("says the board could not read a path that only exists on the agent's machine", async () => {
    const { card } = await claimCard();
    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "Unreachable transcript",
      return: "ack",
      transcript: { path: "/nowhere/on/this/board/session.jsonl" },
    });
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(delivered.value).toMatchObject({ changed: { telemetry_incomplete: true } });
    expect((delivered.value as { telemetry_incomplete_reason?: string }).telemetry_incomplete_reason).toContain(
      "the board cannot read /nowhere/on/this/board/session.jsonl",
    );
  });

  it("does not run the recipe on a symlink or on a file outside the known transcript folders", async () => {
    const { card } = await claimCard();
    const file = writeTranscript();
    const link = join(join(file, ".."), "link.jsonl");
    symlinkSync(file, link);
    const viaLink = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "Through a link",
      return: "ack",
      transcript: { path: link },
    });
    expect(viaLink.ok).toBe(true);
    if (!viaLink.ok) return;
    expect(viaLink.value).toMatchObject({ changed: { telemetry_incomplete: true } });
    const [attempt] = await world.db.select().from(executionAttempt);
    expect(attempt?.usageSegments).toBeNull();
  });

  it("still refuses estimated: true without the recipe's reason", async () => {
    const { card } = await claimCard();
    const file = writeTranscript();
    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "Estimated with no reason",
      usage: { segments: [{ model: "claude-opus-5", input: 1, output: 1 }], turns: 1, duration_ms: 1, estimated: true },
      transcript: { path: file },
    });
    expect(delivered.ok).toBe(false);
  });
});
