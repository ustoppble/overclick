import { project } from "@agent-board/db";
import { and, asc, eq } from "drizzle-orm";
import { projectScope, type MaybePrincipal } from "../../../lib/scope";
import type { McpDatabase } from "../../../mcp/types";

/**
 * The project name "Meu agente" prints in the connect commands: the first
 * project the person may see, by the same scope as every other door. A member
 * with no linked project gets null, so the page falls back to something neutral
 * instead of naming a project of their organization they have no link to.
 */
export async function linkedProjectName(
  db: Pick<McpDatabase, "select">,
  workspaceId: string,
  principal: MaybePrincipal,
): Promise<string | null> {
  if (!principal) return null;
  const [row] = await db
    .select({ name: project.name })
    .from(project)
    .where(and(eq(project.workspaceId, workspaceId), projectScope(principal)))
    .orderBy(asc(project.createdAt))
    .limit(1);
  return row?.name ?? null;
}
