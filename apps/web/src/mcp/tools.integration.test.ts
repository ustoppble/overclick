import {
  TaskDeliverOutputSchema,
  HarnessRecommendOutputSchema,
  MissionCreateOutputSchema,
  MissionDeleteOutputSchema,
  MissionGetOutputSchema,
  MissionListOutputSchema,
  MissionUpdateOutputSchema,
  TaskClaimOutputSchema,
  TaskCreateOutputSchema,
  TaskDeleteOutputSchema,
  TaskGetOutputSchema,
  TaskListOutputSchema,
  TaskUpdateOutputSchema,
} from "@agent-board/mcp-core";
import {
  executionAttempt,
  handoff,
  mcpToken,
  mission,
  user,
  project,
  task,
  taskComment,
  workspace,
} from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { generateTokenSecret, hashToken } from "./token";
import { invokeTool } from "./tools";

const origem = {
  session_id: "sess_torre",
  cli: "overclock",
};

describe("MCP tool edge cases against a test db", () => {
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

  it("creates a team card with scoped subtasks and recommended harness", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      mission: world.missionId,
      project_id: world.projectId,
      title: "RFC de auth",
      type: "rfc",
      o_que: "Desenhar auth.",
      por_que: "Precisamos de um contrato.",
      como_confirmo: [{ step: "lê o RFC", expected: "aprovável" }],
      mode: "team",
      origem,
      devolve_para: { kind: "agent", session_id: "sess_torre" },
      subtasks: [
        {
          title: "Pesquisar opções",
          scope: "levantar 3 abordagens",
          boundary: "não implementar",
        },
        {
          title: "Escrever o RFC",
          scope: "documento markdown",
          boundary: "sem código de produto",
        },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const out = TaskCreateOutputSchema.parse(created.value);
    expect(out.task.mode).toBe("team");
    expect(out.task.o_que).toContain("## Plano");
    expect(out.subtasks).toHaveLength(2);
    expect(out.subtasks[0]?.short_id).toBe(`${out.task.short_id}.1`);
    expect(out.task.harness?.model).toBe("opus-5");
  });

  it("uses the harness model when Codex claims with generic gpt-5", async () => {
    world = await createTestWorld();
    const [card] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        shortId: "OC-90",
        title: "Generic Codex claim",
        harness: { cli: "codex", model: "gpt-5.6-sol", effort: "high" },
      })
      .returning();
    if (!card) throw new Error("failed to create card");

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "Codex CLI", model: "gpt-5" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimOutputSchema.parse(claimed.value);
    expect(out.attempt.executor).toMatchObject({
      cli: "codex",
      model: "gpt-5-6-sol",
      model_source: "harness",
    });

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt).toMatchObject({
      model: "gpt-5-6-sol",
      modelSource: "harness",
    });
  });

  it("keeps an exact Codex model declared on claim", async () => {
    world = await createTestWorld();
    const [card] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        shortId: "OC-91",
        title: "Exact Codex claim",
        harness: { cli: "codex", model: "gpt-5.6-sol", effort: "high" },
      })
      .returning();
    if (!card) throw new Error("failed to create card");

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "codex", model: "gpt-5.6-luna" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(TaskClaimOutputSchema.parse(claimed.value).attempt.executor).toMatchObject({
      cli: "codex",
      model: "gpt-5-6-luna",
      model_source: "declared",
    });
  });

  it("updates the attempt model and timeline when measured segments diverge", async () => {
    world = await createTestWorld();
    const [card] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        shortId: "OC-92",
        title: "Measured Codex model",
        harness: { cli: "codex", model: "gpt-5.6-sol", effort: "high" },
      })
      .returning();
    if (!card) throw new Error("failed to create card");

    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "codex", model: "gpt-5" },
    });
    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "measured",
      usage: {
        segments: [{ model: "gpt-5.6-terra", input: 100, output: 20 }],
      },
    });
    expect(delivered.ok).toBe(true);

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt).toMatchObject({
      model: "gpt-5-6-terra",
      modelSource: "measured",
    });
    const [note] = await world.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, card.id));
    expect(note).toMatchObject({
      kind: "executor_swap",
      body: "declarou gpt-5-6-sol, mediu gpt-5-6-terra",
    });
  });

  it("atomically supersedes a running card, preserves usage and inherits its contract", async () => {
    world = await createTestWorld();
    const first = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Original",
      type: "feature",
      o_que: "Keep this contract.",
      por_que: "The work still matters.",
      como_confirmo: [{ step: "run it", expected: "it works" }],
      origem,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const original = TaskCreateOutputSchema.parse(first.value).task;

    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: original.id,
      executor: { cli: "codex", model: "spark" },
    });
    const usage = await invokeTool(world.db, ctx(), "task_update", {
      task_id: original.id,
      usage: { tokens_in: 120, tokens_out: 30, duration_ms: 5000 },
    });
    expect(usage.ok).toBe(true);

    const continued = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Continuation",
      type: "feature",
      supersedes: original.short_id,
      inherit: true,
      origem,
    });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    const replacement = TaskCreateOutputSchema.parse(continued.value).task;
    expect(replacement.supersedes).toBe(original.id);
    expect(replacement.o_que).toBe(original.o_que);
    expect(replacement.por_que).toBe(original.por_que);
    expect(replacement.como_confirmo).toEqual(original.como_confirmo);

    const old = await invokeTool(world.db, ctx(), "task_get", {
      task_id: original.id,
    });
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    const oldCard = TaskGetOutputSchema.parse(old.value).task;
    expect(oldCard.status).toBe("descartado");
    expect(oldCard.superseded_by).toBe(replacement.id);

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, original.id));
    expect(attempt?.result).toBe("abandoned");
    expect(attempt?.resultNote).toBe(`superseded by ${replacement.short_id}`);
    expect(attempt?.tokensIn).toBe(120);
    expect(attempt?.tokensOut).toBe(30);

    const corrected = await invokeTool(world.db, ctx(), "task_update", {
      task_id: original.id,
      usage: { tokens_in: 200, tokens_out: 40, duration_ms: 6000 },
    });
    expect(corrected.ok).toBe(true);
    const [afterCorrection] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, original.id));
    expect(afterCorrection?.result).toBe("abandoned");
    expect(afterCorrection?.tokensIn).toBe(200);
    expect(afterCorrection?.tokensOut).toBe(40);
  });

  it("rejects superseding a delivered card", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Already delivered",
      type: "bug",
      o_que: "Fix it.",
      por_que: "It broke.",
      como_confirmo: [{ step: "check", expected: "fixed" }],
      origem,
    });
    if (!created.ok) throw new Error("create failed");
    const card = TaskCreateOutputSchema.parse(created.value).task;
    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "done",
      usage: { tokens_in: 1, estimated: true },
    });

    const refused = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Should not exist",
      type: "bug",
      supersedes: card.id,
      inherit: true,
      origem,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("INVALID_ARGUMENT");
  });

  it("lets a managed token link an existing continuation while discarding", async () => {
    world = await createTestWorld();
    const make = async (title: string) => {
      const made = await invokeTool(world.db, ctx(), "task_create", {
        project_id: world.projectId,
        title,
        type: "feature",
        o_que: title,
        por_que: "needed",
        como_confirmo: [{ step: "check", expected: "ok" }],
        origem,
      });
      if (!made.ok) throw new Error("create failed");
      return TaskCreateOutputSchema.parse(made.value).task;
    };
    const original = await make("Old");
    const continuation = await make("New");
    await invokeTool(world.db, ctx(), "task_claim", { task_id: original.id });

    const updated = await invokeTool(
      world.db,
      { ...ctx(), canManage: true },
      "task_update",
      {
        task_id: original.id,
        status: "descartado",
        superseded_by: continuation.id,
      },
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const out = TaskUpdateOutputSchema.parse(updated.value).task;
    expect(out.status).toBe("descartado");
    expect(out.superseded_by).toBe(continuation.id);
    const next = await invokeTool(world.db, ctx(), "task_get", {
      task_id: continuation.id,
    });
    expect(next.ok && TaskGetOutputSchema.parse(next.value).task.supersedes).toBe(
      original.id,
    );
  });

  it("accepts handoff without usage and marks telemetry incomplete", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Sem telemetria",
      type: "feature",
      o_que: "Um card.",
      por_que: "Agente genérico.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
    });
    expect(claimed.ok).toBe(true);

    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "pronto para ler",
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const delivered = TaskDeliverOutputSchema.parse(submitted.value);
    expect(delivered.telemetry_incomplete).toBe(true);
    expect(delivered.task.status).toBe("feito");
    // Usage is required by contract: a usage-less delivery still lands, but
    // the response tells the agent how to fix it after the fact.
    expect(delivered.usage_warning).toContain("task_update");

    // The server measured claim → deliver on its own.
    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.serverDurationMs).not.toBeNull();
    expect(attempt?.serverDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks estimated usage on the attempt and skips the warning", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Estimativa",
      type: "feature",
      o_que: "Um card.",
      por_que: "Agente sem números exatos.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "estimado",
      usage: {
        tokens_in: 1000,
        tokens_out: 200,
        cost_usd: 0.05,
        duration_ms: 60000,
        turns: 3,
        estimated: true,
      },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const delivered = TaskDeliverOutputSchema.parse(submitted.value);
    expect(delivered.usage_warning).toBeUndefined();
    expect(delivered.handoff.usage?.estimated).toBe(true);

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.usageEstimated).toBe(true);
  });

  it("ends the claim briefing with the recipe for the claiming CLI", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Receita no briefing",
      type: "feature",
      o_que: "Um card.",
      por_que: "O agente precisa saber como se medir.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    // The agent sends the binary name; the board resolves it to the catalog id.
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "claude", model: "sonnet-5" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const payload = TaskClaimOutputSchema.parse(claimed.value);

    expect(payload.usage_recipe?.cli).toBe("claude-code");
    expect(payload.usage_recipe?.yields).toBe("tokens_per_model");
    const md = payload.briefing_markdown;
    const recipeAt = md.indexOf("## Measuring this run");
    const contractAt = md.indexOf("## Executor contract");
    expect(recipeAt).toBeGreaterThan(-1);
    expect(recipeAt).toBeLessThan(contractAt);
    expect(md).toContain("CLAUDE_CODE_SESSION_ID");
    expect(md.slice(contractAt)).toContain("segments");
    // The contract stays the last thing the agent reads.
    expect(md.indexOf("## ", contractAt + 1)).toBe(-1);
  });

  it("hands the generic recipe to a CLI the board has no recipe for", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "CLI desconhecido",
      type: "feature",
      o_que: "Um card.",
      por_que: "Nem todo CLI tem receita.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "some-new-cli", model: "whatever-1" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const payload = TaskClaimOutputSchema.parse(claimed.value);
    expect(payload.usage_recipe?.cli).toBe("generic");
    expect(payload.briefing_markdown).toContain("(no command for this CLI yet)");

    // task_get keeps handing the same recipe: the card knows who claimed it.
    const got = await invokeTool(world.db, ctx(), "task_get", { task_id: card.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(TaskGetOutputSchema.parse(got.value).usage_recipe?.cli).toBe("generic");
  });

  it("pins the Codex recipe to the claim session and harness model", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Receita Codex exata",
      type: "feature",
      o_que: "Um card.",
      por_que: "O rollout precisa pertencer ao claim.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: {
        cli: "codex",
        model: "gpt-5.6-sol",
        session_id: "codex-session-with-'quote",
      },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const payload = TaskClaimOutputSchema.parse(claimed.value);

    expect(payload.usage_recipe?.command).toContain(
      `CODEX_SESSION_ID='codex-session-with-'"'"'quote'`,
    );
    expect(payload.usage_recipe?.command).toContain(
      "CODEX_HARNESS_MODEL='gpt-5-6-sol'",
    );
    expect(payload.usage_recipe?.command).toContain(
      `OVERCLICK_CLAIMED_AT='${payload.attempt.started_at}'`,
    );
    expect(payload.briefing_markdown).toContain(
      `claimed_at: \`${payload.attempt.started_at}\``,
    );
    expect(payload.briefing_markdown).toContain(
      "work before the claim",
    );
    expect(payload.briefing_markdown).toContain(
      "CODEX_HARNESS_MODEL='gpt-5-6-sol'",
    );
  });

  it("turns the claim session id into a transcript reference the delivery completes", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Referência do transcript",
      type: "feature",
      o_que: "Um card.",
      por_que: "O card precisa apontar de volta para a sessão.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    // The claim only knows the session: the path exists once the run is done.
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "claude", model: "sonnet-5", session_id: "sess-42" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const attemptOut = TaskClaimOutputSchema.parse(claimed.value).attempt;
    expect(attemptOut.transcript).toEqual({
      cli: "claude",
      session_id: "sess-42",
      path: null,
      resume: "claude --resume sess-42",
    });

    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "entregue",
      transcript: { path: "/home/dev/.claude/projects/repo/sess-42.jsonl" },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const delivered = TaskDeliverOutputSchema.parse(submitted.value);
    // The delivery adds the path and keeps everything the claim recorded.
    expect(delivered.transcript).toEqual({
      cli: "claude",
      session_id: "sess-42",
      path: "/home/dev/.claude/projects/repo/sess-42.jsonl",
      resume: "claude --resume sess-42",
    });

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.transcript).toEqual({
      cli: "claude",
      sessionId: "sess-42",
      path: "/home/dev/.claude/projects/repo/sess-42.jsonl",
      resume: "claude --resume sess-42",
    });
  });

  it("leaves the transcript reference null when the executor names no session", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Sem sessão",
      type: "feature",
      o_que: "Um card.",
      por_que: "Nem todo executor identifica a sessão.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(TaskClaimOutputSchema.parse(claimed.value).attempt.transcript).toBeNull();

    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "entregue",
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(TaskDeliverOutputSchema.parse(submitted.value).transcript).toBeNull();
  });

  it("stores usage in segments per model and derives the flat totals", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Trocou de modelo no meio",
      type: "feature",
      o_que: "Um card.",
      por_que: "A run trocou de modelo.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "claude", model: "sonnet-5" },
    });
    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "entregue por dois modelos",
      usage: {
        segments: [
          { model: "sonnet-5", input: 1000, output: 200, cache_read: 5000 },
          { model: "opus-5", input: 300, output: 900, cache_write: 100 },
        ],
        cost_usd: 0.4,
        duration_ms: 900_000,
        turns: 12,
      },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const delivered = TaskDeliverOutputSchema.parse(submitted.value);
    expect(delivered.telemetry_incomplete).toBe(false);
    expect(delivered.handoff.usage?.segments).toHaveLength(2);

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.usageSegments).toEqual([
      { model: "sonnet-5", input: 1000, output: 200, cache_read: 5000 },
      { model: "opus-5", input: 300, output: 900, cache_write: 100 },
    ]);
    // The flat counters keep agreeing with the segments they came from.
    expect(attempt?.tokensIn).toBe(1300);
    expect(attempt?.tokensOut).toBe(1100);
    expect(attempt?.tokensCache).toBe(5100);
    expect(Number(attempt?.reportedCostUsd)).toBeCloseTo(0.4);
    expect(Number(attempt?.costUsd)).toBeCloseTo(0.03155);
    expect(attempt?.costSource).toBe("computed");
    expect(attempt?.costStatus).toBe("computed");
    expect(attempt?.costUnpricedModels).toEqual([]);
    expect(attempt?.costBreakdown).toHaveLength(2);
  });

  it("normalizes a Spark segment and freezes its computed cost on deliver", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Spark com alias",
      type: "feature",
      o_que: "Um card.",
      por_que: "O slug da CLI precisa encontrar o preço.",
      como_confirmo: [{ step: "entrega", expected: "custo calculado" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "entregue",
      usage: {
        segments: [
          { model: "gpt-5.3-codex-spark", input: 100_000, output: 20_000 },
        ],
        duration_ms: 1_000,
        turns: 1,
      },
    });
    expect(submitted.ok).toBe(true);

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.usageSegments?.[0]?.model).toBe("gpt-5-3-codex-spark");
    expect(Number(attempt?.costUsd)).toBeCloseTo(0.455);
    expect(attempt?.costSource).toBe("computed");
    expect(attempt?.costStatus).toBe("computed");
    const fetched = await invokeTool(world.db, ctx(), "task_get", {
      task_id: card.id,
    });
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(TaskGetOutputSchema.parse(fetched.value)).toMatchObject({
        cost_usd: 0.455,
        cost_source: "computed",
        cost_status: "computed",
        cost_unpriced_models: [],
      });
    }
  });

  it("stores the missing price reason instead of a zero cost", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Modelo futuro",
      type: "feature",
      o_que: "Um card.",
      por_que: "Preço desconhecido precisa ficar explícito.",
      como_confirmo: [{ step: "entrega", expected: "sem preço" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "entregue",
      usage: {
        segments: [{ model: "future-model", input: 100_000, output: 20_000 }],
        duration_ms: 1_000,
        turns: 1,
      },
    });

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.costUsd).toBeNull();
    expect(attempt?.costSource).toBeNull();
    expect(attempt?.costStatus).toBe("unpriced");
    expect(attempt?.costUnpricedModels).toEqual(["future-model"]);
    const fetched = await invokeTool(world.db, ctx(), "task_get", {
      task_id: card.id,
    });
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(TaskGetOutputSchema.parse(fetched.value)).toMatchObject({
        cost_usd: null,
        cost_source: null,
        cost_status: "unpriced",
        cost_unpriced_models: ["future-model"],
      });
    }
  });

  it("stores a flat usage block as one segment for the claimed model", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Formato antigo",
      type: "feature",
      o_que: "Um card.",
      por_que: "O agente ainda manda o formato plano.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "claude", model: "sonnet-5" },
    });
    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "formato plano",
      usage: {
        tokens_in: 1000,
        tokens_out: 200,
        tokens_cache: 7000,
        cost_usd: 0.1,
        duration_ms: 60_000,
        turns: 3,
      },
    });
    expect(submitted.ok).toBe(true);

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.usageSegments).toEqual([
      { model: "sonnet-5", input: 1000, output: 200, cache_read: 7000 },
    ]);
    expect(attempt?.tokensIn).toBe(1000);
  });

  it("replaces the stored segments when task_update corrects them", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Correcao de segmentos",
      type: "feature",
      o_que: "Um card.",
      por_que: "Os numeros reais apareceram depois.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "claude", model: "sonnet-5" },
    });
    await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "sem numeros",
    });
    const updated = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      usage: {
        segments: [
          { model: "sonnet-5", input: 10, output: 20 },
          { model: "opus-5", input: 30, output: 40 },
        ],
        cost_usd: 0.02,
        duration_ms: 30_000,
        turns: 2,
      },
    });
    expect(updated.ok).toBe(true);

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.usageSegments).toHaveLength(2);
    expect(attempt?.tokensIn).toBe(40);
    expect(attempt?.tokensOut).toBe(60);

    const [saved] = await world.db
      .select()
      .from(handoff)
      .where(eq(handoff.taskId, card.id));
    expect(saved?.usage?.segments).toHaveLength(2);
  });

  it("accepts usage via task_update after deliver and clears the incomplete flag", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Correção de usage",
      type: "feature",
      o_que: "Um card.",
      por_que: "Números reais chegaram depois.",
      como_confirmo: [{ step: "existe", expected: "ok" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "sem números na hora",
    });

    const corrected = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      usage: {
        tokens_in: 5000,
        tokens_out: 900,
        cost_usd: 0.4,
        duration_ms: 120000,
        turns: 7,
      },
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const out = TaskUpdateOutputSchema.parse(corrected.value);
    expect(out.usage_recorded).toBe(true);

    const [attempt] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attempt?.tokensIn).toBe(5000);
    expect(attempt?.usageEstimated).toBe(false);

    const [row] = await world.db.select().from(task).where(eq(task.id, card.id));
    expect(row?.telemetryIncomplete).toBe(false);

    const [ho] = await world.db.select().from(handoff).where(eq(handoff.taskId, card.id));
    expect(ho?.usage?.tokens_in).toBe(5000);

    const suspectCorrection = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      usage: {
        tokens_out: 5_000_000,
        duration_ms: 60_000,
        turns: 7,
      },
    });
    expect(suspectCorrection.ok).toBe(true);
    if (!suspectCorrection.ok) return;
    expect(TaskUpdateOutputSchema.parse(suspectCorrection.value)).toMatchObject({
      usage_recorded: true,
      usage_suspect: true,
    });
  });

  it("accepts an impossible usage report but marks it suspect on deliver and task_get", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Usage de sessao inteira",
      type: "bug",
      o_que: "O board aceita e sinaliza o valor.",
      por_que: "A entrega nao pode se perder.",
      como_confirmo: [{ step: "entrega", expected: "flag suspeita" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: {
        cli: "claude",
        model: "sonnet-5",
        session_id: "impossible-window-session",
      },
    });
    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "entrega aceita",
      usage: {
        tokens_out: 5_000_000,
        duration_ms: 60_000,
        turns: 5,
      },
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const delivered = TaskDeliverOutputSchema.parse(submitted.value);
    expect(delivered.task.status).toBe("feito");
    expect(delivered.usage_suspect).toBe(true);
    expect(delivered.usage_suspect_reason).toContain("claim_window_exceeded");

    const got = await invokeTool(world.db, ctx(), "task_get", {
      task_id: card.id,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(TaskGetOutputSchema.parse(got.value)).toMatchObject({
      usage_suspect: true,
      usage_suspect_reason: "claim_window_exceeded",
    });
  });

  it("keeps plausible usage trusted and flags a second card reusing its session", async () => {
    world = await createTestWorld();
    const createCard = async (title: string) => {
      const created = await invokeTool(world.db, ctx(), "task_create", {
        project_id: world.projectId,
        title,
        type: "feature",
        o_que: "Um card pequeno.",
        por_que: "Cobrir a guarda de sessao.",
        como_confirmo: [{ step: "entrega", expected: "usage classificado" }],
        origem,
      });
      if (!created.ok) throw new Error(created.error.message);
      return TaskCreateOutputSchema.parse(created.value).task;
    };
    const first = await createCard("Primeiro card da sessao");
    const second = await createCard("Segundo card da sessao");
    const sessionId = "reused-executor-session";

    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: first.id,
      executor: { cli: "codex", model: "gpt-5.6-sol", session_id: sessionId },
    });
    const firstDelivery = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: first.id,
      summary: "primeiro",
      usage: { tokens_in: 2_000, tokens_out: 500, duration_ms: 60_000, turns: 3 },
    });
    expect(firstDelivery.ok).toBe(true);
    if (!firstDelivery.ok) return;
    expect(TaskDeliverOutputSchema.parse(firstDelivery.value).usage_suspect).toBe(
      false,
    );

    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: second.id,
      executor: { cli: "codex", model: "gpt-5.6-sol", session_id: sessionId },
    });
    const secondDelivery = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: second.id,
      summary: "segundo",
      usage: { tokens_in: 1_000, tokens_out: 200, duration_ms: 60_000, turns: 2 },
    });
    expect(secondDelivery.ok).toBe(true);
    if (!secondDelivery.ok) return;
    const out = TaskDeliverOutputSchema.parse(secondDelivery.value);
    expect(out.usage_suspect).toBe(true);
    expect(out.usage_suspect_reason).toContain("session_reused");

    const [stored] = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, second.id));
    expect(stored?.sessionId).toBe(sessionId);
    expect(stored?.usageSuspect).toBe(true);
  });

  it("persists how_to_verify on the handoff and restarts validation ticks", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Painel de validação",
      type: "feature",
      o_que: "Um card.",
      por_que: "Validação leiga.",
      como_confirmo: [{ step: "abre a home", expected: "board carrega" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
    });
    expect(claimed.ok).toBe(true);

    // Leftover ticks from a previous review round must not survive a redelivery.
    await world.db
      .update(task)
      .set({
        validationTicks: [
          { index: 0, byUserId: "u1", byEmail: "a@b.c", at: new Date().toISOString() },
        ],
      })
      .where(eq(task.id, card.id));

    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "pronto",
      how_to_verify: "http://localhost:3300/home",
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const delivered = TaskDeliverOutputSchema.parse(submitted.value);
    expect(delivered.handoff.how_to_verify).toBe("http://localhost:3300/home");

    const [row] = await world.db.select().from(task).where(eq(task.id, card.id));
    expect(row?.validationTicks).toEqual([]);
    const [saved] = await world.db
      .select()
      .from(handoff)
      .where(eq(handoff.taskId, card.id));
    expect(saved?.howToVerify).toBe("http://localhost:3300/home");
  });

  it("learns cli/model pairs outside the config from claims and delivers", async () => {
    world = await createTestWorld();
    const seen = async () => {
      const [ws] = await world.db
        .select()
        .from(workspace)
        .where(eq(workspace.id, world.workspaceId));
      return ws?.seenExecutors ?? [];
    };
    const mkCard = async (title: string) => {
      const created = await invokeTool(world.db, ctx(), "task_create", {
        project_id: world.projectId,
        title,
        type: "feature",
        o_que: "x",
        por_que: "y",
        como_confirmo: [{ step: "a", expected: "b" }],
        origem,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("create failed");
      return TaskCreateOutputSchema.parse(created.value).task;
    };

    // Config pair (claude aliases to claude-code, sonnet-5 configured): not learned.
    const known = await mkCard("Known pair");
    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: known.id,
      executor: { cli: "claude", model: "sonnet-5" },
    });
    expect(await seen()).toEqual([]);

    // A confirmed alias resolves to the configured model and is not learned.
    const a = await mkCard("Unknown pair A");
    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: a.id,
      executor: { cli: "claude", model: "claude-fable-5" },
    });
    expect(await seen()).toEqual([]);

    // A genuinely unknown model is learned, bumped on a second claim and on deliver.
    const b = await mkCard("Unknown pair B");
    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: b.id,
      executor: { cli: "claude", model: "claude-future-model" },
    });
    let rows = await seen();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cli: "claude-code",
      model: "future-model",
      count: 1,
    });

    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: b.id,
      summary: "done",
    });
    expect(submitted.ok).toBe(true);
    rows = await seen();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
  });

  it("rejects handoff from aberto via the state machine", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Ainda aberto",
      type: "bug",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "cedo demais",
    });
    expect(submitted.ok).toBe(false);
    if (!submitted.ok) {
      expect(submitted.error.code).toBe("INVALID_TRANSITION");
    }
  });

  it("creates a mission, lists it, and links a task by that id", async () => {
    world = await createTestWorld();

    const created = await invokeTool(world.db, ctx(), "mission_create", {
      title: "Field north",
      objective: "Ship the mission loop.",
      context: "Agents must inherit this context in the briefing.",
      status: "ativa",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const miss = MissionCreateOutputSchema.parse(created.value).mission;
    expect(miss.title).toBe("Field north");
    expect(miss.objective).toBe("Ship the mission loop.");
    expect(miss.context).toBe("Agents must inherit this context in the briefing.");
    expect(miss.status).toBe("ativa");
    expect(miss.task_count).toBe(0);

    const listed = await invokeTool(world.db, ctx(), "mission_list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const missions = MissionListOutputSchema.parse(listed.value).missions;
    expect(missions.map((row) => row.id)).toContain(miss.id);
    expect(missions.find((row) => row.id === miss.id)?.title).toBe("Field north");

    const fetched = await invokeTool(world.db, ctx(), "mission_get", {
      mission_id: miss.id,
    });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(MissionGetOutputSchema.parse(fetched.value).mission.context).toBe(
      "Agents must inherit this context in the briefing.",
    );

    const card = await invokeTool(world.db, ctx(), "task_create", {
      mission: miss.id,
      project_id: world.projectId,
      title: "Linked to the new mission",
      type: "feature",
      o_que: "Card born under Field north.",
      por_que: "Prove the link.",
      como_confirmo: [{ step: "abre o card", expected: "missão Field north" }],
      origem,
    });
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    const taskOut = TaskCreateOutputSchema.parse(card.value).task;
    expect(taskOut.mission_id).toBe(miss.id);

    const got = await invokeTool(world.db, ctx(), "task_get", {
      task_id: taskOut.id,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const payload = TaskGetOutputSchema.parse(got.value);
    expect(payload.mission?.id).toBe(miss.id);
    expect(payload.briefing_markdown).toContain("Field north");
    expect(payload.briefing_markdown).toContain("Ship the mission loop.");
    expect(payload.briefing_markdown).toContain(
      "Agents must inherit this context in the briefing.",
    );

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: taskOut.id,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const claimOut = TaskClaimOutputSchema.parse(claimed.value);
    expect(claimOut.briefing_markdown).toContain(
      "Agents must inherit this context in the briefing.",
    );
  });

  it("partially updates a mission and scopes edits to the token workspace", async () => {
    world = await createTestWorld();

    const updated = await invokeTool(world.db, ctx(), "mission_update", {
      mission_id: world.missionId,
      title: "  New mission north  ",
      context: "## Convention\n\nOne round only.",
      status: "pausada",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const miss = MissionUpdateOutputSchema.parse(updated.value).mission;
    expect(miss.title).toBe("New mission north");
    expect(miss.context).toBe("## Convention\n\nOne round only.");
    expect(miss.objective).toBe("Fechar o loop MCP do MVP.");
    expect(miss.status).toBe("pausada");

    const invalid = await invokeTool(world.db, ctx(), "mission_update", {
      mission_id: world.missionId,
      status: "archived",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("INVALID_ARGUMENT");

    const [otherWs] = await world.db
      .insert(workspace)
      .values({ name: "Other mission workspace", executors: [] })
      .returning({ id: workspace.id });
    if (!otherWs) throw new Error("failed to insert other workspace");
    const [otherMission] = await world.db
      .insert(mission)
      .values({
        workspaceId: otherWs.id,
        title: "Other mission",
        objective: "Out of scope.",
      })
      .returning({ id: mission.id });
    if (!otherMission) throw new Error("failed to insert other mission");

    const refused = await invokeTool(world.db, ctx(), "mission_update", {
      mission_id: otherMission.id,
      title: "Must not change",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("NOT_FOUND");
  });

  it("deletes empty missions, refuses occupied ones, and detaches cards under force", async () => {
    world = await createTestWorld();

    const empty = await invokeTool(world.db, ctx(), "mission_create", {
      title: "Empty shell",
    });
    if (!empty.ok) throw new Error("mission_create failed");
    const emptyMission = MissionCreateOutputSchema.parse(empty.value).mission;
    const deleted = await invokeTool(world.db, ctx(), "mission_delete", {
      mission_id: emptyMission.id,
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(MissionDeleteOutputSchema.parse(deleted.value)).toMatchObject({
      mission_id: emptyMission.id,
      tasks_detached: 0,
    });

    const card = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      mission: world.missionId,
      title: "Card keeps living",
      type: "feature",
      o_que: "Detach on forced mission deletion.",
      por_que: "A mission is grouping, not ownership.",
      como_confirmo: [{ step: "list card", expected: "mission is null" }],
      origem,
    });
    if (!card.ok) throw new Error("task_create failed");
    const createdCard = TaskCreateOutputSchema.parse(card.value).task;

    const refused = await invokeTool(world.db, ctx(), "mission_delete", {
      mission_id: world.missionId,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("INVALID_ARGUMENT");
      expect(refused.error.message).toContain("1 card");
      expect(refused.error.message).toContain("force: true");
    }

    const forced = await invokeTool(world.db, ctx(), "mission_delete", {
      mission_id: world.missionId,
      force: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(MissionDeleteOutputSchema.parse(forced.value).tasks_detached).toBe(1);

    const [stillThere] = await world.db
      .select({ missionId: task.missionId })
      .from(task)
      .where(eq(task.id, createdCard.id));
    expect(stillThere?.missionId).toBeNull();
  });

  async function createPlainCard(title: string) {
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title,
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("card not created");
    return TaskCreateOutputSchema.parse(created.value).task;
  }

  it("records planned vs actual on the timeline when the claim executor differs", async () => {
    world = await createTestWorld();
    const card = await createPlainCard("Swapped executor");
    expect(card.harness?.model).toBeTruthy();

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "kimi-cli", model: "kimi-k2", session_id: "sess_swap" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimOutputSchema.parse(claimed.value);
    expect(out.harness_divergence?.warning).toContain("kimi-k2");

    const entries = await world.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, card.id));
    const swap = entries.find((entry) => entry.kind === "executor_swap");
    expect(swap).toBeTruthy();
    expect(swap?.body).toContain(`planned`);
    expect(swap?.body).toContain(card.harness?.model ?? "");
    expect(swap?.body).toContain("actual kimi-cli · kimi-k2");
  });

  it("keeps the timeline clean when the executor matches the harness", async () => {
    world = await createTestWorld();
    const card = await createPlainCard("Matching executor");
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: {
        cli: "claude-code",
        model: card.harness?.model ?? "sonnet-5",
        session_id: "sess_match",
      },
    });
    expect(claimed.ok).toBe(true);

    const entries = await world.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, card.id));
    expect(entries.filter((entry) => entry.kind === "executor_swap")).toHaveLength(0);
  });

  it("accepts a spawn_failure note that never leaks into the reopen comment", async () => {
    world = await createTestWorld();
    const card = await createPlainCard("Kimi never booted");

    const updated = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      spawn_failure: "kimi-cli exited 127 before boot",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    TaskUpdateOutputSchema.parse(updated.value);

    const entries = await world.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, card.id));
    const failure = entries.find((entry) => entry.kind === "spawn_failure");
    expect(failure?.body).toContain("kimi-cli exited 127 before boot");
    expect(failure?.body).toContain("planned");

    // The trace is not a reopen instruction: the next claim briefing must
    // not carry it as the reopen comment.
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimOutputSchema.parse(claimed.value);
    expect(out.task.reopen_comment).toBeNull();
    expect(out.briefing_markdown).not.toContain("kimi-cli exited 127");
  });

  it("counts report comments and keeps them out of reopen hints", async () => {
    world = await createTestWorld();
    const card = await createPlainCard("Report no reabre");

    await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
    });
    const reported = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      comment: "Usuário não abre mais o fluxo, mas o report veio.",
      comment_kind: "report",
    });
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(TaskUpdateOutputSchema.parse(reported.value).task.reports_count).toBe(1);

    const rows = await world.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, card.id));
    expect(rows.filter((row) => row.kind === "report")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "comment")).toHaveLength(0);

    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "done",
    });
    expect(delivered.ok).toBe(true);

    await world.db
      .update(task)
      .set({ status: "aberto", claimedByTokenId: null, claimedAt: null })
      .where(eq(task.id, card.id));

    const got = await invokeTool(world.db, ctx(), "task_get", {
      task_id: card.id,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(TaskGetOutputSchema.parse(got.value).task.reports_count).toBe(1);

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimOutputSchema.parse(claimed.value);
    expect(out.task.reopen_comment).toBeNull();
    expect(out.briefing_markdown).not.toContain("Usuário não abre mais o fluxo");
  });

  it("ignores agent comments on an open card when there is no reopen handoff", async () => {
    world = await createTestWorld();
    const card = await createPlainCard("Apenas nota para timeline");

    await world.db.insert(taskComment).values({
      taskId: card.id,
      authorAgentRef: "agent://cli/overclock",
      kind: "comment",
      body: "nota interna fora da abertura",
    });

    const claimed = await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(TaskClaimOutputSchema.parse(claimed.value).task.reopen_comment).toBeNull();
  });

  it("uses the user comment as reopen comment only after the latest handoff", async () => {
    world = await createTestWorld();
    const card = await createPlainCard("Reaberto com comentário humano");

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "entrega sem comentário",
    });

    const [reviewer] = await world.db
      .insert(user)
      .values({ email: "owner@local.test", passwordHash: "x" })
      .returning({ id: user.id });
    if (!reviewer) throw new Error("failed to insert user");

    await world.db
      .update(task)
      .set({ status: "aberto", claimedByTokenId: null, claimedAt: null })
      .where(eq(task.id, card.id));
    await world.db.insert(taskComment).values({
      taskId: card.id,
      authorUserId: reviewer.id,
      kind: "comment",
      body: "falhou o cenário de borda",
    });

    const claimed = await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimOutputSchema.parse(claimed.value);
    expect(out.task.reopen_comment).toBe("falhou o cenário de borda");
    expect(out.briefing_markdown).toContain("falhou o cenário de borda");
  });

  it("rejects task_update comment_kind report without a comment body", async () => {
    world = await createTestWorld();
    const card = await createPlainCard("Invalid report kind");

    const bad = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      comment_kind: "report",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("INVALID_ARGUMENT");

    const rows = await world.db
      .select()
      .from(taskComment)
      .where(eq(taskComment.taskId, card.id));
    expect(rows).toHaveLength(0);
  });

  it("stores resolved_in on deliver, lets task_update fill or clear it, and returns it on get", async () => {
    world = await createTestWorld();
    const card = await createPlainCard("Ships in a release");
    expect(card.resolved_in).toBeNull();

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      executor: { cli: "claude-code", model: "opus-5", session_id: "sess_rel" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "done",
      resolved_in: "1.4.0",
      usage: { tokens_in: 10, tokens_out: 5, estimated: true },
    });
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(TaskDeliverOutputSchema.parse(delivered.value).task.resolved_in).toBe(
      "1.4.0",
    );

    const got = await invokeTool(world.db, ctx(), "task_get", { task_id: card.short_id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(TaskGetOutputSchema.parse(got.value).task.resolved_in).toBe("1.4.0");

    // Corrected after the fact: a later release carried the fix.
    const corrected = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      resolved_in: "1.4.1",
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(TaskUpdateOutputSchema.parse(corrected.value).task.resolved_in).toBe(
      "1.4.1",
    );

    // null clears it.
    const cleared = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      resolved_in: null,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(TaskUpdateOutputSchema.parse(cleared.value).task.resolved_in).toBeNull();
  });

  it("refuses an empty resolved_in string on task_update", async () => {
    world = await createTestWorld();
    const card = await createPlainCard("Empty release tag");
    const bad = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      resolved_in: "",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) {
      expect(bad.value).toBeUndefined();
    } else {
      expect(bad.error.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("returns a typed NOT_FOUND for task_create with an invalid project, never raw SQL", async () => {
    world = await createTestWorld();
    for (const bogus of ["proj-nope", "00000000-0000-4000-8000-00000000dead"]) {
      const created = await invokeTool(world.db, ctx(), "task_create", {
        project_id: bogus,
        title: "Card without a home",
        type: "feature",
        o_que: "x",
        por_que: "y",
        como_confirmo: [{ step: "a", expected: "b" }],
        origem,
      });
      expect(created.ok).toBe(false);
      if (created.ok) {
        expect(created.value).toBeUndefined();
      } else {
        expect(created.error.code).toBe("NOT_FOUND");
        expect(created.error.message).toMatch(/not found/i);
        expect(created.error.message).toMatch(/project_list|task_list|board/i);
        expect(created.error.message).not.toMatch(/failed query|select |sql/i);
      }
    }
  });

  it("returns a typed NOT_FOUND for task_list filters with bogus ids, never raw SQL", async () => {
    world = await createTestWorld();
    for (const args of [{ project_id: "nope" }, { mission_id: "nope" }]) {
      const listed = await invokeTool(world.db, ctx(), "task_list", args);
      expect(listed.ok).toBe(false);
      if (listed.ok) return;
      expect(listed.error.code).toBe("NOT_FOUND");
      expect(listed.error.message).not.toMatch(/failed query|select /i);
    }

    // A non-uuid reviewer ref is a legitimate agent ref, not a uuid probe.
    const byAgent = await invokeTool(world.db, ctx(), "task_list", {
      awaiting_review_by: "sess_torre",
    });
    expect(byAgent.ok).toBe(true);
  });

  it("cuts task_list to a limit and says when the board holds more", async () => {
    world = await createTestWorld();
    // The seeded world already holds a card, so this makes the board bigger
    // than the limit under test either way.
    for (let i = 0; i < 4; i++) {
      const made = await invokeTool(world.db, ctx(), "task_create", {
        project_id: world.projectId,
        title: `Card number ${i}`,
        type: "feature",
        o_que: "x",
        por_que: "y",
        como_confirmo: [{ step: "a", expected: "b" }],
        origem: { session_id: "sess_limit", cli: "overclock" },
      });
      expect(made.ok).toBe(true);
    }

    const cut = await invokeTool(world.db, ctx(), "task_list", { limit: 2 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const cutOut = TaskListOutputSchema.parse(cut.value);
    expect(cutOut.tasks).toHaveLength(2);
    expect(cutOut.limit).toBe(2);
    // The point of the flag: two cards is not the board.
    expect(cutOut.truncated).toBe(true);

    const whole = await invokeTool(world.db, ctx(), "task_list", { limit: 200 });
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    const wholeOut = TaskListOutputSchema.parse(whole.value);
    expect(wholeOut.truncated).toBe(false);
    expect(wholeOut.tasks.length).toBeGreaterThan(2);

    // Oldest first still holds, so a limit takes the head of the queue and
    // not an arbitrary slice of it.
    expect(cutOut.tasks.map((t) => t.id)).toEqual(
      wholeOut.tasks.slice(0, 2).map((t) => t.id),
    );
  });

  it("tells the agent to claim before delivering an open card", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Delivered too early",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const submitted = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "there is nothing to deliver",
    });
    expect(submitted.ok).toBe(false);
    if (submitted.ok) return;
    expect(submitted.error.code).toBe("INVALID_TRANSITION");
    expect(submitted.error.message).toBe(
      "Card is open, call task_claim before task_deliver.",
    );
    expect(submitted.error.message).not.toMatch(/handoff/i);
  });

  it("returns a clean NOT_FOUND when task_create.mission is missing", async () => {
    world = await createTestWorld();
    const missing = await invokeTool(world.db, ctx(), "task_create", {
      mission: "00000000-0000-4000-8000-000000000000",
      project_id: world.projectId,
      title: "Orphan attempt",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("NOT_FOUND");
    expect(missing.error.message).toMatch(/not found/i);

    const byTitle = await invokeTool(world.db, ctx(), "task_create", {
      mission: "Norte do board",
      project_id: world.projectId,
      title: "Title is not an id",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(byTitle.ok).toBe(false);
    if (byTitle.ok) return;
    expect(byTitle.error.code).toBe("NOT_FOUND");
  });

  it("lists missions, recommends harness, registers a branch and marks revisado", async () => {
    world = await createTestWorld();

    const missions = await invokeTool(world.db, ctx(), "mission_list", {});
    expect(missions.ok).toBe(true);
    if (!missions.ok) return;
    expect(MissionListOutputSchema.parse(missions.value).missions[0]?.title).toBe(
      "Norte do board",
    );

    const rec = await invokeTool(world.db, ctx(), "harness_recommend", {
      type: "bug",
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(HarnessRecommendOutputSchema.parse(rec.value).harness.model).toBe(
      "fable-5",
    );

    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Branch e review",
      type: "bug",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const branched = await invokeTool(world.db, ctx(), "branch_register", {
      task_id: card.short_id,
      branch: "oc-2-branch-e-review",
    });
    expect(branched.ok).toBe(true);

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "feito",
    });

    const reviewed = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      revisado: true,
      comment: "ok pela torre",
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(TaskUpdateOutputSchema.parse(reviewed.value).task.revisado).toBe(true);
  });

  it("scopes task_list to one mission via mission_id", async () => {
    world = await createTestWorld();
    const [secondMission] = await world.db
      .insert(mission)
      .values({
        workspaceId: world.workspaceId,
        title: "Segunda missão",
        objective: "Separar a fila.",
        status: "ativa",
      })
      .returning({ id: mission.id });
    if (!secondMission) throw new Error("failed to insert second mission");

    const inFirst = await invokeTool(world.db, ctx(), "task_create", {
      mission: world.missionId,
      project_id: world.projectId,
      title: "Card da primeira missão",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(inFirst.ok).toBe(true);
    const inSecond = await invokeTool(world.db, ctx(), "task_create", {
      mission: secondMission.id,
      project_id: world.projectId,
      title: "Card da segunda missão",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(inSecond.ok).toBe(true);

    const listed = await invokeTool(world.db, ctx(), "task_list", {
      mission_id: secondMission.id,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const out = TaskListOutputSchema.parse(listed.value);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]?.title).toBe("Card da segunda missão");
    expect(out.tasks[0]?.mission_id).toBe(secondMission.id);

    const listedFirst = await invokeTool(world.db, ctx(), "task_list", {
      mission_id: world.missionId,
    });
    expect(listedFirst.ok).toBe(true);
    if (!listedFirst.ok) return;
    const first = TaskListOutputSchema.parse(listedFirst.value);
    expect(first.tasks).toHaveLength(1);
    expect(first.tasks[0]?.title).toBe("Card da primeira missão");
  });

  it("hard deletes a claimed card and cascades its execution attempts", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Card para deletar",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
    });
    expect(claimed.ok).toBe(true);

    const deleted = await invokeTool(world.db, ctx(), "task_delete", {
      task_id: card.id,
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    const out = TaskDeleteOutputSchema.parse(deleted.value);
    expect(out.deleted).toBe(true);
    expect(out.short_id).toBe(card.short_id);
    expect(out.attempts_deleted).toBe(1);

    const taskRows = await world.db.select().from(task).where(eq(task.id, card.id));
    expect(taskRows).toHaveLength(0);
    const attemptRows = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, card.id));
    expect(attemptRows).toHaveLength(0);
  });

  it("hard deletes a delivered card and cascades its handoffs", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Card entregue para deletar",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "entregue",
    });
    expect(delivered.ok).toBe(true);

    const deleted = await invokeTool(world.db, ctx(), "task_delete", {
      task_id: card.short_id,
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    const out = TaskDeleteOutputSchema.parse(deleted.value);
    expect(out.handoffs_deleted).toBe(1);
    expect(out.attempts_deleted).toBe(1);

    const handoffRows = await world.db
      .select()
      .from(handoff)
      .where(eq(handoff.taskId, card.id));
    expect(handoffRows).toHaveLength(0);
  });

  it("reclassifies the card harness via task_update, validated against executors", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Card para reclassificar",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const updated = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      harness: { cli: "claude-code", model: "haiku-4-5", effort: "low" },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const out = TaskUpdateOutputSchema.parse(updated.value);
    expect(out.task.harness).toEqual({
      cli: "claude-code",
      model: "haiku-4-5",
      effort: "low",
    });

    const fetched = await invokeTool(world.db, ctx(), "task_get", {
      task_id: card.id,
    });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    const got = fetched.value as { task: { harness: unknown } };
    expect(got.task.harness).toEqual({
      cli: "claude-code",
      model: "haiku-4-5",
      effort: "low",
    });
  });

  it("rejects a harness whose model is not on any configured executor", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Harness inválido",
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;

    const badModel = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      harness: { model: "gpt-9-ultra", effort: "high" },
    });
    expect(badModel.ok).toBe(false);
    if (!badModel.ok) expect(badModel.error.code).toBe("INVALID_ARGUMENT");

    const badCli = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      harness: { cli: "codex", model: "haiku-4-5", effort: "low" },
    });
    expect(badCli.ok).toBe(false);
    if (!badCli.ok) expect(badCli.error.code).toBe("INVALID_ARGUMENT");
  });

  it("returns NOT_FOUND when deleting a card that does not exist", async () => {
    world = await createTestWorld();
    const deleted = await invokeTool(world.db, ctx(), "task_delete", {
      task_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("a rejected delivery comes back one link down the chain", () => {
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

  /** What the board UI does on reopen, which has no MCP tool of its own. */
  async function reopen(taskId: string) {
    await world.db
      .update(task)
      .set({ status: "aberto", claimedByTokenId: null, claimedAt: null })
      .where(eq(task.id, taskId));
  }

  async function newCard(title: string) {
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title,
      type: "bug",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("card not created");
    return TaskCreateOutputSchema.parse(created.value).task;
  }

  it("climbs the chain once per rejected delivery and stops at the last link", async () => {
    world = await createTestWorld();
    const card = await newCard("Card que volta");

    // bug ships as fable-5 → opus-5 → gpt-5.6-sol. Only the first two are on
    // this workspace, so the line runs out after the second try.
    expect(card.harness?.model).toBe("fable-5");

    const first = await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(TaskClaimOutputSchema.parse(first.value).task.harness?.model).toBe("fable-5");
    await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "primeira tentativa",
    });

    await reopen(card.id);
    const second = await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const retried = TaskClaimOutputSchema.parse(second.value);
    expect(retried.task.harness?.model).toBe("opus-5");
    // And the worker is told why, plus the whole line it sits on.
    expect(retried.briefing_markdown).toContain("fable-5 → opus-5 → gpt-5.6-sol");
    expect(retried.briefing_markdown).toContain("tentativa 2");

    await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "segunda tentativa",
    });
    await reopen(card.id);
    const third = await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    // gpt-5.6-sol is the next link but no executor offers it, so the card holds
    // at the best it can still run instead of stalling or wrapping around.
    expect(TaskClaimOutputSchema.parse(third.value).task.harness?.model).toBe("opus-5");
  });

  it("does not escalate a pane that was merely abandoned", async () => {
    world = await createTestWorld();
    const card = await newCard("Pane morto");

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    // force ends the open attempt as abandoned: a restart, not a verdict.
    const again = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: card.id,
      force: true,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(TaskClaimOutputSchema.parse(again.value).task.harness?.model).toBe("fable-5");
  });

  it("leaves a hand-pinned harness where the human put it", async () => {
    world = await createTestWorld();
    const card = await newCard("Fixado na mao");
    await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      harness: { cli: "claude-code", model: "opus-4-8", effort: "high" },
    });

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.id,
      summary: "reprovada",
    });
    await reopen(card.id);

    const retry = await invokeTool(world.db, ctx(), "task_claim", { task_id: card.id });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    // opus-4-8 is off the bug chain, so it was a deliberate choice. The board
    // does not get to escalate somebody else's decision.
    expect(TaskClaimOutputSchema.parse(retry.value).task.harness?.model).toBe("opus-4-8");
  });
});

describe("task_id accepts uuid and short id", () => {
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

  async function makeCard(title: string) {
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title,
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");
    return TaskCreateOutputSchema.parse(created.value).task;
  }

  it("resolves task_get and task_claim with both uuid and short id", async () => {
    world = await createTestWorld();
    const a = await makeCard("Get by short id");
    const byUuid = await invokeTool(world.db, ctx(), "task_get", {
      task_id: a.id,
    });
    const byShort = await invokeTool(world.db, ctx(), "task_get", {
      task_id: a.short_id.toLowerCase(),
    });
    expect(byUuid.ok).toBe(true);
    expect(byShort.ok).toBe(true);
    if (!byUuid.ok || !byShort.ok) return;
    expect(TaskGetOutputSchema.parse(byUuid.value).task.id).toBe(a.id);
    expect(TaskGetOutputSchema.parse(byShort.value).task.id).toBe(a.id);

    const b = await makeCard("Claim by short id");
    const claimed = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: b.short_id,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(TaskClaimOutputSchema.parse(claimed.value).task.id).toBe(b.id);
    expect(TaskClaimOutputSchema.parse(claimed.value).task.status).toBe(
      "em_execucao",
    );

    const c = await makeCard("Claim by uuid");
    const claimedUuid = await invokeTool(world.db, ctx(), "task_claim", {
      task_id: c.id,
    });
    expect(claimedUuid.ok).toBe(true);
  });

  it("resolves task_update, branch_register and task_deliver with both forms", async () => {
    world = await createTestWorld();
    const card = await makeCard("Mutations by short id");

    const branched = await invokeTool(world.db, ctx(), "branch_register", {
      task_id: card.short_id.toLowerCase(),
      branch: "oc-x-mutations-by-short-id",
    });
    expect(branched.ok).toBe(true);

    const noted = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.short_id,
      comment: "progress via short id",
    });
    expect(noted.ok).toBe(true);

    const notedUuid = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      progress: "still going",
    });
    expect(notedUuid.ok).toBe(true);

    await invokeTool(world.db, ctx(), "task_claim", { task_id: card.short_id });
    const delivered = await invokeTool(world.db, ctx(), "task_deliver", {
      task_id: card.short_id.toLowerCase(),
      summary: "done via short id",
    });
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(TaskDeliverOutputSchema.parse(delivered.value).task.id).toBe(card.id);
  });

  it("resolves task_delete and dotted child short ids", async () => {
    world = await createTestWorld();
    const team = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Parent with children",
      type: "rfc",
      o_que: "Quebrar.",
      por_que: "Grande.",
      como_confirmo: [{ step: "lê", expected: "fatias" }],
      mode: "team",
      origem,
      subtasks: [
        { title: "Fatia um", scope: "a", boundary: "não b" },
        { title: "Fatia dois", scope: "b", boundary: "não a" },
      ],
    });
    expect(team.ok).toBe(true);
    if (!team.ok) return;
    const parent = TaskCreateOutputSchema.parse(team.value).task;
    const childShort = `${parent.short_id}.1`;

    const got = await invokeTool(world.db, ctx(), "task_get", {
      task_id: childShort.toLowerCase(),
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(TaskGetOutputSchema.parse(got.value).task.short_id).toBe(childShort);
    expect(TaskGetOutputSchema.parse(got.value).task.parent_id).toBe(parent.id);

    const doomed = await makeCard("Delete by short id");
    const deleted = await invokeTool(world.db, ctx(), "task_delete", {
      task_id: doomed.short_id,
    });
    expect(deleted.ok).toBe(true);

    const doomedUuid = await makeCard("Delete by uuid");
    const deletedUuid = await invokeTool(world.db, ctx(), "task_delete", {
      task_id: doomedUuid.id,
    });
    expect(deletedUuid.ok).toBe(true);
  });

  it("does not resolve another workspace's short id", async () => {
    world = await createTestWorld();
    const card = await makeCard("Workspace scoped");

    const [otherWs] = await world.db
      .insert(workspace)
      .values({ name: "Other", executors: [] })
      .returning({ id: workspace.id });
    if (!otherWs) throw new Error("failed to insert other workspace");
    const [otherProj] = await world.db
      .insert(project)
      .values({
        workspaceId: otherWs.id,
        name: "Other",
        idPrefix: "ZZ",
        nextNumber: 1,
      })
      .returning({ id: project.id });
    if (!otherProj) throw new Error("failed to insert other project");
    const secret = generateTokenSecret();
    const [otherTok] = await world.db
      .insert(mcpToken)
      .values({
        workspaceId: otherWs.id,
        label: "other",
        hash: hashToken(secret),
        tokenPrefix: secret.slice(0, 12),
      })
      .returning({ id: mcpToken.id });
    if (!otherTok) throw new Error("failed to insert other token");

    const foreign = await invokeTool(
      world.db,
      {
        tokenId: otherTok.id,
        workspaceId: otherWs.id,
        tokenLabel: "other",
      },
      "task_get",
      { task_id: card.short_id },
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("NOT_FOUND");

    const home = await invokeTool(world.db, ctx(), "task_get", {
      task_id: card.short_id,
    });
    expect(home.ok).toBe(true);
  });
});

describe("a card joins or leaves a mission after creation", () => {
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

  async function makeLooseCard(title: string) {
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title,
      type: "feature",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");
    const out = TaskCreateOutputSchema.parse(created.value);
    expect(out.task.mission_id).toBeNull();
    return out.task;
  }

  it("attaches a loose card to a mission and lists it under that mission", async () => {
    world = await createTestWorld();
    const card = await makeLooseCard("Card born loose");

    const attached = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.short_id,
      mission_id: world.missionId,
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(TaskUpdateOutputSchema.parse(attached.value).task.mission_id).toBe(
      world.missionId,
    );

    const listed = await invokeTool(world.db, ctx(), "task_list", {
      mission_id: world.missionId,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(
      TaskListOutputSchema.parse(listed.value).tasks.map((row) => row.id),
    ).toContain(card.id);

    // The briefing the next executor reads now carries the mission context.
    const briefed = await invokeTool(world.db, ctx(), "task_get", {
      task_id: card.id,
    });
    expect(briefed.ok).toBe(true);
    if (!briefed.ok) return;
    const payload = TaskGetOutputSchema.parse(briefed.value);
    expect(payload.mission?.id).toBe(world.missionId);
    expect(payload.briefing_markdown).toContain("Norte do board");
  });

  it("detaches with mission_id null without touching anything else", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      mission: world.missionId,
      project_id: world.projectId,
      title: "Card com missao",
      type: "bug",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      priority: "alta",
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const card = TaskCreateOutputSchema.parse(created.value).task;
    expect(card.mission_id).toBe(world.missionId);

    const detached = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      mission_id: null,
    });
    expect(detached.ok).toBe(true);
    if (!detached.ok) return;
    const out = TaskUpdateOutputSchema.parse(detached.value);
    expect(out.task.mission_id).toBeNull();
    expect(out.task.title).toBe("Card com missao");
    expect(out.task.priority).toBe("alta");
    expect(out.task.status).toBe("aberto");
    expect(out.task.como_confirmo).toHaveLength(1);

    const stillListed = await invokeTool(world.db, ctx(), "task_list", {
      mission_id: world.missionId,
    });
    expect(stillListed.ok).toBe(true);
    if (!stillListed.ok) return;
    expect(
      TaskListOutputSchema.parse(stillListed.value).tasks.map((row) => row.id),
    ).not.toContain(card.id);
  });

  it("moves the subtasks of a team card with their parent", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, ctx(), "task_create", {
      project_id: world.projectId,
      title: "Card time solto",
      type: "rfc",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      mode: "team",
      origem,
      subtasks: [
        { title: "Parte 1", scope: "a", boundary: "b" },
        { title: "Parte 2", scope: "c", boundary: "d" },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const out = TaskCreateOutputSchema.parse(created.value);

    const moved = await invokeTool(world.db, ctx(), "task_update", {
      task_id: out.task.id,
      mission_id: world.missionId,
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(TaskUpdateOutputSchema.parse(moved.value).subtasks_moved).toBe(2);

    const rows = await world.db
      .select({ missionId: task.missionId })
      .from(task)
      .where(eq(task.parentId, out.task.id));
    expect(rows.map((row) => row.missionId)).toEqual([
      world.missionId,
      world.missionId,
    ]);
  });

  it("refuses a mission from another workspace and leaves the card where it was", async () => {
    world = await createTestWorld();
    const card = await makeLooseCard("Card do workspace certo");

    const [otherWs] = await world.db
      .insert(workspace)
      .values({ name: "Other", executors: [] })
      .returning({ id: workspace.id });
    if (!otherWs) throw new Error("failed to insert other workspace");
    const [otherMission] = await world.db
      .insert(mission)
      .values({
        workspaceId: otherWs.id,
        title: "Missao alheia",
        objective: "Nao e deste board.",
        status: "ativa",
      })
      .returning({ id: mission.id });
    if (!otherMission) throw new Error("failed to insert other mission");

    const refused = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      mission_id: otherMission.id,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("NOT_FOUND");
    expect(refused.error.message).toContain("mission_list");

    const [row] = await world.db
      .select({ missionId: task.missionId })
      .from(task)
      .where(eq(task.id, card.id));
    expect(row?.missionId).toBeNull();
  });

  it("refuses a mission id that is not an id at all", async () => {
    world = await createTestWorld();
    const card = await makeLooseCard("Card com id invalido");
    const refused = await invokeTool(world.db, ctx(), "task_update", {
      task_id: card.id,
      mission_id: "Norte do board",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("NOT_FOUND");
  });
});
