"use server";

import { derivePrefix, isValidPrefix, organization, project, projectContextAudit } from "@agent-board/db";
import {
  PROJECT_CONTEXT_MAX_CHARS,
  ProjectContextSourceSchema,
} from "@agent-board/mcp-core";
import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { findProjectByPrefix, insertProject } from "../lib/project-create";
import { canManageStructure } from "../lib/scope";
import { sessionPrincipal } from "../lib/web-scope";

export type ProjectContextInput = {
  projectId: string;
  context: string;
  currentVersion: string;
  contextSource?: {
    releasesRepo?: string;
    contextFile?: string;
    refresh: "on_release" | "daily" | "manual";
  } | null;
};

/** Saves the human-maintained project briefing shown to every future agent. */
export async function saveProjectContextAction(
  input: ProjectContextInput,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  // Editing a project is the admin's; a member only reads it.
  if (!canManageStructure(await sessionPrincipal(session))) {
    return { ok: false, error: "Only an admin can change a project." };
  }

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };
  if (input.context.length > PROJECT_CONTEXT_MAX_CHARS) {
    return {
      ok: false,
      error: `Project context cannot exceed ${PROJECT_CONTEXT_MAX_CHARS} characters.`,
    };
  }

  const currentVersion = input.currentVersion.trim();
  if (currentVersion.length > 200) {
    return { ok: false, error: "Current version cannot exceed 200 characters." };
  }

  let contextSource: {
    releasesRepo?: string;
    contextFile?: string;
    refresh: "on_release" | "daily" | "manual";
  } | null | undefined;
  if (input.contextSource !== undefined) {
    if (!input.contextSource) {
      contextSource = null;
    } else {
      const parsed = ProjectContextSourceSchema.safeParse({
        releases_repo: input.contextSource.releasesRepo?.trim() || undefined,
        context_file: input.contextSource.contextFile?.trim() || undefined,
        refresh: input.contextSource.refresh,
      });
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid context source." };
      }
      contextSource = {
        ...(parsed.data.releases_repo
          ? { releasesRepo: parsed.data.releases_repo }
          : {}),
        ...(parsed.data.context_file
          ? { contextFile: parsed.data.context_file }
          : {}),
        refresh: parsed.data.refresh,
      };
    }
  }

  const sourceTouched = input.contextSource !== undefined;
  const contextTouched = true;

  const [updated] = await db()
    .update(project)
    .set({
      context: input.context.trim() ? input.context : null,
      currentVersion: currentVersion || null,
      ...(sourceTouched ? { contextSource } : {}),
      ...(contextTouched ? { contextUpdatedAt: new Date() } : {}),
    })
    .where(
      and(
        eq(project.id, input.projectId),
        eq(project.workspaceId, ws.id),
      ),
    )
    .returning({ id: project.id });
  if (!updated) return { ok: false, error: "Project not found." };

  if (contextTouched) {
    await db().insert(projectContextAudit).values({
      projectId: updated.id,
      source: "manual",
      sourceRef: `manual:${Date.now()}:${session.userId}`,
      version: currentVersion || null,
      prerelease: false,
      summary: "project context updated manually",
      actor: session.email,
    });
  }

  revalidatePath("/settings");
  revalidatePath("/home");
  return { ok: true };
}

export type CreateProjectInput = {
  name: string;
  repoUrl: string;
  /** Typed card prefix; empty derives one from the name. */
  prefix: string;
  /** Required when the workspace has more than one organization. */
  organizationId?: string;
};

/**
 * "+ Projeto" in Settings (E5): the same project `project_create` makes, for
 * the admin at the screen. The card ids start at <PREFIX>-1.
 */
export async function createProjectAction(
  input: CreateProjectInput,
): Promise<
  | { ok: true; project: { id: string; name: string; idPrefix: string } }
  | { ok: false; error: string }
> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (!canManageStructure(await sessionPrincipal(session))) {
    return { ok: false, error: "Only an admin can create a project." };
  }
  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the project a name." };

  const typed = input.prefix.trim().toUpperCase();
  const prefix = typed || derivePrefix(name);
  if (!prefix) {
    return {
      ok: false,
      error: "Could not derive a card prefix from that name. Type one: 2 to 4 letters or digits.",
    };
  }
  if (!isValidPrefix(prefix)) {
    return { ok: false, error: `Prefix '${prefix}' is invalid: use 2 to 4 letters or digits, for example AGB.` };
  }
  const taken = await findProjectByPrefix(db(), ws.id, prefix);
  if (taken) {
    return { ok: false, error: `Prefix '${prefix}' is already used by project '${taken.name}'.` };
  }

  const organizations = await db()
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(eq(organization.workspaceId, ws.id))
    .orderBy(asc(organization.name));
  let organizationId: string;
  if (input.organizationId) {
    if (!organizations.some((row) => row.id === input.organizationId)) {
      return { ok: false, error: "Organization not found." };
    }
    organizationId = input.organizationId;
  } else if (organizations.length === 1) {
    organizationId = organizations[0]!.id;
  } else if (organizations.length === 0) {
    return { ok: false, error: "This workspace has no organization yet. Create one first." };
  } else {
    return {
      ok: false,
      error: `This workspace has ${organizations.length} organizations: choose one of ${organizations
        .map((row) => row.name)
        .join(", ")}.`,
    };
  }

  const inserted = await insertProject(db(), {
    workspaceId: ws.id,
    organizationId,
    name,
    prefix,
    repoUrl: input.repoUrl,
  });
  if (!inserted.ok) {
    return { ok: false, error: `Prefix '${prefix}' was just taken by another project.` };
  }

  revalidatePath("/settings");
  revalidatePath("/home");
  return {
    ok: true,
    project: { id: inserted.row.id, name: inserted.row.name, idPrefix: inserted.row.idPrefix },
  };
}
