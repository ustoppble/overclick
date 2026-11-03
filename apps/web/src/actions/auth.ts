"use server";

import { canCreateFirstAdmin, isValidEmail, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { clearSession, setSession } from "../lib/cookies";
import { db } from "../lib/db";
import { emailConfigured, sendEmail } from "../lib/email";
import { dict } from "../lib/i18n";
import { countUsers, ensureWorkspace } from "../lib/instance";
import { sweepLoginRows } from "../lib/login-housekeeping";
import {
  LOGIN_CODE_PATTERN,
  claimLockNotice,
  issueLoginCode,
  loginCodeEmail,
  lockNoticeEmail,
  redeemLoginCode,
} from "../lib/login-code";
import {
  clearCodeLoginBudget,
  loginOrigin,
  refundCodeLoginOrigin,
  withinCodeLoginBudget,
  withinCodeRequestBudget,
} from "../lib/login-rate-limit";
import {
  issueSignupCode,
  redeemSignupCode,
  setupScope,
  signupCodeEmail,
} from "../lib/signup-code";

export type AuthState = { error: string } | null;

/** `sent` is the one answer every address gets, account or not. */
export type CodeRequestState = { sent: true } | { error: string } | null;

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The words a failed submit answers with, in the workspace language. Read only
 * on the failure path: a sign-in that works never pays for this query. Before
 * setup there is no workspace to ask, and dict falls back to English.
 */
async function authCopy() {
  const ws = await db().query.workspace.findFirst();
  return dict(ws?.language).auth;
}

/**
 * Setup, step one: emails a code to the address that is to become the first
 * admin. Nothing is created yet; the code is what creates the account
 * (`signupAction`). Only while the instance has no account at all.
 */
export async function requestSetupCodeAction(
  _prev: CodeRequestState,
  formData: FormData,
): Promise<CodeRequestState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  if (!isValidEmail(email)) {
    return { error: (await authCopy()).errEmail };
  }
  if (!emailConfigured()) {
    console.error(
      "[login-code] RESEND_API_KEY or EMAIL_FROM is not set; setup by code is unavailable",
    );
    return { error: (await authCopy()).errCodeUnavailable };
  }
  if (!canCreateFirstAdmin(await countUsers())) {
    return { error: (await authCopy()).errAdminExists };
  }

  await sweepLoginRows(db());
  const origin = await loginOrigin();
  // The same buckets and the same global cap as a sign-in code: setup is no
  // side door into the email provider's quota.
  if (await withinCodeRequestBudget(db(), email, origin)) {
    after(async () => {
      try {
        const issued = await issueSignupCode(db(), setupScope(email), email);
        if (issued) await sendEmail(signupCodeEmail("setup", email, issued.code));
      } catch (err) {
        console.error(
          `[login-code] issuing or sending a setup code failed (${err instanceof Error ? err.name : "unknown"})`,
        );
      }
    });
  }
  return { sent: true };
}

/**
 * Setup, step two: the code sent to the address creates the first admin,
 * with no password, and signs them in. A password in the form is ignored.
 */
export async function signupAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");

  if (!isValidEmail(email)) {
    return { error: (await authCopy()).errEmail };
  }
  if (!LOGIN_CODE_PATTERN.test(code)) {
    return { error: (await authCopy()).errCode };
  }
  if (!canCreateFirstAdmin(await countUsers())) {
    return { error: (await authCopy()).errAdminExists };
  }

  const origin = await loginOrigin();
  const charge = await withinCodeLoginBudget(db(), email, origin);
  if (!charge.ok || !(await redeemSignupCode(db(), setupScope(email), email, code))) {
    return { error: (await authCopy()).errCode };
  }
  // Read again: someone else may have finished setup while this code was typed.
  if (!canCreateFirstAdmin(await countUsers())) {
    return { error: (await authCopy()).errAdminExists };
  }

  const [created] = await db()
    .insert(user)
    .values({ email, role: "admin" })
    .returning({
      id: user.id,
      sessionVersion: user.sessionVersion,
    });

  if (!created) {
    return { error: (await authCopy()).errCreate };
  }

  await refundCodeLoginOrigin(db(), origin, charge);
  await clearCodeLoginBudget(db(), email);
  await ensureWorkspace();
  await setSession({
    userId: created.id,
    sessionVersion: created.sessionVersion,
  });
  redirect("/onboarding");
}

/**
 * Asks for a sign-in code by email. The answer is the same `{ sent: true }`
 * for an active account, a switched-off one, an address with no account and
 * an address over its budget: whoever asks learns nothing from it but that,
 * if the address has an account, a code is on its way.
 */
export async function requestLoginCodeAction(
  _prev: CodeRequestState,
  formData: FormData,
): Promise<CodeRequestState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  if (!isValidEmail(email)) {
    return { error: (await authCopy()).errEmail };
  }

  // Decided before the address is looked at, so an instance without email
  // refuses every address with the same words.
  if (!emailConfigured()) {
    console.error(
      "[login-code] RESEND_API_KEY or EMAIL_FROM is not set; sign-in by code is unavailable",
    );
    return { error: (await authCopy()).errCodeUnavailable };
  }

  await sweepLoginRows(db());
  const origin = await loginOrigin();
  if (await withinCodeRequestBudget(db(), email, origin)) {
    // Everything that depends on the address having an account — the insert
    // that finds one, the round trip to Resend — runs once the response is
    // out, so the response is the same, and as fast, for every address. And
    // `after` keeps the process alive until it finishes, which a floating
    // promise does not promise on every host.
    after(async () => {
      try {
        const issued = await issueLoginCode(db(), email);
        if (issued) await sendEmail(loginCodeEmail(email, issued.code));
      } catch (err) {
        // Only the error's kind: its message can quote the address.
        console.error(
          `[login-code] issuing or sending a code failed (${err instanceof Error ? err.name : "unknown"})`,
        );
      }
    });
  }
  return { sent: true };
}

/**
 * Signs in with an emailed code: the only way in there is. There is no
 * password sign-in any more, and nothing here reads one: a form that carries a
 * password and no code is a malformed code like any other. Budgeted per
 * address and per origin (`withinCodeLoginBudget`), one generic refusal for
 * every way it can fail, and the same `setSession` every session comes from.
 */
export async function loginWithCodeAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");

  if (!isValidEmail(email) || !LOGIN_CODE_PATTERN.test(code)) {
    return { error: (await authCopy()).errCode };
  }

  await sweepLoginRows(db());
  const origin = await loginOrigin();
  const charge = await withinCodeLoginBudget(db(), email, origin);
  if (!charge.ok) {
    return { error: (await authCopy()).errCode };
  }

  const redeemed = await redeemLoginCode(db(), email, code);
  const [found] = redeemed
    ? await db().select().from(user).where(eq(user.id, redeemed.userId)).limit(1)
    : [];
  if (!found || !found.active) {
    // A wrong guess may have just locked the account: its owner is told,
    // once per lock, after the response, so the answer stays the same.
    after(async () => {
      try {
        const notice = await claimLockNotice(db(), email);
        if (notice) await sendEmail(lockNoticeEmail(notice.to));
      } catch (err) {
        console.error(
          `[login-code] sending the lock notice failed (${err instanceof Error ? err.name : "unknown"})`,
        );
      }
    });
    return { error: (await authCopy()).errCode };
  }

  await refundCodeLoginOrigin(db(), origin, charge);
  await clearCodeLoginBudget(db(), email);
  await setSession({
    userId: found.id,
    sessionVersion: found.sessionVersion,
  });
  redirect("/home");
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect("/login");
}
