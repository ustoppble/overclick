import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb } from "./client";
import { requireDatabaseUrl } from "./env";
import { factoryCardapioPolicy } from "./domain/cardapio";
import {
  cardapioEntry,
  organization,
  project,
  task,
  workspace,
} from "./schema";
import {
  EXAMPLE_CARD,
  EXAMPLE_ORGANIZATION,
  EXAMPLE_PROJECT,
  EXAMPLE_WORKSPACE,
} from "./seed-data";

export async function seed(url = requireDatabaseUrl()): Promise<{
  skipped: boolean;
  workspaceId?: string;
  organizationId?: string;
  projectId?: string;
  taskId?: string;
}> {
  const { db, sql } = createDb(url);
  try {
    const existing = await db.select({ id: workspace.id }).from(workspace).limit(1);
    if (existing[0]) {
      return { skipped: true, workspaceId: existing[0].id };
    }

    const [ws] = await db
      .insert(workspace)
      .values({
        name: EXAMPLE_WORKSPACE.name,
        executors: EXAMPLE_WORKSPACE.executors,
        cardapio: EXAMPLE_WORKSPACE.cardapio,
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
      .values({ workspaceId: ws.id, name: EXAMPLE_ORGANIZATION.name })
      .returning({ id: organization.id });

    if (!org) throw new Error("failed to insert organization");

    const [proj] = await db
      .insert(project)
      .values({
        workspaceId: ws.id,
        organizationId: org.id,
        name: EXAMPLE_PROJECT.name,
        repoUrl: EXAMPLE_PROJECT.repoUrl,
        idPrefix: EXAMPLE_PROJECT.idPrefix,
        nextNumber: EXAMPLE_PROJECT.nextNumber,
      })
      .returning({ id: project.id });

    if (!proj) throw new Error("failed to insert project");

    const [card] = await db
      .insert(task)
      .values({
        projectId: proj.id,
        shortId: EXAMPLE_CARD.shortId,
        title: EXAMPLE_CARD.title,
        oQue: EXAMPLE_CARD.oQue,
        porQue: EXAMPLE_CARD.porQue,
        comoConfirmo: EXAMPLE_CARD.comoConfirmo,
        tipo: EXAMPLE_CARD.tipo,
        status: EXAMPLE_CARD.status,
        isExample: EXAMPLE_CARD.isExample,
        harness: EXAMPLE_CARD.harness,
        devolveParaKind: "workspace_queue",
      })
      .returning({ id: task.id });

    if (!card) throw new Error("failed to insert example card");

    return {
      skipped: false,
      workspaceId: ws.id,
      organizationId: org.id,
      projectId: proj.id,
      taskId: card.id,
    };
  } finally {
    await sql.end();
  }
}

export async function workspaceCount(url = requireDatabaseUrl()): Promise<number> {
  const { db, sql } = createDb(url);
  try {
    const rows = await db.select({ id: workspace.id }).from(workspace);
    return rows.length;
  } finally {
    await sql.end();
  }
}

export async function findExampleCard(url = requireDatabaseUrl()) {
  const { db, sql } = createDb(url);
  try {
    const [row] = await db
      .select()
      .from(task)
      .where(eq(task.shortId, EXAMPLE_CARD.shortId))
      .limit(1);
    return row ?? null;
  } finally {
    await sql.end();
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  seed()
    .then((result) => {
      console.log(result.skipped ? "seed skipped (workspace exists)" : "seed applied");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
