import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executionAttempt, task } from "@agent-board/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(here, "../../../../packages/db/drizzle/0026_silly_ironclad.sql"),
  "utf8",
);
const backfill = migration.split("--> statement-breakpoint")[1]?.trim();

describe("OCL-29 executor identity backfill", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("normalizes the confirmed aliases on attempts from 2026-08-18", async () => {
    world = await createTestWorld();
    if (!backfill) throw new Error("backfill statement not found");

    const [withHarness, withoutHarness] = await world.db
      .insert(task)
      .values([
        {
          projectId: world.projectId,
          shortId: "OC-200",
          title: "With Codex harness",
          harness: { cli: "codex", model: "gpt-5.6-sol", effort: "high" },
        },
        {
          projectId: world.projectId,
          shortId: "OC-201",
          title: "Without harness",
        },
      ])
      .returning();
    if (!withHarness || !withoutHarness) throw new Error("failed to create cards");

    await world.db.insert(executionAttempt).values([
      {
        taskId: withHarness.id,
        executor: JSON.stringify({ cli: "Codex CLI" }),
        model: "gpt-5",
        startedAt: new Date("2026-08-18T12:00:00Z"),
      },
      {
        taskId: withoutHarness.id,
        executor: JSON.stringify({ cli: "codex" }),
        model: "gpt-5-codex",
        startedAt: new Date("2026-08-18T13:00:00Z"),
      },
      {
        taskId: withoutHarness.id,
        executor: JSON.stringify({ cli: "codex" }),
        model: "gpt-5",
        startedAt: new Date("2026-08-18T14:00:00Z"),
      },
    ]);

    await world.client.exec(backfill);
    const rows = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, withHarness.id));
    expect(rows[0]).toMatchObject({
      model: "gpt-5-6-sol",
      modelSource: "harness",
    });
    expect(JSON.parse(rows[0]?.executor ?? "{}")).toMatchObject({ cli: "codex" });

    const noHarness = await world.db
      .select()
      .from(executionAttempt)
      .where(eq(executionAttempt.taskId, withoutHarness.id))
      .orderBy(asc(executionAttempt.startedAt));
    expect(noHarness.map((row) => [row.model, row.modelSource])).toEqual([
      ["gpt-5-3-codex-spark", "declared"],
      ["gpt-5-6-sol", "harness"],
    ]);
  });
});
