"use server";

import {
  canCreateFirstAdmin,
  isValidEmail,
  isValidPassword,
  user,
} from "@agent-board/db";
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
  issueLoginCode,
  loginCodeEmail,
  redeemLoginCode,
} from "../lib/login-code";
import {
  clearCodeLoginBudget,
  clearLoginBudget,
  loginOrigin,
  refundCodeLoginOrigin,
  refundLoginOrigin,
  withinCodeLoginBudget,
  withinCodeRequestBudget,
  withinLoginBudget,
} from "../lib/login-rate-limit";
import {
  ABSENT_USER_HASH,
  hashPassword,
  verifyPassword,
} from "../lib/password";

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

export async function signupAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!isValidEmail(email)) {
    return { error: (await authCopy()).errEmail };
  }
  if (!isValidPassword(password)) {
    return { error: (await authCopy()).errPassword };
  }
  if (password !== confirm) {
    return { error: (await authCopy()).errMismatch };
  }

  const existing = await countUsers();
  if (!canCreateFirstAdmin(existing)) {
    return { error: (await authCopy()).errAdminExists };
  }

  const passwordHash = await hashPassword(password);
  const [created] = await db()
    .insert(user)
    .values({ email, passwordHash, role: "admin" })
    .returning({
      id: user.id,
      sessionVersion: user.sessionVersion,
    });

  if (!created) {
    return { error: (await authCopy()).errCreate };
  }

  await ensureWorkspace();
  await setSession({
    userId: created.id,
    sessionVersion: created.sessionVersion,
  });
  redirect("/onboarding");
}

export async function loginAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");

  if (!isValidEmail(email) || !password) {
    return { error: (await authCopy()).errCredentials };
  }

  // Charged before anything below looks at whether the account exists, and
  // by the email as submitted rather than a user id, so the refusal cannot
  // become a second oracle for account existence on top of the one OCL-99
  // closed. Over budget, the answer is the exact same generic message and
  // skips verifyPassword entirely — that is the point: a drained budget
  // must not pay for scrypt either. The origin is charged here too, before
  // the check and atomically, so parallel guesses cannot all slip past it;
  // it is shared by everyone behind one NAT or edge proxy, so a sign-in
  // that works gives its charge back below.
  const origin = await loginOrigin();
  const charge = await withinLoginBudget(db(), email, origin);
  if (!charge.ok) {
    return { error: (await authCopy()).errCredentials };
  }

  const [found] = await db()
    .select()
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  // Same work on every branch. Short-circuiting on `found` or on `active`
  // skipped scrypt entirely, and answering that much sooner told a caller
  // which addresses have an account, and which of those are switched off,
  // however generic the message is.
  const passwordOk = await verifyPassword(
    password,
    found?.passwordHash ?? ABSENT_USER_HASH,
  );
  if (!found || !found.active || !passwordOk) {
    return { error: (await authCopy()).errCredentials };
  }

  await refundLoginOrigin(db(), origin, charge);
  await clearLoginBudget(db(), email);
  await setSession({
    userId: found.id,
    sessionVersion: found.sessionVersion,
  });
  redirect("/home");
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
 * Signs in with an emailed code. Its own budget (see `withinCodeLoginBudget`),
 * the same generic refusal and the same `setSession` as `loginAction`: the cookie it leaves is the password
 * sign-in's, byte for byte.
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
