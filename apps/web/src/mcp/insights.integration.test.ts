import {
  executionAttempt,
  modelPrice,
  task,
  taskComment,
  user,
  workspace,
} from "@agent-board/db";
import { eq } from "drizzle-orm";
import { InsightsQueryOutputSchema } from "@agent-board/mcp-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeInsights,
  loadInsightAttemptRows,
  loadReopenRows,
} from "../lib/insights";
import { loadModelPrices } from "../lib/prices";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

/**
 * The card's How-to-confirm is "the numbers match the Insights page". The page
 * is loaders + computeInsights, so every assertion here is either a literal
 * from the seed or a comparison against that exact path.
 */
describe("insights_query answers what the Insights page answers", () => {
  let world: TestWorld;
  let fullTaskId: string;
  let estimatedTaskId: string;

  function ctx() {
    return {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "test-agent",
      canManage: false,
    };
  }

  async function pageInsights() {
    const [rows, reopens, prices] = await Promise.all([
      loadInsightAttemptRows(world.db, world.workspaceId),
      loadReopenRows(world.db, world.workspaceId),
      loadModelPrices(world.db, world.workspaceId),
    ]);
    return computeInsights(rows, reopens, prices);
  }

  async function setPricing(enabled: boolean) {
    await world.db
      .update(workspace)
      .set({ pricingEnabled: enabled })
      .where(eq(workspace.id, world.workspaceId));
  }

  beforeAll(async () => {
    world = await createTestWorld();
    // This suite is about the money layer, which is opt-in and off by default.
    // The last test turns it back off and checks what the default looks like.
    await setPricing(true);

    const [reviewer] = await world.db
      .insert(user)
      .values({ email: "owner@local.test", passwordHash: "x" })
      .returning({ id: user.id });
    if (!reviewer) throw new Error("failed to insert user");

    const [full] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        missionId: world.missionId,
        shortId: "OC-1",
        title: "Card with full usage",
        status: "feito",
        resolvedIn: "v1.2.0",
      })
      .returning({ id: task.id });
    const [estimated] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        shortId: "OC-2",
        title: "Card with estimated usage",
        status: "aberto",
      })
      .returning({ id: task.id });
    const [demo] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        shortId: "OC-3",
        title: "Seeded example card",
        status: "feito",
        isExample: true,
      })
      .returning({ id: task.id });
    if (!full || !estimated || !demo) throw new Error("failed to insert tasks");
    fullTaskId = full.id;
    estimatedTaskId = estimated.id;

    await world.db.insert(executionAttempt).values([
      {
        taskId: full.id,
        model: "sonnet-5",
        result: "success",
        startedAt: new Date("2026-08-10T10:00:00Z"),
        finishedAt: new Date("2026-08-10T11:00:00Z"),
        tokensIn: 1000,
        tokensOut: 500,
        tokensCache: 0,
        costUsd: "2.00",
        durationMs: 3_600_000,
        turns: 12,
        usageEstimated: false,
      },
      {
        taskId: estimated.id,
        model: "opus-4-8",
        result: "success",
        startedAt: new Date("2026-08-11T10:00:00Z"),
        finishedAt: new Date("2026-08-11T10:30:00Z"),
        tokensIn: 400,
        tokensOut: 100,
        costUsd: "0.50",
        durationMs: 1_800_000,
        turns: 5,
        usageEstimated: true,
      },
      // Delivered without any usage: counted as missing, never as zero.
      {
        taskId: estimated.id,
        model: "haiku-4",
        result: "success",
        startedAt: new Date("2026-08-12T09:00:00Z"),
        finishedAt: new Date("2026-08-12T09:20:00Z"),
        serverDurationMs: 1_200_000,
        usageEstimated: false,
      },
      // Still running: nothing honest to sum yet.
      {
        taskId: estimated.id,
        model: "opus-4-8",
        startedAt: new Date("2026-08-13T10:00:00Z"),
      },
      // Example card: demo data must never inflate real cost.
      {
        taskId: demo.id,
        model: "sonnet-5",
        result: "success",
        startedAt: new Date("2026-08-10T10:00:00Z"),
        finishedAt: new Date("2026-08-10T10:10:00Z"),
        costUsd: "99.00",
        usageEstimated: false,
      },
    ]);

    await world.db.insert(taskComment).values({
      taskId: estimated.id,
      authorUserId: reviewer.id,
      body: "The totals do not match, run it again.",
      createdAt: new Date("2026-08-11T12:00:00Z"),
    });
  });

  afterAll(async () => {
    await closeTestWorld(world);
  });

  it("returns the same totals the page computes, with the honesty note", async () => {
    const queried = await invokeTool(world.db, ctx(), "insights_query", {});
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const out = InsightsQueryOutputSchema.parse(queried.value);
    const page = await pageInsights();

    expect(out.totals).toEqual({
      cost_usd: page.totals.costUsd,
      cost_computed: page.totals.costComputed,
      cost_reported: page.totals.costReported,
      cost_estimated: page.totals.costEstimated,
      cost_unpriced: page.totals.costUnpriced,
      tokens: page.totals.tokens,
      duration_ms: page.totals.durationMs,
      elapsed_ms: page.totals.elapsedMs,
      elapsed_only: page.totals.elapsedOnly,
      attempts: page.totals.attempts,
      estimated: page.totals.estimated,
      missing: page.totals.missing,
      zero_usage: page.totals.zeroUsage,
      suspect: page.totals.suspect,
      suspect_tokens: page.totals.suspectTokens,
      suspect_duration_ms: page.totals.suspectDurationMs,
      suspect_cost_usd: page.totals.suspectCostUsd,
      delivery_unverified: page.totals.deliveryUnverified,
    });
    // Three finished attempts on real cards; the example card's $99 is out.
    expect(out.totals.attempts).toBe(3);
    // Both priced attempts are computed from the seeded table, not from the
    // $2.00 and $0.50 the agents sent: 1000·3 + 500·15, and 400·5 + 100·25.
    expect(out.totals.cost_usd).toBeCloseTo(0.015);
    expect(out.totals.cost_computed).toBe(2);
    expect(out.totals.cost_reported).toBe(0);
    expect(out.totals.tokens).toBe(2000);
    expect(out.totals.estimated).toBe(1);
    expect(out.totals.missing).toBe(1);
    expect(out.note).toBe("1 estimated · 1 usage not reported");
    expect(out.cost_note).toBe("2 computed");
    expect(out.period).toEqual({ since: null, until: null });
    // Without group_by the response stays small.
    expect(out.groups).toBeUndefined();
    expect(out.cards).toBeUndefined();
  });

  it("groups by mission, project and model exactly as the page does", async () => {
    const page = await pageInsights();

    for (const [groupBy, expected] of [
      ["mission", page.byMission],
      ["project", page.byProject],
      ["model", page.byModel],
      ["executor", page.byExecutor],
    ] as const) {
      const queried = await invokeTool(world.db, ctx(), "insights_query", {
        group_by: groupBy,
      });
      expect(queried.ok).toBe(true);
      if (!queried.ok) return;
      const out = InsightsQueryOutputSchema.parse(queried.value);
      expect(out.groups).toEqual(
        expected.map((row) => ({
          key: row.key,
          label: row.label,
          cost_usd: row.costUsd,
          cost_computed: row.costComputed,
          cost_reported: row.costReported,
          cost_estimated: row.costEstimated,
          cost_unpriced: row.costUnpriced,
          tokens: row.tokens,
          duration_ms: row.durationMs,
          elapsed_ms: row.elapsedMs,
          elapsed_only: row.elapsedOnly,
          attempts: row.attempts,
          estimated: row.estimated,
          missing: row.missing,
          zero_usage: row.zeroUsage,
          suspect: row.suspect,
          suspect_tokens: row.suspectTokens,
          suspect_duration_ms: row.suspectDurationMs,
          suspect_cost_usd: row.suspectCostUsd,
          delivery_unverified: row.deliveryUnverified,
        })),
      );
    }

    // "How much did this mission cost?" is one call plus one lookup.
    const byMission = await invokeTool(world.db, ctx(), "insights_query", {
      group_by: "mission",
    });
    if (!byMission.ok) return;
    const missions = InsightsQueryOutputSchema.parse(byMission.value).groups;
    expect(
      missions?.find((row) => row.label === "Norte do board")?.cost_usd,
    ).toBeCloseTo(0.0105);
    // The loose card's group carries a null label, never an invented one.
    expect(missions?.find((row) => row.label === null)?.attempts).toBe(2);
  });

  it("groups by release, with null as the unreleased bucket", async () => {
    const queried = await invokeTool(world.db, ctx(), "insights_query", {
      group_by: "release",
    });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const out = InsightsQueryOutputSchema.parse(queried.value);
    const page = await pageInsights();

    expect(out.groups).toEqual(
      page.byRelease.map((row) =>
        expect.objectContaining({
          key: row.key,
          label: row.label,
          cost_usd: row.costUsd,
          tokens: row.tokens,
          attempts: row.attempts,
        }),
      ),
    );
    expect(out.groups?.find((row) => row.label === "v1.2.0")?.attempts).toBe(1);
    expect(out.groups?.find((row) => row.label === null)?.attempts).toBe(2);
  });

  it("reports the reopened rate per model, highest first", async () => {
    const queried = await invokeTool(world.db, ctx(), "insights_query", {});
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const out = InsightsQueryOutputSchema.parse(queried.value);
    const page = await pageInsights();
    expect(out.reopened_by_model).toEqual(page.reopensByModel);

    expect(out.reopened_by_model[0]).toEqual({
      model: "opus-4-8",
      deliveries: 1,
      reopened: 1,
      rate: 1,
    });
    expect(
      out.reopened_by_model.find((row) => row.model === "sonnet-5")?.rate,
    ).toBe(0);
  });

  it("keeps an unreported cost null on a card instead of calling it zero", async () => {
    const queried = await invokeTool(world.db, ctx(), "insights_query", {
      group_by: "card",
    });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const out = InsightsQueryOutputSchema.parse(queried.value);
    expect(out.groups).toBeUndefined();

    const full = out.cards?.find((row) => row.task_id === fullTaskId);
    expect(full).toMatchObject({
      short_id: "OC-1",
      project: "OverClick",
      mission: "Norte do board",
      models: ["sonnet-5"],
      attempts: 1,
      estimated: false,
      missing: false,
      cost_source: "computed",
    });
    expect(full?.cost_usd).toBeCloseTo(0.0105);

    const partial = out.cards?.find((row) => row.task_id === estimatedTaskId);
    expect(partial?.models).toEqual(["opus-4-8", "haiku-4"]);
    expect(partial?.estimated).toBe(true);
    expect(partial?.missing).toBe(true);
    expect(out.cards?.map((row) => row.short_id)).not.toContain("OC-3");
  });

  it("narrows the period by when the attempt finished", async () => {
    const queried = await invokeTool(world.db, ctx(), "insights_query", {
      since: "2026-08-11T00:00:00.000Z",
      until: "2026-08-11T23:59:59.000Z",
    });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const out = InsightsQueryOutputSchema.parse(queried.value);
    expect(out.totals.attempts).toBe(1);
    expect(out.totals.cost_usd).toBeCloseTo(0.0045);
    expect(out.totals.estimated).toBe(1);
    expect(out.note).toBe("1 estimated");
    expect(out.period.since).toBe("2026-08-11T00:00:00.000Z");

    // A reopen that landed outside the window still counts for the delivery
    // inside it: the period narrows attempts, not the reopen signal.
    expect(out.reopened_by_model).toEqual([
      { model: "opus-4-8", deliveries: 1, reopened: 1, rate: 1 },
    ]);
  });

  it("returns an empty picture for a period with no attempts", async () => {
    const queried = await invokeTool(world.db, ctx(), "insights_query", {
      since: "2030-01-01T00:00:00.000Z",
    });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const out = InsightsQueryOutputSchema.parse(queried.value);
    expect(out.totals.attempts).toBe(0);
    // Null, not zero: with nothing to price there is no figure to report, and
    // a zero here would read as work that happened and cost nothing.
    expect(out.totals.cost_usd).toBeNull();
    expect(out.note).toBe("all usage reported");
    expect(out.reopened_by_model).toEqual([]);
  });

  it("rejects an inverted period", async () => {
    const queried = await invokeTool(world.db, ctx(), "insights_query", {
      since: "2026-08-12T00:00:00.000Z",
      until: "2026-08-10T00:00:00.000Z",
    });
    expect(queried.ok).toBe(false);
    if (queried.ok) return;
    expect(queried.error.code).toBe("INVALID_ARGUMENT");
    expect(queried.error.message).toContain("inverted");
  });

  it("recomputes legacy rows with no snapshot until the backfill reaches them", async () => {
    // Same edit the Settings price table writes: sonnet-5 at twice the price.
    await world.db.insert(modelPrice).values({
      workspaceId: world.workspaceId,
      model: "sonnet-5",
      label: "sonnet-5",
      inputPerMtok: "6",
      outputPerMtok: "30",
      cachePerMtok: "0.6",
      cacheWritePerMtok: "7.5",
      seededAt: null,
      updatedBy: "owner@local.test",
    });

    const queried = await invokeTool(world.db, ctx(), "insights_query", {
      group_by: "card",
    });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const out = InsightsQueryOutputSchema.parse(queried.value);
    const full = out.cards?.find((row) => row.task_id === fullTaskId);
    expect(full?.cost_usd).toBeCloseTo(0.021);
    expect(full?.cost_source).toBe("computed");
    expect(out.totals.cost_usd).toBeCloseTo(0.0255);

    // The price list is readable before picking a harness, with the edit
    // marked as a human's and the untouched rows still stamped with the date
    // the public prices were captured.
    const listed = await invokeTool(world.db, ctx(), "harness_list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const prices = (listed.value as { prices: Array<Record<string, unknown>> }).prices;
    const sonnet = prices.find((row) => row.model === "sonnet-5");
    expect(sonnet).toMatchObject({
      input_per_mtok: 6,
      output_per_mtok: 30,
      source: "custom",
      seeded_at: null,
      updated_by: "owner@local.test",
    });
    const opus = prices.find((row) => row.model === "opus-4-8");
    expect(opus).toMatchObject({ source: "seed", input_per_mtok: 5 });
    expect(opus?.seeded_at).toBeTruthy();

    await world.db.delete(modelPrice);
  });

  it("reports no dollars at all when the money layer is off", async () => {
    await setPricing(false);
    try {
      const queried = await invokeTool(world.db, ctx(), "insights_query", {
        group_by: "card",
      });
      expect(queried.ok).toBe(true);
      if (!queried.ok) return;
      const out = InsightsQueryOutputSchema.parse(queried.value);

      expect(out.pricing_enabled).toBe(false);
      // Null, not zero: with cost off there is no figure to report at all.
      expect(out.totals.cost_usd).toBeNull();
      expect(out.totals.cost_computed).toBe(0);
      expect(out.totals.cost_unpriced).toBe(0);
      expect(out.cost_note).toContain("tokens and time only");
      expect(out.cards?.every((row) => row.cost_usd === null)).toBe(true);
      expect(out.cards?.every((row) => row.cost_source === null)).toBe(true);

      // The facts survive untouched: tokens, time and the honesty note.
      expect(out.totals.tokens).toBe(2000);
      // Execution is the two attempts that reported working; the third one
      // only ever had a claim to deliver clock, so it lands on elapsed.
      expect(out.totals.duration_ms).toBe(5_400_000);
      expect(out.totals.elapsed_ms).toBe(1_200_000);
      expect(out.totals.elapsed_only).toBe(1);
      expect(out.totals.attempts).toBe(3);
      expect(out.note).toBe("1 estimated · 1 usage not reported");
    } finally {
      await setPricing(true);
    }
  });

  it("is readable with a plain worker token, no manage flag needed", async () => {
    const queried = await invokeTool(
      world.db,
      { ...ctx(), canManage: false },
      "insights_query",
      {},
    );
    expect(queried.ok).toBe(true);
  });
});
