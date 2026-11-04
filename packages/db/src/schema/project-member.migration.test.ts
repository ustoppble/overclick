import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, "../../drizzle");
const PROJECT_MEMBER_MIGRATION = "0051_project_member.sql";

async function apply(client: PGlite, file: string): Promise<void> {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await client.exec(trimmed);
  }
}

/**
 * Project links arrive on boards that already have members, who until now saw
 * every project of their organization. The backfill must leave each of them
 * seeing exactly that: no project lost, none gained.
 */
describe("migration 0051 — project members backfill", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) {
      if (file === PROJECT_MEMBER_MIGRATION) break;
      await apply(client, file);
    }
    await client.exec(`
      INSERT INTO workspace (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'W');
      INSERT INTO organization (id, workspace_id, name) VALUES
        ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A'),
        ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'B');
      INSERT INTO project (id, workspace_id, organization_id, name, id_prefix) VALUES
        ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1', 'AA'),
        ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2', 'AB'),
        ('bbbbbbbb-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'B1', 'BA');
      INSERT INTO "user" (id, email, role, organization_id) VALUES
        ('cccccccc-0000-0000-0000-000000000001', 'admin@x.test', 'admin', NULL),
        ('cccccccc-0000-0000-0000-000000000002', 'ma@x.test', 'member', 'aaaaaaaa-0000-0000-0000-000000000001'),
        ('cccccccc-0000-0000-0000-000000000003', 'mb@x.test', 'member', 'aaaaaaaa-0000-0000-0000-000000000002'),
        ('cccccccc-0000-0000-0000-000000000004', 'orphan@x.test', 'member', NULL);
      INSERT INTO invitation (workspace_id, email, organization_id, token_hash, expires_at) VALUES
        ('11111111-1111-1111-1111-111111111111', 'later@x.test', 'aaaaaaaa-0000-0000-0000-000000000001', 'h', now() + interval '1 day');
    `);
    await apply(client, PROJECT_MEMBER_MIGRATION);
  });

  afterAll(async () => {
    await client.close();
  });

  it("links every member to every project of their organization, and nobody else", async () => {
    const rows = await client.query<{ email: string; name: string }>(`
      SELECT u.email, p.name FROM project_member pm
      JOIN "user" u ON u.id = pm.user_id
      JOIN project p ON p.id = pm.project_id
      ORDER BY u.email, p.name
    `);
    expect(rows.rows).toEqual([
      { email: "ma@x.test", name: "A1" },
      { email: "ma@x.test", name: "A2" },
      { email: "mb@x.test", name: "B1" },
    ]);
  });

  it("gives pending invitations an empty project list", async () => {
    const rows = await client.query<{ project_ids: string[] }>("SELECT project_ids FROM invitation");
    expect(rows.rows).toEqual([{ project_ids: [] }]);
  });

  it("refuses the same link twice and drops links with their project or person", async () => {
    await expect(
      client.exec(`INSERT INTO project_member (project_id, user_id) VALUES
        ('bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000002')`),
    ).rejects.toThrow();
    await client.exec(`DELETE FROM "user" WHERE id = 'cccccccc-0000-0000-0000-000000000003'`);
    const left = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM project_member");
    expect(left.rows[0]?.n).toBe(2);
  });

  it("is ordered after every migration production already applied", () => {
    const journal = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const mine = journal.entries.find((e) => e.tag === "0051_project_member");
    const before = journal.entries.filter((e) => e.tag < "0051_project_member");
    expect(mine).toBeDefined();
    expect(before.every((e) => e.when < mine!.when)).toBe(true);
  });
});
