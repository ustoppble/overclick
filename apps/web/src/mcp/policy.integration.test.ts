import { cardapioEntry } from "@agent-board/db";
import {
  FACTORY_CARDAPIO_POLICY,
  HarnessListOutputSchema,
  HarnessRecommendOutputSchema,
  HarnessSetFullOutputSchema as HarnessSetOutputSchema,
} from "@agent-board/mcp-core";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { dict } from "../lib/i18n";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

describe("cardápio policy via MCP", () => {
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

  it("harness_list returns the seeded factory policy and configured executors", async () => {
    world = await createTestWorld();
    const listed = await invokeTool(world.db, ctx(), "harness_list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const out = HarnessListOutputSchema.parse(listed.value);
    expect(out.policy.map((row) => row.type)).toEqual(
      FACTORY_CARDAPIO_POLICY.map((row) => row.type),
    );
    expect(out.policy.find((row) => row.type === "bug")).toEqual({
      type: "bug",
      cli: null,
      model: "fable-5",
      chain: ["fable-5", "opus-5", "gpt-5.6-sol"],
      effort: "medium",
      // Seeded straight from the factory policy: nobody has changed it yet.
      updated_by: null,
      updated_at: expect.any(String),
    });
    for (const row of out.policy) {
      expect(row).not.toHaveProperty("skills");
    }
    expect(out.executors).toHaveLength(1);
    expect(out.executors[0]).toMatchObject({
      id: "claude-code",
      label: "Claude Code",
      enabled: true,
      models: ["fable-5", "opus-5", "opus-4-8", "sonnet-5", "haiku-4-5"],
    });
    expect(out.executors[0]?.efforts["fable-5"]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(out.executors[0]?.effort_sources?.["fable-5"]).toMatch(
      /\/effort$/,
    );
  });

  it("editing the stored policy changes what harness_recommend returns", async () => {
    world = await createTestWorld();
    await world.db
      .update(cardapioEntry)
      .set({ cli: "claude-code", model: "opus-4-8", effort: "high" })
      .where(
        and(
          eq(cardapioEntry.workspaceId, world.workspaceId),
          eq(cardapioEntry.activityType, "bug"),
        ),
      );

    const rec = await invokeTool(world.db, ctx(), "harness_recommend", {
      type: "bug",
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const out = HarnessRecommendOutputSchema.parse(rec.value);
    expect(out.harness).toEqual({
      cli: "claude-code",
      model: "opus-4-8",
      effort: "high",
    });
    expect(out.harness).not.toHaveProperty("skills");
  });

  it("falls back to factory defaults when the type is missing from the stored policy", async () => {
    world = await createTestWorld();
    await world.db
      .delete(cardapioEntry)
      .where(
        and(
          eq(cardapioEntry.workspaceId, world.workspaceId),
          eq(cardapioEntry.activityType, "drone"),
        ),
      );

    const rec = await invokeTool(world.db, ctx(), "harness_recommend", {
      type: "drone",
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const out = HarnessRecommendOutputSchema.parse(rec.value);
    expect(out.harness.model).toBe("haiku-4-5");
    expect(out.harness.effort).toBe("low");
    expect(out.harness.cli).toBeNull();
  });

  it("returns a supported effort when a legacy policy row has an invalid value", async () => {
    world = await createTestWorld();
    await world.db
      .update(cardapioEntry)
      .set({ cli: "claude-code", model: "haiku-4-5", effort: "max" })
      .where(
        and(
          eq(cardapioEntry.workspaceId, world.workspaceId),
          eq(cardapioEntry.activityType, "bug"),
        ),
      );

    const rec = await invokeTool(world.db, ctx(), "harness_recommend", {
      type: "bug",
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const out = HarnessRecommendOutputSchema.parse(rec.value);
    expect(out.harness).toMatchObject({
      cli: "claude-code",
      model: "haiku-4-5",
      effort: "low",
    });
    expect(out.divergence).toContain("max");
  });
});

describe("harness_set writes the policy over MCP", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  /** Plain worker token: claims and delivers, cannot touch the config. */
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

  it("moves the bug line to another model and harness_recommend follows", async () => {
    world = await createTestWorld();
    const set = await invokeTool(world.db, manager(), "harness_set", {
      type: "bug",
      cli: "claude-code",
      model: "opus-4-8",
      effort: "high",
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const out = HarnessSetOutputSchema.parse(set.value);
    expect(out.policy).toMatchObject({
      type: "bug",
      cli: "claude-code",
      model: "opus-4-8",
      effort: "high",
      updated_by: "owner-console",
    });
    expect(out.policy.updated_at).toBeTruthy();

    const rec = await invokeTool(world.db, worker(), "harness_recommend", {
      type: "bug",
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(HarnessRecommendOutputSchema.parse(rec.value).harness).toEqual({
      cli: "claude-code",
      model: "opus-4-8",
      effort: "high",
    });

    // The trail travels with the policy: harness_list carries who and when.
    const listed = await invokeTool(world.db, worker(), "harness_list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const policy = HarnessListOutputSchema.parse(listed.value).policy;
    expect(policy.find((row) => row.type === "bug")?.updated_by).toBe(
      "owner-console",
    );
    expect(policy.find((row) => row.type === "feature")?.updated_by).toBeNull();
  });

  it("refuses a worker token with a typed permission error and leaves the policy alone", async () => {
    world = await createTestWorld();
    const before = await world.db
      .select()
      .from(cardapioEntry)
      .where(
        and(
          eq(cardapioEntry.workspaceId, world.workspaceId),
          eq(cardapioEntry.activityType, "bug"),
        ),
      );

    const set = await invokeTool(world.db, worker(), "harness_set", {
      type: "bug",
      model: "opus-4-8",
      effort: "high",
    });
    expect(set.ok).toBe(false);
    if (set.ok) return;
    expect(set.error.code).toBe("PERMISSION_DENIED");
    // The refusal has to name a control that exists. It used to ask for
    // "can manage the workspace", a phrase the board never showed anywhere,
    // so the user had nothing to tick (OCL-136). Pinning it to the dictionary
    // means renaming the checkbox renames the error too, or this fails.
    const settings = dict("en").settings;
    expect(set.error.message).toContain("Settings › MCP tokens");
    expect(set.error.message).toContain(settings.manageBadge);
    expect(set.error.message).toContain(settings.manageLabel);

    const after = await world.db
      .select()
      .from(cardapioEntry)
      .where(
        and(
          eq(cardapioEntry.workspaceId, world.workspaceId),
          eq(cardapioEntry.activityType, "bug"),
        ),
      );
    expect(after[0]?.model).toBe(before[0]?.model);
    expect(after[0]?.effort).toBe(before[0]?.effort);
    expect(after[0]?.updatedBy).toBeNull();
  });

  it("validates the pair against the configured executors", async () => {
    world = await createTestWorld();
    const unknownModel = await invokeTool(world.db, manager(), "harness_set", {
      type: "feature",
      model: "gpt-nonexistent",
      effort: "medium",
    });
    expect(unknownModel.ok).toBe(false);
    if (unknownModel.ok) return;
    expect(unknownModel.error.code).toBe("INVALID_ARGUMENT");
    expect(unknownModel.error.message).toContain("harness_list");

    const wrongCli = await invokeTool(world.db, manager(), "harness_set", {
      type: "feature",
      cli: "codex",
      model: "opus-4-8",
      effort: "medium",
    });
    expect(wrongCli.ok).toBe(false);
    if (wrongCli.ok) return;
    expect(wrongCli.error.code).toBe("INVALID_ARGUMENT");
  });

  it("keeps no preference when the cli is omitted", async () => {
    world = await createTestWorld();
    const set = await invokeTool(world.db, manager(), "harness_set", {
      type: "drone",
      model: "haiku-4-5",
      effort: "low",
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(HarnessSetOutputSchema.parse(set.value).policy.cli).toBeNull();

    const rec = await invokeTool(world.db, manager(), "harness_recommend", {
      type: "drone",
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(HarnessRecommendOutputSchema.parse(rec.value).harness.cli).toBeNull();
  });

  it("creates the line when the type had no stored entry yet", async () => {
    world = await createTestWorld();
    await world.db
      .delete(cardapioEntry)
      .where(
        and(
          eq(cardapioEntry.workspaceId, world.workspaceId),
          eq(cardapioEntry.activityType, "contract"),
        ),
      );

    const set = await invokeTool(world.db, manager(), "harness_set", {
      type: "contract",
      model: "sonnet-5",
      effort: "high",
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(HarnessSetOutputSchema.parse(set.value).policy).toMatchObject({
      type: "contract",
      model: "sonnet-5",
      effort: "high",
      updated_by: "owner-console",
    });
  });
});
