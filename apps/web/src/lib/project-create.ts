import { project } from "@agent-board/db";
import { and, eq, sql } from "drizzle-orm";
import type { McpDatabase } from "../mcp/types";

/**
 * Making a project, shared by the MCP tool `project_create` and the
 * "+ Projeto" button in Settings (E5). Each caller keeps what is its own: the
 * tool its token scope and its wording, the screen its admin check. What they
 * share is the row and what the database says about a prefix.
 */

export type ProjectRow = typeof project.$inferSelect;

export type NewProject = {
  workspaceId: string;
  organizationId: string;
  name: string;
  /** Already upper-cased and validated. */
  prefix: string;
  repoUrl?: string | null;
  context?: string | null;
  currentVersion?: string | null;
  contextSource?: {
    releases_repo?: string;
    context_file?: string;
    refresh: "on_release" | "daily" | "manual";
  } | null;
};

/** The unique index on (workspace, prefix) is what a concurrent create trips. */
export function isPrefixConflict(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
  return message.includes("project_workspace_prefix");
}

/** The project that already carries this prefix in the workspace, if any. */
export async function findProjectByPrefix(
  db: McpDatabase,
  workspaceId: string,
  prefix: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: project.id, name: project.name })
    .from(project)
    .where(
      and(
        eq(project.workspaceId, workspaceId),
        sql`upper(${project.idPrefix}) = ${prefix.toUpperCase()}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Inserts the project. A prefix taken between the caller's check and this
 * insert comes back as `prefix_conflict`, not as a driver error.
 */
export async function insertProject(
  db: McpDatabase,
  input: NewProject,
): Promise<{ ok: true; row: ProjectRow } | { ok: false; reason: "prefix_conflict" }> {
  const source = input.contextSource ?? null;
  const context = input.context?.trim() ? input.context : null;
  const currentVersion = input.currentVersion?.trim() || null;
  try {
    const [row] = await db
      .insert(project)
      .values({
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        name: input.name,
        repoUrl: input.repoUrl?.trim() || null,
        context,
        currentVersion,
        contextSource: source
          ? {
              ...(source.releases_repo ? { releasesRepo: source.releases_repo } : {}),
              ...(source.context_file ? { contextFile: source.context_file } : {}),
              refresh: source.refresh,
            }
          : null,
        contextUpdatedAt: context || currentVersion || source ? new Date() : null,
        idPrefix: input.prefix,
        nextNumber: 1,
      })
      .returning();
    if (!row) throw new Error("failed to insert project");
    return { ok: true, row };
  } catch (error) {
    if (isPrefixConflict(error)) return { ok: false, reason: "prefix_conflict" };
    throw error;
  }
}
