"use server";

import { mission, organization, project } from "@agent-board/db";
import { and, count, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { ORGANIZATION_CONTEXT_MAX_CHARS } from "../lib/organizations";

const NAME_MAX_CHARS = 200;

function cleanName(value: string): string | null {
  const name = value.trim();
  return name.length >= 1 && name.length <= NAME_MAX_CHARS ? name : null;
}

async function workspaceId(): Promise<string | null> {
  const ws = await db().query.workspace.findFirst({ columns: { id: true } });
  return ws?.id ?? null;
}

export async function createOrganizationAction(input: {
  name: string;
  context?: string;
}): Promise<
  { ok: true; organization: { id: string } } | { ok: false; error: string }
> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const ws = await workspaceId();
  if (!ws) return { ok: false, error: "Workspace not found." };

  const name = cleanName(input.name);
  if (!name) {
    return {
      ok: false,
      error: `Organization name must be 1 to ${NAME_MAX_CHARS} characters.`,
    };
  }
  const context = input.context ?? "";
  if (context.length > ORGANIZATION_CONTEXT_MAX_CHARS) {
    return {
      ok: false,
      error: `Organization context cannot exceed ${ORGANIZATION_CONTEXT_MAX_CHARS} characters.`,
    };
  }

  try {
    const [created] = await db()
      .insert(organization)
      .values({
        workspaceId: ws,
        name,
        context: context.trim() ? context : null,
      })
      .returning({ id: organization.id });
    if (!created) return { ok: false, error: "Could not create the organization." };

    revalidatePath("/settings");
    revalidatePath("/organizations");
    revalidatePath("/home");
    return { ok: true, organization: created };
  } catch {
    // The name is unique per workspace, which is the only way this insert
    // fails on data the form can produce.
    return { ok: false, error: "An organization with that name already exists." };
  }
}

export async function saveOrganizationAction(input: {
  organizationId: string;
  name: string;
  context: string;
}): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const ws = await workspaceId();
  if (!ws) return { ok: false, error: "Workspace not found." };

  const name = cleanName(input.name);
  if (!name) {
    return {
      ok: false,
      error: `Organization name must be 1 to ${NAME_MAX_CHARS} characters.`,
    };
  }
  if (input.context.length > ORGANIZATION_CONTEXT_MAX_CHARS) {
    return {
      ok: false,
      error: `Organization context cannot exceed ${ORGANIZATION_CONTEXT_MAX_CHARS} characters.`,
    };
  }

  try {
    const [updated] = await db()
      .update(organization)
      .set({ name, context: input.context.trim() ? input.context : null })
      .where(
        and(
          eq(organization.id, input.organizationId),
          eq(organization.workspaceId, ws),
        ),
      )
      .returning({ id: organization.id });
    if (!updated) return { ok: false, error: "Organization not found." };
  } catch {
    return { ok: false, error: "An organization with that name already exists." };
  }

  revalidatePath("/settings");
  revalidatePath("/organizations");
  revalidatePath("/home");
  return { ok: true };
}

/**
 * Deleting a business is refused while anything still lives under it, and the
 * refusal says what blocks it. The columns are not nullable on purpose (the
 * FK is `on delete restrict`), so there is nothing to detach to: the way out
 * is to move the projects and the missions first, which is a decision only
 * the owner can make.
 */
export async function deleteOrganizationAction(input: {
  organizationId: string;
}): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const ws = await workspaceId();
  if (!ws) return { ok: false, error: "Workspace not found." };

  const [found] = await db()
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(
        eq(organization.id, input.organizationId),
        eq(organization.workspaceId, ws),
      ),
    )
    .limit(1);
  if (!found) return { ok: false, error: "Organization not found." };

  const [projectCount] = await db()
    .select({ n: count() })
    .from(project)
    .where(eq(project.organizationId, input.organizationId));
  const [missionCount] = await db()
    .select({ n: count() })
    .from(mission)
    .where(eq(mission.organizationId, input.organizationId));

  const projects = Number(projectCount?.n ?? 0);
  const missions = Number(missionCount?.n ?? 0);
  if (projects > 0 || missions > 0) {
    const blocking = [
      projects > 0 ? `${projects} project${projects === 1 ? "" : "s"}` : null,
      missions > 0 ? `${missions} mission${missions === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return {
      ok: false,
      error: `This organization still holds ${blocking}. Move them to another organization first.`,
    };
  }

  // The last one cannot go: every project and mission needs an organization to
  // be created in, so an instance with none can no longer take work.
  const [sibling] = await db()
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(
        eq(organization.workspaceId, ws),
        ne(organization.id, input.organizationId),
      ),
    )
    .limit(1);
  if (!sibling) {
    return {
      ok: false,
      error: "This is the only organization. A board needs one to file work under.",
    };
  }

  await db()
    .delete(organization)
    .where(
      and(
        eq(organization.id, input.organizationId),
        eq(organization.workspaceId, ws),
      ),
    );

  revalidatePath("/settings");
  revalidatePath("/organizations");
  revalidatePath("/home");
  return { ok: true };
}
