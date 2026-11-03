"use server";

import { isValidEmail } from "@agent-board/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import type { ActionResult } from "../lib/action-result";
import { getSession, setSession } from "../lib/cookies";
import { db } from "../lib/db";
import { emailConfigured, sendEmail } from "../lib/email";
import { dict } from "../lib/i18n";
import {
  acceptInvitation,
  createInvitation,
  dismissInstallNotices,
  inspectInvitation,
  revokeInvitation,
  setMemberActive,
} from "../lib/invitations";
import { sweepLoginRows } from "../lib/login-housekeeping";
import { LOGIN_CODE_PATTERN } from "../lib/login-code";
import {
  clearCodeLoginBudget,
  loginOrigin,
  refundCodeLoginOrigin,
  withinCodeLoginBudget,
  withinCodeRequestBudget,
} from "../lib/login-rate-limit";
import {
  inviteScope,
  issueSignupCode,
  redeemSignupCode,
  signupCodeEmail,
} from "../lib/signup-code";
import { ADMIN_ONLY, sessionPrincipal } from "../lib/web-scope";

/**
 * Invitations and the team (OCL-222). Everything here but accepting a link is
 * the admin's; a member calling it gets the refusal and nothing changes.
 */
type AdminSession =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; error: string };

async function adminSession(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const principal = await sessionPrincipal(session);
  if (principal?.role !== "admin") return { ok: false, error: ADMIN_ONLY };
  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };
  return { ok: true, userId: session.userId, workspaceId: ws.id };
}

export type CreateInvitationResult =
  | { ok: true; path: string; expiresAt: string }
  | { ok: false; error: string };

/** The link is returned once, here; the database keeps only its hash. */
export async function createInvitationAction(input: {
  email: string;
  organizationId: string;
}): Promise<CreateInvitationResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;

  const created = await createInvitation(db(), {
    workspaceId: admin.workspaceId,
    email: input.email,
    organizationId: input.organizationId,
    createdByUserId: admin.userId,
  });
  if (!created.ok) return created;
  revalidatePath("/settings");
  return { ok: true, path: created.path, expiresAt: created.expiresAt.toISOString() };
}

export async function revokeInvitationAction(invitationId: string): Promise<ActionResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;
  const done = await revokeInvitation(db(), {
    workspaceId: admin.workspaceId,
    invitationId,
  });
  if (!done) return { ok: false, error: "Invitation not found, or already used." };
  revalidatePath("/settings");
  return { ok: true };
}

export async function setMemberActiveAction(
  userId: string,
  active: boolean,
): Promise<ActionResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;
  const result = await setMemberActive(db(), {
    targetUserId: userId,
    active,
    actingUserId: admin.userId,
  });
  if (!result.ok) return result;
  revalidatePath("/settings");
  return { ok: true };
}

/** The admin read the "member finished installing" notice on the home. */
export async function dismissInstallNoticesAction(): Promise<ActionResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;
  await dismissInstallNotices(db(), admin.userId);
  revalidatePath("/home");
  return { ok: true };
}

export type AcceptState = { error: string } | null;

/** `sent` is the one answer every typed address gets, the invited one or not. */
export type InviteCodeState = { sent: true } | { error: string } | null;

/**
 * Public, step one of accepting a link: the person types the address the
 * invitation was made for and a code goes to it. The page does not print that
 * address, and every typed address gets the same answer, so a leaked link
 * alone tells nobody whose inbox the code goes to and gets no code anywhere
 * else. Nothing is created yet.
 */
export async function requestInviteCodeAction(
  _prev: InviteCodeState,
  formData: FormData,
): Promise<InviteCodeState> {
  const secret = String(formData.get("token") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  const ws = await db().query.workspace.findFirst();
  const t = dict(ws?.language).auth;
  if (!isValidEmail(email)) return { error: t.errEmail };
  if (!emailConfigured()) {
    console.error(
      "[login-code] RESEND_API_KEY or EMAIL_FROM is not set; accepting an invitation is unavailable",
    );
    return { error: t.errCodeUnavailable };
  }
  const found = await inspectInvitation(db(), secret);
  if (!found.ok) return { error: t.inviteRefused[found.reason] };

  await sweepLoginRows(db());
  const origin = await loginOrigin();
  // The sign-in code's buckets and global cap, charged to the typed address.
  if (await withinCodeRequestBudget(db(), email, origin)) {
    after(async () => {
      if (email !== found.email) return;
      try {
        const issued = await issueSignupCode(db(), inviteScope(found.id), email);
        if (issued) await sendEmail(signupCodeEmail("invite", email, issued.code));
      } catch (err) {
        console.error(
          `[login-code] issuing or sending an invitation code failed (${err instanceof Error ? err.name : "unknown"})`,
        );
      }
    });
  }
  return { sent: true };
}

/**
 * Public, step two: the code sent to the invited address creates the member,
 * with no password, spends the link and signs them in. The account does not
 * exist until the address is proved.
 */
export async function acceptInvitationAction(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const secret = String(formData.get("token") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");

  const ws = await db().query.workspace.findFirst();
  const t = dict(ws?.language).auth;
  if (!isValidEmail(email) || !LOGIN_CODE_PATTERN.test(code)) return { error: t.errCode };

  const found = await inspectInvitation(db(), secret);
  if (!found.ok) return { error: t.inviteRefused[found.reason] };

  const origin = await loginOrigin();
  const charge = await withinCodeLoginBudget(db(), email, origin);
  if (!charge.ok || !(await redeemSignupCode(db(), inviteScope(found.id), email, code))) {
    return { error: t.errCode };
  }

  const accepted = await acceptInvitation(db(), secret);
  if (!accepted.ok) return { error: t.inviteRefused[accepted.reason] };

  await refundCodeLoginOrigin(db(), origin, charge);
  await clearCodeLoginBudget(db(), email);
  await setSession({
    userId: accepted.userId,
    sessionVersion: accepted.sessionVersion,
  });
  // Signed up, the member goes on to install: the plugin and the pairing that
  // mints their own token (the owner's decision, 2026-09-24).
  redirect("/onboarding");
}
