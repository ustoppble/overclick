import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORGANIZATION_NAME } from "../defaults";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, "../../drizzle");

/** Everything up to, but not including, the organization layer. */
const ORGANIZATION_MIGRATION = "0037_organization_layer.sql";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function apply(client: PGlite, file: string): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await client.exec(trimmed);
  }
}

async function count(client: PGlite, query: string): Promise<number> {
  const result = await client.query<{ n: number }>(query);
  return Number(result.rows[0]?.n ?? -1);
}

/**
 * The organization layer arrives on boards that already hold projects and
 * missions, so the migration is exercised the way it will actually run: with
 * rows in place, not against an empty database.
 */
describe("migration 0037 — organization layer", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    for (const file of migrationFiles()) {
      if (file === ORGANIZATION_MIGRATION) break;
      await apply(client, file);
    }

    await client.exec(`
      INSERT INTO workspace (id, name) VALUES
        ('11111111-1111-1111-1111-111111111111', 'One'),
        ('22222222-2222-2222-2222-222222222222', 'Two');
      INSERT INTO project (workspace_id, name, id_prefix) VALUES
        ('11111111-1111-1111-1111-111111111111', 'Board', 'BRD'),
        ('11111111-1111-1111-1111-111111111111', 'Site', 'STE'),
        ('22222222-2222-2222-2222-222222222222', 'Other', 'OTH');
      INSERT INTO mission (workspace_id, title) VALUES
        ('11111111-1111-1111-1111-111111111111', 'Ship the board');
    `);

    await apply(client, ORGANIZATION_MIGRATION);
  });

  it("gives every workspace one organization to start from", async () => {
    const rows = await client.query<{ workspace_id: string; name: string }>(
      "SELECT workspace_id, name FROM organization ORDER BY name",
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.name).toBe(DEFAULT_ORGANIZATION_NAME);
    }
  });

  it("leaves no project or mission without an organization", async () => {
    expect(
      await count(client, "SELECT count(*)::int AS n FROM project WHERE organization_id IS NULL"),
    ).toBe(0);
    expect(
      await count(client, "SELECT count(*)::int AS n FROM mission WHERE organization_id IS NULL"),
    ).toBe(0);
  });

  it("keeps each row inside its own workspace's organization", async () => {
    expect(
      await count(
        client,
        `SELECT count(*)::int AS n FROM project p
         JOIN organization o ON o.id = p.organization_id
         WHERE o.workspace_id <> p.workspace_id`,
      ),
    ).toBe(0);
  });

  it("refuses to delete an organization that still holds a project", async () => {
    await expect(
      client.exec(
        `DELETE FROM organization WHERE workspace_id = '11111111-1111-1111-1111-111111111111'`,
      ),
    ).rejects.toThrow();
    expect(await count(client, "SELECT count(*)::int AS n FROM project")).toBe(3);
  });

  it("makes the columns NOT NULL, so no orphan can be created later", async () => {
    await expect(
      client.exec(
        `INSERT INTO project (workspace_id, name, id_prefix)
         VALUES ('11111111-1111-1111-1111-111111111111', 'Orphan', 'ORP')`,
      ),
    ).rejects.toThrow();
  });
});
