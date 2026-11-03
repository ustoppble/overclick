import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, "../../drizzle");

/**
 * The board reads every card with its comments, and its window keeps the
 * finished cards by how recently they changed. Without these two indexes the
 * first is a sequential scan of task_comment per card (2.7 s on 3,580 cards,
 * 0.23 s with the index) and the second a scan of every card ever made.
 */
describe("board indexes", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) await client.exec(trimmed);
      }
    }
  });

  async function indexDefs(table: string): Promise<string[]> {
    const result = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = $1",
      [table],
    );
    return result.rows.map((row) => row.indexdef);
  }

  it("indexes the comments by their card", async () => {
    const defs = await indexDefs("task_comment");
    expect(defs.some((def) => /\(task_id\)/.test(def))).toBe(true);
  });

  it("indexes the cards by when they last changed", async () => {
    const defs = await indexDefs("task");
    expect(defs.some((def) => /\(updated_at\)/.test(def))).toBe(true);
  });
});
