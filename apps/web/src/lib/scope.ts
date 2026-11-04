import { mission, organization, project, task, user } from "@agent-board/db";
import { eq, or, sql, type SQL } from "drizzle-orm";
import type { AuthContext, McpDatabase } from "../mcp/types";

/**
 * The one place that answers "what may this person see and change?".
 *
 * Every door (web actions and pages, the MCP tools) asks here instead of
 * deciding for itself, so the rule cannot drift between them. The model:
 *
 * - admin: everything, as before.
 * - member: only the projects an admin linked them to (`project_member`),
 *   inside their own organization, and every card in those projects whoever
 *   wrote it; the missions they authored or that hold a card in one of those
 *   projects; their own organization; no workspace configuration; only their
 *   own tokens. No link means no project and no card at all.
 * - anyone we cannot identify (no user behind a token, a user that was
 *   deactivated): nothing. Deny is the default.
 *
 * Out of scope means non-existent: callers answer "not found" for a row that
 * fails these checks, never "forbidden", so its existence is not revealed.
 *
 * The links are read inside each query (a subquery on `project_member`), never
 * cached on the session or the token: an admin changing them takes effect on
 * the member's next request, without signing in again.
 */
export type Role = "admin" | "member";

export type Principal = {
  userId: string;
  role: Role;
  /** The member's organization. Always null for an admin, who has no fence. */
  organizationId: string | null;
};

/** Null means "no access at all". */
export type MaybePrincipal = Principal | null;

/** The token's owner as a principal; a token with no owner has none. */
export function principalFromAuth(ctx: AuthContext): MaybePrincipal {
  if (!ctx.userId || !ctx.role) return null;
  return {
    userId: ctx.userId,
    role: ctx.role,
    organizationId: ctx.role === "admin" ? null : (ctx.organizationId ?? null),
  };
}

/** The signed-in user of a web session as a principal. */
export async function principalFromUserId(
  db: Pick<McpDatabase, "select">,
  userId: string,
): Promise<MaybePrincipal> {
  const [row] = await db
    .select({
      id: user.id,
      role: user.role,
      organizationId: user.organizationId,
      active: user.active,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row || !row.active) return null;
  return {
    userId: row.id,
    role: row.role,
    organizationId: row.role === "admin" ? null : row.organizationId,
  };
}

/**
 * The context a web action hands the MCP tools when a signed-in human acts, so
 * the tools apply the same scope to them as to their tokens. Null when the
 * user cannot be identified or was deactivated: the action must refuse.
 */
export async function authContextForUser(
  db: Pick<McpDatabase, "select">,
  session: { userId: string; email: string },
  workspaceId: string,
): Promise<AuthContext | null> {
  const principal = await principalFromUserId(db, session.userId);
  if (!principal) return null;
  return {
    // The id is only compared against a claim holder; it is never stored as a
    // token, so a live agent claim is still refused here, as over MCP.
    tokenId: session.userId,
    workspaceId,
    tokenLabel: session.email,
    userId: principal.userId,
    role: principal.role,
    organizationId: principal.organizationId,
    canManage: principal.role === "admin",
  };
}

export function isAdmin(principal: MaybePrincipal): boolean {
  return principal?.role === "admin";
}

/** Harness, executors, prices, invitations, team, other people's tokens. */
export function canManageWorkspace(principal: MaybePrincipal): boolean {
  return isAdmin(principal);
}

/** Creating, editing or deleting a project or an organization. */
export function canManageStructure(principal: MaybePrincipal): boolean {
  return isAdmin(principal);
}

export function canSeeOrganization(
  principal: MaybePrincipal,
  row: { id: string },
): boolean {
  if (!principal) return false;
  if (isAdmin(principal)) return true;
  return principal.organizationId !== null && row.id === principal.organizationId;
}

/** A member manages only tokens that are theirs; an admin manages any. */
export function canManageToken(
  principal: MaybePrincipal,
  row: { ownerUserId: string | null },
): boolean {
  if (!principal) return false;
  if (isAdmin(principal)) return true;
  return row.ownerUserId !== null && row.ownerUserId === principal.userId;
}

/**
 * A mission a member can see is not thereby theirs: they read the whole of it,
 * but only its author (or an admin) edits it, deletes it or files cards in it.
 * A mission with no recorded author belongs to the admins.
 */
export function canChangeMission(
  principal: MaybePrincipal,
  row: { createdByUserId: string | null },
): boolean {
  if (!principal) return false;
  if (isAdmin(principal)) return true;
  return row.createdByUserId !== null && row.createdByUserId === principal.userId;
}

export const MISSION_NOT_YOURS =
  "Only the mission's author or an admin can change it, delete it or file cards in it.";

const NOTHING = sql`false`;

/**
 * The projects linked to the member, kept to their own organization: a link
 * left behind by a move between organizations opens nothing. The tables are
 * aliased so the subquery never collides with the query it filters (a
 * relational query on `project` or `task` already uses those names).
 */
function linkedProjectIds(principal: Principal): SQL {
  return sql`(select scope_pm.project_id from project_member scope_pm
    join project scope_p on scope_p.id = scope_pm.project_id
    where scope_pm.user_id = ${principal.userId}
      and scope_p.organization_id = ${principal.organizationId})`;
}

/**
 * SQL counterparts of the checks above, for list and aggregate queries that
 * must filter in the database. `undefined` means "no restriction" (admin), so
 * the result can go straight into `and(...)`.
 */
export function taskScope(principal: MaybePrincipal): SQL | undefined {
  if (!principal) return NOTHING;
  if (isAdmin(principal)) return undefined;
  if (!principal.organizationId) return NOTHING;
  return sql`${task.projectId} in ${linkedProjectIds(principal)}`;
}

/**
 * A member's missions: the ones they wrote, and the ones holding a card in a
 * project linked to them, which is what lets the cards they see carry their
 * mission. A mission whose cards are all in other projects stays hidden.
 */
export function missionScope(principal: MaybePrincipal): SQL | undefined {
  if (!principal) return NOTHING;
  if (isAdmin(principal)) return undefined;
  const authored = eq(mission.createdByUserId, principal.userId);
  if (!principal.organizationId) return authored;
  return or(
    authored,
    sql`exists (select 1 from task scope_t
      where scope_t.mission_id = ${mission.id}
        and scope_t.project_id in ${linkedProjectIds(principal)})`,
  );
}

export function projectScope(principal: MaybePrincipal): SQL | undefined {
  if (!principal) return NOTHING;
  if (isAdmin(principal)) return undefined;
  if (!principal.organizationId) return NOTHING;
  return sql`${project.id} in ${linkedProjectIds(principal)}`;
}

export function organizationScope(principal: MaybePrincipal): SQL | undefined {
  if (!principal) return NOTHING;
  if (isAdmin(principal)) return undefined;
  if (!principal.organizationId) return NOTHING;
  return eq(organization.id, principal.organizationId);
}
