import { exec } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ProjectGetOutputSchema,
  TaskClaimCompactOutputSchema,
  TaskClaimOutputSchema,
  TaskCreateClaimedOutputSchema,
  TaskGetOutputSchema,
} from "@agent-board/mcp-core";
import { executionAttempt, project, usageRecipe } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeTool } from "./tools";

const PLUGIN_MEASURE = resolve(__dirname, "../../../../plugin/bin/measure.cjs");

/** ~4 characters per token: the same yardstick the OCL-183 measurement used. */
const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

describe("compact claim (OCL-183)", () => {
  let world: TestWorld;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (world) await closeTestWorld(world);
  });

  const author = () => ({
    tokenId: world.tokenId,
    workspaceId: world.workspaceId,
    tokenLabel: "author",
  });
  const other = () => ({
    tokenId: world.secondTokenId,
    workspaceId: world.workspaceId,
    tokenLabel: "executor",
  });

  const contract = {
    type: "feature",
    o_que: "Quem pega o card recebe o contrato uma vez só.",
    por_que: "O claim relido a cada turno custava 14 mil tokens.",
    como_confirmo: [{ step: "pega o card", expected: "vem o contrato uma vez" }],
  } as const;

  /** A project dossier the size of the one measured in the field (~8k tokens). */
  async function withDossier() {
    await world.db
      .update(project)
      .set({
        context: `# Dossier\n\n${"Regra do projeto que o executor não precisa em todo claim. ".repeat(540)}`,
        currentVersion: "1.3.7",
      })
      .where(eq(project.id, world.projectId));
  }

  it("creates and claims in one call, answering only id, branch, commit prefix and the measuring line", async () => {
    world = await createTestWorld();
    const created = await invokeTool(world.db, author(), "task_create", {
      project_id: world.projectId,
      title: "Create and claim",
      ...contract,
      origem: { cli: "claude", session_id: "author-session" },
      claim: {
        executor: { cli: "claude-code", model: "opus-5", effort: "high", session_id: "author-session" },
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const out = TaskCreateClaimedOutputSchema.parse(created.value);
    expect(Object.keys(created.value as object).sort()).toEqual(
      ["branch", "claimed_at", "commit_prefix", "measure", "short_id", "status"].sort(),
    );
    expect(out.status).toBe("em_execucao");
    expect(out.branch).toMatch(/^oc-1-create-and-claim/);
    expect(out.commit_prefix).toBe("[OC-1]");
    expect(out.measure?.command).toContain("measure.cjs");
    expect(out.measure?.command).toContain("cli=claude-code");
    expect(out.measure?.command).not.toMatch(/https?:/);
    expect(tokens(created.value)).toBeLessThan(400);

    const [attempt] = await world.db.select().from(executionAttempt);
    const got = await invokeTool(world.db, author(), "task_get", { task_id: "OC-1" });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(TaskGetOutputSchema.parse(got.value).task.status).toBe("em_execucao");
    expect(attempt?.model).toBe("opus-5");
  });

  it("refuses create+claim for an unregistered model without leaving a card behind", async () => {
    world = await createTestWorld();
    const refused = await invokeTool(world.db, author(), "task_create", {
      project_id: world.projectId,
      title: "Refused claim",
      ...contract,
      origem: { cli: "claude" },
      claim: { executor: { cli: "claude-code", model: "not-a-model" } },
    });
    expect(refused.ok).toBe(false);
    const list = await invokeTool(world.db, author(), "task_list", {});
    expect(list.ok && (list.value as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("claims another author's card with the contract once, no dossier, the recipe cited by one line, under 2k tokens", async () => {
    world = await createTestWorld();
    await withDossier();
    const created = await invokeTool(world.db, author(), "task_create", {
      project_id: world.projectId,
      title: "Someone else's card",
      ...contract,
      origem: { cli: "claude", session_id: "author-session" },
    });
    expect(created.ok).toBe(true);

    const full = await invokeTool(world.db, author(), "task_get", {
      task_id: "OC-1",
      view: "full",
    });
    expect(full.ok).toBe(true);

    const claimed = await invokeTool(world.db, other(), "task_claim", {
      task_id: "OC-1",
      executor: { cli: "claude-code", model: "opus-5", session_id: "executor-session" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || !full.ok) return;
    const out = TaskClaimCompactOutputSchema.parse(claimed.value);
    const text = JSON.stringify(claimed.value);

    expect(out.o_que).toBe(contract.o_que);
    expect(out.por_que).toBe(contract.por_que);
    expect(out.como_confirmo).toEqual(contract.como_confirmo);
    expect(out.harness).toBeDefined();
    expect(out.branch).toMatch(/^oc-1-/);
    expect(out.authored_here).toBeUndefined();
    // The contract travels once: no markdown copy, no dossier, no pasted recipe.
    expect(claimed.value).not.toHaveProperty("briefing_markdown");
    expect(claimed.value).not.toHaveProperty("usage_recipe");
    expect(text.split(contract.o_que)).toHaveLength(2);
    expect(text).not.toContain("Regra do projeto");
    expect(text).not.toContain("readdirSync");
    expect(out.measure?.command?.split("\n")).toHaveLength(1);
    expect(out.measure?.command).toContain(`claimed_at=${out.claimed_at}`);
    expect(out.deliver).toContain("project_get");

    // The measurement the card asks for: ~14k before, under 2k after.
    const before = tokens(full.value);
    const after = tokens(claimed.value);
    expect(before).toBeGreaterThan(8_000);
    expect(after).toBeLessThan(2_000);
  });

  it("leaves the contract out when the claiming session wrote the card", async () => {
    world = await createTestWorld();
    await invokeTool(world.db, author(), "task_create", {
      project_id: world.projectId,
      title: "My own card",
      ...contract,
      origem: { cli: "claude", session_id: "same-session" },
    });
    const claimed = await invokeTool(world.db, author(), "task_claim", {
      task_id: "OC-1",
      executor: { cli: "claude-code", model: "opus-5", session_id: "same-session" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimCompactOutputSchema.parse(claimed.value);
    expect(out.authored_here).toBe(true);
    expect(out.o_que).toBeUndefined();
    expect(out.como_confirmo).toBeUndefined();
    expect(out.branch).toMatch(/^oc-1-/);
  });

  it("still returns the legacy briefing on return: full", async () => {
    world = await createTestWorld();
    await invokeTool(world.db, author(), "task_create", {
      project_id: world.projectId,
      title: "Legacy briefing",
      ...contract,
      origem: { cli: "claude" },
    });
    const claimed = await invokeTool(world.db, other(), "task_claim", {
      task_id: "OC-1",
      return: "full",
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(TaskClaimOutputSchema.parse(claimed.value).briefing_markdown).toContain(
      "## Project context",
    );
  });

  it("points a workspace-rewritten recipe at task_get instead of pasting it", async () => {
    world = await createTestWorld();
    await world.db.insert(usageRecipe).values({
      workspaceId: world.workspaceId,
      cli: "claude-code",
      label: "Custom",
      yields: "tokens_per_model",
      instructions: "Our own way.",
      command: "our-measure --json",
      updatedBy: "owner",
    });
    await invokeTool(world.db, author(), "task_create", {
      project_id: world.projectId,
      title: "Custom recipe",
      ...contract,
      origem: { cli: "claude" },
    });
    const claimed = await invokeTool(world.db, other(), "task_claim", {
      task_id: "OC-1",
      executor: { cli: "claude-code", model: "opus-5" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const out = TaskClaimCompactOutputSchema.parse(claimed.value);
    expect(out.measure?.command).toBeUndefined();
    expect(out.measure?.note).toContain("task_get");
    expect(JSON.stringify(claimed.value)).not.toContain("our-measure");
  });

  it("serves the dossier on demand with the version its release source reports now", async () => {
    world = await createTestWorld();
    await world.db
      .update(project)
      .set({
        currentVersion: "1.3.7",
        contextSource: { releasesRepo: "owner/app", refresh: "on_release" },
      })
      .where(eq(project.id, world.projectId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/releases")
          ? Response.json([
              {
                id: 24,
                tag_name: "1.3.24",
                name: "1.3.24",
                body: "Latest",
                prerelease: false,
                published_at: "2026-09-18T00:00:00Z",
                html_url: "https://github.com/owner/app/releases/tag/1.3.24",
              },
            ])
          : new Response("not found", { status: 404 }),
      ),
    );

    const got = await invokeTool(world.db, author(), "project_get", {
      project_id: world.projectId,
      view: "briefing",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const out = ProjectGetOutputSchema.parse(got.value).project;
    expect(out.current_version).toBe("1.3.24");
    expect("context" in out && out.context).toContain("1.3.24");
  });

  it("the cited line runs the plugin's local recipe and measures the transcript", async () => {
    world = await createTestWorld();
    await invokeTool(world.db, author(), "task_create", {
      project_id: world.projectId,
      title: "Measure me",
      ...contract,
      origem: { cli: "claude" },
    });
    const claimed = await invokeTool(world.db, other(), "task_claim", {
      task_id: "OC-1",
      executor: { cli: "claude-code", model: "opus-5" },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const command = TaskClaimCompactOutputSchema.parse(claimed.value).measure?.command;
    expect(command).toBeDefined();

    // Where install.sh puts the plugin: <config root>/overclick/plugin.
    const config = mkdtempSync(join(tmpdir(), "ocl-183-config-"));
    mkdirSync(join(config, "overclick", "plugin", "bin"), { recursive: true });
    const run = (env: Record<string, string>, cwd: string) =>
      promisify(exec)(command as string, {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
      });

    // No plugin yet: an estimate request, not a stack trace.
    const empty = JSON.parse(
      (await run({ XDG_CONFIG_HOME: config }, config)).stdout,
    ) as { estimated: boolean; reason: string };
    expect(empty.estimated).toBe(true);
    expect(empty.reason).toContain("not installed");

    copyFileSync(
      PLUGIN_MEASURE,
      join(config, "overclick", "plugin", "bin", "measure.cjs"),
    );
    const dir = mkdtempSync(join(tmpdir(), "ocl-183-"));
    const transcript = join(dir, "session.jsonl");
    const later = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(
      transcript,
      [
        { timestamp: "2000-01-01T00:00:00Z", message: { model: "claude-opus-5", usage: { input_tokens: 999 } } },
        {
          timestamp: later,
          message: {
            model: "claude-opus-5",
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 40,
            },
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    const { stdout: printed } = await run(
      { XDG_CONFIG_HOME: config, TRANSCRIPT_PATH: transcript },
      dir,
    );
    const measured = JSON.parse(printed) as {
      segments: Array<Record<string, unknown>>;
      estimated: boolean;
    };
    expect(measured.estimated).toBe(false);
    // Only the entry after claimed_at counts: the claim window reached the script.
    expect(measured.segments).toEqual([
      { model: "claude-opus-5", input: 10, output: 20, cache_read: 30, cache_write: 40 },
    ]);
  });
});
