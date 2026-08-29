import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  cardapioEntry,
  factoryCardapioPolicy,
  mcpToken,
  mission,
  organization,
  project,
  workspace,
  type ExecutorConfig,
} from "@agent-board/db";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@agent-board/db/schema";
import { generateTokenSecret, hashToken } from "./token";
import type { McpDatabase } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, "../../../../packages/db/drizzle");

export type TestWorld = {
  db: McpDatabase;
  client: PGlite;
  workspaceId: string;
  organizationId: string;
  projectId: string;
  missionId: string;
  tokenId: string;
  secret: string;
  revokedSecret: string;
  secondSecret: string;
  secondTokenId: string;
  /** Token with the manage flag on: the only one allowed to write the config. */
  manageSecret: string;
  manageTokenId: string;
  /** Already revoked: nothing may be granted to it, capability included. */
  revokedTokenId: string;
};

/**
 * Wide enough that the shipped routing table resolves end to end, and still
 * carrying an older model so the tests that pin one keep meaning something.
 */
const TEST_EXECUTORS: ExecutorConfig[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    enabled: true,
    models: ["fable-5", "opus-5", "opus-4-8", "sonnet-5", "haiku-4-5"],
  },
];

/**
 * Every project and mission hangs off an organization, so a fixture that
 * reaches past the MCP tools to insert one directly — usually to build a
 * neighbouring workspace the token must not see — needs a business first.
 */
export async function insertOrganization(
  db: McpDatabase,
  workspaceId: string,
  name = "General",
): Promise<string> {
  const [row] = await db
    .insert(organization)
    .values({ workspaceId, name })
    .returning({ id: organization.id });
  if (!row) throw new Error("failed to insert organization");
  return row.id;
}

export async function createTestWorld(): Promise<TestWorld> {
  const client = new PGlite();
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

  const db = drizzle(client, { schema }) as unknown as McpDatabase;

  const [ws] = await db
    .insert(workspace)
    .values({
      name: "OverClick Test",
      executors: TEST_EXECUTORS,
    })
    .returning({ id: workspace.id });
  if (!ws) throw new Error("failed to insert workspace");

  await db.insert(cardapioEntry).values(
    factoryCardapioPolicy().map((row) => ({
      workspaceId: ws.id,
      activityType: row.type,
      cli: row.cli,
      model: row.model,
      chain: row.chain,
      effort: row.effort,
    })),
  );

  const [org] = await db
    .insert(organization)
    .values({ workspaceId: ws.id, name: "General" })
    .returning({ id: organization.id });
  if (!org) throw new Error("failed to insert organization");

  const [proj] = await db
    .insert(project)
    .values({
      workspaceId: ws.id,
      organizationId: org.id,
      name: "OverClick",
      idPrefix: "OC",
      nextNumber: 1,
    })
    .returning({ id: project.id });
  if (!proj) throw new Error("failed to insert project");

  const [miss] = await db
    .insert(mission)
    .values({
      workspaceId: ws.id,
      organizationId: org.id,
      title: "Norte do board",
      objective: "Fechar o loop MCP do MVP.",
      status: "ativa",
    })
    .returning({ id: mission.id });
  if (!miss) throw new Error("failed to insert mission");

  const secret = generateTokenSecret();
  const secondSecret = generateTokenSecret();
  const revokedSecret = generateTokenSecret();

  const [tok] = await db
    .insert(mcpToken)
    .values({
      workspaceId: ws.id,
      label: "test-agent",
      hash: hashToken(secret),
      tokenPrefix: secret.slice(0, 12),
    })
    .returning({ id: mcpToken.id });
  if (!tok) throw new Error("failed to insert token");

  const [tok2] = await db
    .insert(mcpToken)
    .values({
      workspaceId: ws.id,
      label: "second-agent",
      hash: hashToken(secondSecret),
      tokenPrefix: secondSecret.slice(0, 12),
    })
    .returning({ id: mcpToken.id });
  if (!tok2) throw new Error("failed to insert second token");

  const manageSecret = generateTokenSecret();
  const [manager] = await db
    .insert(mcpToken)
    .values({
      workspaceId: ws.id,
      label: "owner-console",
      hash: hashToken(manageSecret),
      tokenPrefix: manageSecret.slice(0, 12),
      canManage: true,
    })
    .returning({ id: mcpToken.id });
  if (!manager) throw new Error("failed to insert manage token");

  const [revoked] = await db
    .insert(mcpToken)
    .values({
      workspaceId: ws.id,
      label: "revoked-agent",
      hash: hashToken(revokedSecret),
      tokenPrefix: revokedSecret.slice(0, 12),
      revoked: true,
      revokedAt: new Date(),
    })
    .returning({ id: mcpToken.id });
  if (!revoked) throw new Error("failed to insert revoked token");

  return {
    db,
    client,
    workspaceId: ws.id,
    organizationId: org.id,
    projectId: proj.id,
    missionId: miss.id,
    tokenId: tok.id,
    secret,
    revokedSecret,
    secondSecret,
    secondTokenId: tok2.id,
    manageSecret,
    manageTokenId: manager.id,
    revokedTokenId: revoked.id,
  };
}

export async function closeTestWorld(world: TestWorld): Promise<void> {
  await world.client.close();
}
