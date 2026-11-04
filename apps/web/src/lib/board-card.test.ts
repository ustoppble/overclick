import {
  executionAttempt,
  handoff,
  task,
  type Database,
} from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminPrincipal,
  closeTestWorld,
  createTestWorld,
  type TestWorld,
} from "../mcp/test-db";
import { toBoardCardDetail, toBoardCards } from "./board-card";
import { loadBoardTaskDetail, loadBoardTasks } from "./board-tasks";
import { dict } from "./i18n";

/**
 * The board records the harness that ran and never chooses one (E2). What it
 * recorded is read back on the card: "model · effort" on the line, with the
 * model as the claim spelled it, and every attempt in the panel.
 */
describe("the card shows the record of what ran (E2)", () => {
  let world: TestWorld;

  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  function database(): Database {
    return world.db as unknown as Database;
  }

  async function card(shortId: string, status: "feito" | "em_execucao" = "feito") {
    const [row] = await world.db
      .insert(task)
      .values({ projectId: world.projectId, shortId, title: `card ${shortId}`, status })
      .returning({ id: task.id });
    return row!.id;
  }

  async function line(id: string) {
    const rows = await loadBoardTasks(database(), [world.projectId], adminPrincipal(world), {
      period: "all",
    });
    const cards = toBoardCards(rows, {
      tr: dict("en"),
      pricingEnabled: false,
      viewerId: world.adminUserId,
      claimTimeoutMinutes: 30,
    });
    return cards.find((item) => item.id === id)!;
  }

  async function detail(id: string, lang = "en") {
    const row = await loadBoardTaskDetail(
      database(),
      [world.projectId],
      adminPrincipal(world),
      id,
    );
    return toBoardCardDetail(row!, dict(lang), false, []);
  }

  it("puts the effort on the line beside the model, spelled as the claim registered it", async () => {
    const id = await card("OC-1");
    await world.db.insert(executionAttempt).values({
      taskId: id,
      executor: JSON.stringify({ cli: "codex", effort: "xhigh", declared_model: "gpt-5.6-sol" }),
      model: "gpt-5-6-sol",
      modelSource: "declared",
      tokensIn: 10,
      tokensOut: 5,
    });
    const shown = await line(id);
    expect(shown.harnessChain).toBe("gpt-5.6-sol");
    expect(shown.effort).toBe("xhigh");
  });

  it("falls back to the stored key for an attempt recorded before the spelling was kept", async () => {
    const id = await card("OC-2");
    await world.db.insert(executionAttempt).values({
      taskId: id,
      executor: JSON.stringify({ cli: "claude", effort: "high" }),
      model: "sonnet-5",
    });
    const shown = await line(id);
    expect(shown.harnessChain).toBe("sonnet-5");
    expect(shown.effort).toBe("high");
  });

  it("drops the declared spelling once the measured model replaced it", async () => {
    const id = await card("OC-3");
    await world.db.insert(executionAttempt).values({
      taskId: id,
      executor: JSON.stringify({ cli: "codex", declared_model: "gpt-5.6-sol" }),
      model: "opus-5",
      modelSource: "measured",
    });
    const shown = await line(id);
    expect(shown.harnessChain).toBe("opus-5");
    expect(shown.effort).toBeNull();
  });

  it("lists every attempt in the panel, oldest first, each with its own record", async () => {
    const id = await card("OC-4");
    const now = Date.now();
    const [first, second] = await world.db
      .insert(executionAttempt)
      .values([
        {
          taskId: id,
          executor: JSON.stringify({ cli: "codex", effort: "high", declared_model: "gpt-5.6-sol" }),
          model: "gpt-5-6-sol",
          modelSource: "declared",
          startedAt: new Date(now - 3 * 3_600_000),
          lastActivityAt: new Date(now - 3 * 3_600_000),
          finishedAt: new Date(now - 3 * 3_600_000 + 60_000),
          durationMs: 60_000,
          result: "abandoned",
        },
        {
          taskId: id,
          executor: JSON.stringify({ cli: "claude", effort: "max" }),
          model: "opus-5",
          modelSource: "declared",
          startedAt: new Date(now - 2 * 3_600_000),
          lastActivityAt: new Date(now - 2 * 3_600_000),
          finishedAt: new Date(now - 2 * 3_600_000 + 300_000),
          durationMs: 300_000,
          result: "success",
        },
        {
          taskId: id,
          executor: JSON.stringify({ cli: "grok" }),
          model: "grok-4-6",
          startedAt: new Date(now - 3_600_000),
          lastActivityAt: new Date(now - 3_600_000),
        },
      ])
      .returning({ id: executionAttempt.id });
    await world.db.insert(handoff).values({
      taskId: id,
      attemptId: second!.id,
      summary: "delivered",
      commitHash: "abc1234def",
    });
    expect(first).toBeDefined();

    const opened = await detail(id);
    expect(opened.attempts).toHaveLength(3);
    expect(opened.attempts.map((attempt) => attempt.n)).toEqual([1, 2, 3]);
    expect(opened.attempts[0]).toMatchObject({
      cli: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      result: "abandoned",
      commit: null,
    });
    expect(opened.attempts[1]).toMatchObject({
      cli: "claude",
      model: "opus-5",
      effort: "max",
      result: "success",
      commit: "abc1234",
      duration: "5m",
    });
    expect(opened.attempts[2]).toMatchObject({
      cli: "grok",
      model: "grok-4-6",
      effort: null,
      result: null,
    });
    // Money is opt-in: with it off no attempt carries a cost.
    expect(opened.attempts.every((attempt) => attempt.cost === null)).toBe(true);
  });
});
