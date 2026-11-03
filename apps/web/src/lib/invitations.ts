import { createHash, randomBytes } from "node:crypto";
import {
  invitation,
  isValidEmail,
  mcpToken,
  organization,
  user,
} from "@agent-board/db";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { McpDatabase } from "../mcp/types";
import { clearLoginCodes } from "./login-code";

/**
 * Invitations and the team (OCL-222): how a second person gets onto a board
 * whose signup closed after the first admin.
 *
 * The admin names an email and one organization; the link carries a random
 * secret whose hash is all the database keeps. Accepting it creates that
 * person as a member of that organization, once: the statement that stamps
 * the invitation used is the same one that checks it was not, so two tabs
 * racing on the same link create one account.
 */

/** How long a link stays good. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Path of the page that accepts a link; the secret follows it. */
export const INVITE_PATH = "/invite/";

export type InvitationRefusal =
  | "invalid"
  | "used"
  | "expired"
  | "revoked"
  | "email_taken";

type Db = McpDatabase;

export function hashInvitationSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function generateInvitationSecret(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export type CreateInvitationResult =
  | { ok: true; id: string; secret: string; path: string; expiresAt: Date }
  | { ok: false; error: string };

export async function createInvitation(
  db: Db,
  input: {
    workspaceId: string;
    email: string;
    organizationId: string;
    createdByUserId: string;
    now?: Date;
  },
): Promise<CreateInvitationResult> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return { ok: false, error: "Use a valid email for the invitation." };
  }

  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(
        eq(organization.id, input.organizationId),
        eq(organization.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!org) return { ok: false, error: "Organization not found." };

  const [taken] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (taken) {
    return { ok: false, error: "That email already has an account here." };
  }

  const secret = generateInvitationSecret();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const [row] = await db
    .insert(invitation)
    .values({
      workspaceId: input.workspaceId,
      email,
      organizationId: org.id,
      tokenHash: hashInvitationSecret(secret),
      expiresAt,
      createdByUserId: input.createdByUserId,
    })
    .returning({ id: invitation.id });
  if (!row) return { ok: false, error: "Could not create the invitation." };

  return {
    ok: true,
    id: row.id,
    secret,
    path: `${INVITE_PATH}${secret}`,
    expiresAt,
  };
}

/** Why a link that matched a row cannot be used, or null when it can. */
function refusalOf(
  row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date,
): InvitationRefusal | null {
  if (row.usedAt) return "used";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}

export type InspectInvitationResult =
  | { ok: true; email: string; organizationName: string }
  | { ok: false; reason: InvitationRefusal };

/** What the invite page shows before anyone types a password. */
export async function inspectInvitation(
  db: Db,
  secret: string,
  now: Date = new Date(),
): Promise<InspectInvitationResult> {
  if (!secret) return { ok: false, reason: "invalid" };
  const [row] = await db
    .select({
      email: invitation.email,
      usedAt: invitation.usedAt,
      revokedAt: invitation.revokedAt,
      expiresAt: invitation.expiresAt,
      organizationName: organization.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.organizationId, organization.id))
    .where(eq(invitation.tokenHash, hashInvitationSecret(secret)))
    .limit(1);
  // A tampered link matches no hash: the same "invalid" as a made-up one.
  if (!row) return { ok: false, reason: "invalid" };
  const refusal = refusalOf(row, now);
  if (refusal) return { ok: false, reason: refusal };
  return { ok: true, email: row.email, organizationName: row.organizationName };
}

export type AcceptInvitationResult =
  | { ok: true; userId: string; sessionVersion: number }
  | { ok: false; reason: InvitationRefusal };

class EmailTaken extends Error {}

/**
 * Postgres' unique violation, as the driver raised it or as drizzle wrapped it
 * (the original then sits in `cause`).
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 3; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The secret carried in an invite link, decoded. A link someone mangled into a
 * malformed escape (a lone `%`) decodes to nothing (OCL-227), which every
 * reader of it answers as "invalid", instead of throwing a URIError.
 */
export function decodeInvitationSecret(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/**
 * Creates the invited member and spends the link, in one transaction. The
 * password is hashed by the caller, so this stays free of scrypt and testable.
 */
export async function acceptInvitation(
  db: Db,
  secret: string,
  passwordHash: string,
  now: Date = new Date(),
): Promise<AcceptInvitationResult> {
  if (!secret) return { ok: false, reason: "invalid" };
  const tokenHash = hashInvitationSecret(secret);

  try {
    const created = await db.transaction(async (tx) => {
      // The check and the stamp are one statement: a second request on the
      // same link finds used_at already set and gets no row back.
      const [spent] = await tx
        .update(invitation)
        .set({ usedAt: now })
        .where(
          and(
            eq(invitation.tokenHash, tokenHash),
            isNull(invitation.usedAt),
            isNull(invitation.revokedAt),
            gt(invitation.expiresAt, now),
          ),
        )
        .returning({
          id: invitation.id,
          email: invitation.email,
          organizationId: invitation.organizationId,
        });
      if (!spent) return null;

      const [taken] = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, spent.email))
        .limit(1);
      if (taken) throw new EmailTaken();

      const [member] = await tx
        .insert(user)
        .values({
          email: spent.email,
          passwordHash,
          role: "member",
          organizationId: spent.organizationId,
        })
        .returning({ id: user.id, sessionVersion: user.sessionVersion });
      if (!member) throw new Error("failed to create the invited user");

      await tx
        .update(invitation)
        .set({ usedByUserId: member.id })
        .where(eq(invitation.id, spent.id));
      return member;
    });
    if (created) {
      return {
        ok: true,
        userId: created.id,
        sessionVersion: created.sessionVersion,
      };
    }
  } catch (error) {
    if (error instanceof EmailTaken) return { ok: false, reason: "email_taken" };
    // Two pending links for the same email accepted at the same moment: both
    // pass the check above before either commits, and the second insert hits
    // the unique email (OCL-227). Same answer as the check gives; the rollback
    // has already put that second link back, unspent.
    if (isUniqueViolation(error)) return { ok: false, reason: "email_taken" };
    throw error;
  }

  // Nothing was spent: say why, from the row as it is now.
  const [row] = await db
    .select({
      usedAt: invitation.usedAt,
      revokedAt: invitation.revokedAt,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(eq(invitation.tokenHash, tokenHash))
    .limit(1);
  if (!row) return { ok: false, reason: "invalid" };
  return { ok: false, reason: refusalOf(row, now) ?? "used" };
}

/** Withdraws a link nobody used yet. */
export async function revokeInvitation(
  db: Db,
  input: { workspaceId: string; invitationId: string; now?: Date },
): Promise<boolean> {
  const [row] = await db
    .update(invitation)
    .set({ revokedAt: input.now ?? new Date() })
    .where(
      and(
        eq(invitation.id, input.invitationId),
        eq(invitation.workspaceId, input.workspaceId),
        isNull(invitation.usedAt),
        isNull(invitation.revokedAt),
      ),
    )
    .returning({ id: invitation.id });
  return Boolean(row);
}

export type SetActiveResult = { ok: true } | { ok: false; error: string };

/**
 * Switches a member off or back on. Off bumps the session version, so the
 * signed cookie they hold stops matching on their next request, and the MCP
 * refuses their tokens while the flag is down. Admins are not switched off
 * here: that would be a way to lock the instance out of itself. Off also
 * deletes the sign-in codes they were sent.
 */
export async function setMemberActive(
  db: Db,
  input: { targetUserId: string; active: boolean; actingUserId: string },
): Promise<SetActiveResult> {
  if (input.targetUserId === input.actingUserId) {
    return { ok: false, error: "You cannot deactivate yourself." };
  }
  const [row] = await db
    .update(user)
    .set(
      input.active
        ? { active: true }
        : { active: false, sessionVersion: sql`${user.sessionVersion} + 1` },
    )
    .where(and(eq(user.id, input.targetUserId), eq(user.role, "member")))
    .returning({ id: user.id });
  if (!row) return { ok: false, error: "Member not found." };
  // A code emailed before the switch-off must not sign them in after it.
  if (!input.active) await clearLoginCodes(db, input.targetUserId);
  return { ok: true };
}

export type TeamMember = {
  id: string;
  email: string;
  role: "admin" | "member";
  organizationName: string | null;
  active: boolean;
  tokens: number;
  createdAt: string;
  /**
   * The first call any of their tokens made: registered until then,
   * installed from then on. Null means the install has not worked yet.
   */
  installedAt: string | null;
};

export type PendingInvitation = {
  id: string;
  email: string;
  organizationName: string;
  expiresAt: string;
  createdAt: string;
};

/** Everyone on the board, admins first. */
export async function loadTeam(db: Db, workspaceId: string): Promise<TeamMember[]> {
  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      role: user.role,
      organizationName: organization.name,
      active: user.active,
      createdAt: user.createdAt,
      tokens: sql<number>`(
        select count(*) from ${mcpToken}
        where ${mcpToken.ownerUserId} = ${user.id}
          and ${mcpToken.workspaceId} = ${workspaceId}
          and ${mcpToken.revoked} = false
      )`,
      installedAt: sql<Date | string | null>`(
        select min(${mcpToken.firstUsedAt}) from ${mcpToken}
        where ${mcpToken.ownerUserId} = ${user.id}
          and ${mcpToken.workspaceId} = ${workspaceId}
      )`,
    })
    .from(user)
    .leftJoin(organization, eq(user.organizationId, organization.id))
    .orderBy(asc(user.role), asc(user.createdAt));
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    organizationName: row.organizationName ?? null,
    active: row.active,
    tokens: Number(row.tokens),
    createdAt: row.createdAt.toISOString(),
    installedAt: row.installedAt ? new Date(row.installedAt).toISOString() : null,
  }));
}

export type InstallNotice = { userId: string; email: string; installedAt: string };

/**
 * Members whose install worked since this admin last dismissed the notice:
 * what the home announces, so the admin learns it without asking.
 */
export async function loadInstallNotices(
  db: Db,
  input: { workspaceId: string; adminUserId: string },
): Promise<InstallNotice[]> {
  const [admin] = await db
    .select({ seenAt: user.teamNoticeSeenAt })
    .from(user)
    .where(eq(user.id, input.adminUserId))
    .limit(1);
  const team = await loadTeam(db, input.workspaceId);
  const seen = admin?.seenAt?.getTime() ?? 0;
  return team
    .filter(
      (person) =>
        person.role === "member" &&
        person.installedAt !== null &&
        new Date(person.installedAt).getTime() > seen,
    )
    .map((person) => ({
      userId: person.id,
      email: person.email,
      installedAt: person.installedAt!,
    }));
}

export async function dismissInstallNotices(
  db: Db,
  adminUserId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(user)
    .set({ teamNoticeSeenAt: now })
    .where(eq(user.id, adminUserId));
}

/** Links still waiting for someone: not used, not withdrawn, not expired. */
export async function loadPendingInvitations(
  db: Db,
  workspaceId: string,
  now: Date = new Date(),
): Promise<PendingInvitation[]> {
  const rows = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      organizationName: organization.name,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.organizationId, organization.id))
    .where(
      and(
        eq(invitation.workspaceId, workspaceId),
        isNull(invitation.usedAt),
        isNull(invitation.revokedAt),
        gt(invitation.expiresAt, now),
      ),
    )
    .orderBy(desc(invitation.createdAt));
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    organizationName: row.organizationName,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }));
}
