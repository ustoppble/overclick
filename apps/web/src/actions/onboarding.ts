"use server";

import {
  DEFAULT_ORGANIZATION_NAME,
  isValidPrefix,
  organization,
  project,
} from "@agent-board/db";
import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import type { ActionResult } from "../lib/action-result";

export type ProjectInput = {
  name: string;
  repoUrl: string;
  prefix: string;
  /** The business this first project belongs to. Blank takes the default. */
  organizationName?: string;
};

/**
 * The business the first project is filed under. Named, it is created if the
 * instance has never heard of it; skipped, the wizard falls back to the
 * organization migration 0037 already left behind (or creates it), so a fresh
 * instance still gets a working board without answering a question it has no
 * opinion about yet.
 */
async function resolveOrganization(
  workspaceId: string,
  name: string,
): Promise<string | null> {
  const wanted = name.trim() || DEFAULT_ORGANIZATION_NAME;
  const [found] = await db()
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(
        eq(organization.workspaceId, workspaceId),
        eq(organization.name, wanted),
      ),
    )
    .limit(1);
  if (found) return found.id;

  try {
    const [created] = await db()
      .insert(organization)
      .values({ workspaceId, name: wanted })
      .returning({ id: organization.id });
    if (created) return created.id;
  } catch {
    // A concurrent wizard won the unique index; the row it wrote is the one.
  }

  const [existing] = await db()
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.workspaceId, workspaceId))
    .orderBy(asc(organization.createdAt))
    .limit(1);
  return existing?.id ?? null;
}

/** Wizard T1: creates or updates the workspace's first project. */
export async function saveProjectAction(input: ProjectInput): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the project a name. The repo name works." };

  const prefix = input.prefix.trim().toUpperCase();
  if (!isValidPrefix(prefix)) {
    return { ok: false, error: "Prefix of 2 to 4 characters, letters and numbers (e.g. AGB)." };
  }
  const repoUrl = input.repoUrl.trim() || null;

  const organizationId = await resolveOrganization(
    ws.id,
    input.organizationName ?? "",
  );
  if (!organizationId) {
    return { ok: false, error: "Could not resolve the organization." };
  }

  const existing = await db().query.project.findFirst({
    where: eq(project.workspaceId, ws.id),
  });

  try {
    if (existing) {
      await db()
        .update(project)
        .set({ name, repoUrl, idPrefix: prefix })
        .where(eq(project.id, existing.id));
    } else {
      await db().insert(project).values({
        workspaceId: ws.id,
        organizationId,
        name,
        repoUrl,
        idPrefix: prefix,
      });
    }
  } catch {
    return { ok: false, error: "A project with that prefix already exists. Try another." };
  }
  revalidatePath("/onboarding");
  revalidatePath("/home");
  return { ok: true };
}
