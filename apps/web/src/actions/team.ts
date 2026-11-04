"use server";

import { isValidEmail } from "@agent-board/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import type { ActionResult } from "../lib/action-result";
import { getSession, setSession } from "../lib/cookies";
import { db } from "../lib/db";
import { emailConfigured, sendEmail } from "../lib/email";
import { asLang, formatMediumDate } from "../lib/format";
import { dict } from "../lib/i18n";
import {
  acceptInvitation,
  createInvitation,
  dismissInstallNotices,
  inspectInvitation,
  resendInvitation,
  revokeInvitation,
  setMemberActive,
  setMemberProjects,
  type CreateInvitationResult as CreatedInvitation,
} from "../lib/invitations";
import { sweepLoginRows } from "../lib/login-housekeeping";
import { LOGIN_CODE_PATTERN } from "../lib/login-code";
import { publicOrigin } from "../lib/public-url";
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
  | { ok: true; userId: string; workspaceId: string; language: string | null }
  | { ok: false; error: string };

async function adminSession(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const principal = await sessionPrincipal(session);
  if (principal?.role !== "admin") return { ok: false, error: ADMIN_ONLY };
  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };
  return { ok: true, userId: session.userId, workspaceId: ws.id, language: ws.language };
}

export type CreateInvitationResult =
  | {
      ok: true;
      path: string;
      expiresAt: string;
      emailed: boolean;
      /** Why nothing was emailed, when `emailed` is false. */
      notSentBecause?: "email" | "public-url" | "failed";
    }
  | { ok: false; error: string };

type EmailOutcome = { emailed: true } | { emailed: false; notSentBecause: "email" | "public-url" | "failed" };

/**
 * Sends the link to the invited address, with the sign-in code's sender.
 * Whether it went out is told back, never thrown: the admin always has the
 * link to copy, the plan B when nothing could be sent.
 *
 * The link's origin is the one the operator configured (OVERCLICK_PUBLIC_URL),
 * never the request's Host or x-forwarded-* headers: those come from whoever
 * sent the request, and an emailed link built from them is a link to wherever
 * they say. With no configured address nothing is emailed.
 */
async function emailInvitation(
  created: Extract<CreatedInvitation, { ok: true }>,
  language: string | null,
): Promise<EmailOutcome> {
  if (!emailConfigured()) return { emailed: false, notSentBecause: "email" };
  const origin = publicOrigin();
  if (!origin) return { emailed: false, notSentBecause: "public-url" };
  const t = dict(language).settings;
  const sent = await sendEmail({
    to: created.email,
    subject: t.teamInviteEmailSubject(created.organizationName),
    text: t.teamInviteEmailText(
      `${origin}${created.path}`,
      created.organizationName,
      formatMediumDate(created.expiresAt.toISOString(), asLang(language)),
    ),
  });
  return sent ? { emailed: true } : { emailed: false, notSentBecause: "failed" };
}

/** The link is returned once, here, and emailed; the database keeps only its hash. */
export async function createInvitationAction(input: {
  email: string;
  organizationId: string;
  projectIds?: string[];
}): Promise<CreateInvitationResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;

  const created = await createInvitation(db(), {
    workspaceId: admin.workspaceId,
    email: input.email,
    organizationId: input.organizationId,
    projectIds: Array.isArray(input.projectIds) ? input.projectIds : [],
    createdByUserId: admin.userId,
  });
  if (!created.ok) return created;
  const outcome = await emailInvitation(created, admin.language);
  revalidatePath("/settings");
  return { ok: true, path: created.path, expiresAt: created.expiresAt.toISOString(), ...outcome };
}

/** A new link for a pending invitation, emailed again; the old one stops working. */
export async function resendInvitationAction(invitationId: string): Promise<CreateInvitationResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;
  const created = await resendInvitation(db(), {
    workspaceId: admin.workspaceId,
    invitationId,
    createdByUserId: admin.userId,
  });
  if (!created.ok) return created;
  const outcome = await emailInvitation(created, admin.language);
  revalidatePath("/settings");
  return { ok: true, path: created.path, expiresAt: created.expiresAt.toISOString(), ...outcome };
}

/** Which projects of their organization a member works on. */
export async function setMemberProjectsAction(
  userId: string,
  projectIds: string[],
): Promise<ActionResult> {
  const admin = await adminSession();
  if (!admin.ok) return admin;
  const result = await setMemberProjects(db(), {
    workspaceId: admin.workspaceId,
    targetUserId: userId,
    projectIds: Array.isArray(projectIds) ? projectIds : [],
    actingUserId: admin.userId,
  });
  if (!result.ok) return result;
  revalidatePath("/settings");
  return { ok: true };
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
  revalidatePath("/board");
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
