import { createHmac, timingSafeEqual } from "node:crypto";
import { signupCode } from "@agent-board/db";
import { and, eq, gt, isNull, lt, not, sql } from "drizzle-orm";
import type { McpDatabase } from "../mcp/types";
import {
  LOGIN_CODE_PATTERN,
  LOGIN_CODE_REISSUE_AFTER_MS,
  LOGIN_CODE_TTL_MS,
  MAX_LOGIN_CODE_ATTEMPTS,
  generateLoginCode,
} from "./login-code";
import { chargeFailureRow, lockStartedAt } from "./login-rate-limit";
import { deriveKey } from "./session";

/**
 * The code that proves an address before there is an account for it: the
 * first admin's at setup and an invited member's at the invite link. It plays
 * by the sign-in code's rules (`login-code.ts`) — six digits, ten minutes,
 * five tries, once, a young live code left alone — but it is bound to what it
 * was sent for, a scope, instead of to an account.
 */
export const SIGNUP_CODE_TTL_MS = LOGIN_CODE_TTL_MS;

/** The scope of the code that creates the first admin at `email`. */
export function setupScope(email: string): string {
  return `setup:${email}`;
}

/** The scope of the code that accepts the invitation `invitationId`. */
export function inviteScope(invitationId: string): string {
  return `invite:${invitationId}`;
}

/** Wrong guesses on a scope count across its codes, like an account's (see `MAX_CODE_USER_FAILURES`). */
function failureRow(scope: string): string {
  return `signupcode-scope:${scope}`;
}

/** Keyed like the sign-in code, with a prefix of its own so neither hash can stand for the other. */
export function hashSignupCode(scope: string, email: string, code: string): string {
  return createHmac("sha256", deriveKey("login-code"))
    .update(`ovk-signup-code:${scope}:${email}:${code}`, "utf8")
    .digest("hex");
}

const ABSENT_CODE_HASH = "0".repeat(64);

/**
 * Issues a code for `scope`, sent to `email`, and returns it in clear — on its
 * way into the email, the only time it exists in clear. Null, with nothing
 * new issued, when the scope has a live code under a minute old.
 */
export async function issueSignupCode(
  db: McpDatabase,
  scope: string,
  email: string,
  now: Date = new Date(),
): Promise<{ code: string } | null> {
  const code = generateLoginCode();
  const youngestLive = new Date(now.getTime() - LOGIN_CODE_REISSUE_AFTER_MS);

  return db.transaction(async (tx) => {
    await tx.delete(signupCode).where(
      and(
        eq(signupCode.scope, scope),
        not(
          and(
            isNull(signupCode.consumedAt),
            gt(signupCode.expiresAt, now),
            lt(signupCode.attempts, MAX_LOGIN_CODE_ATTEMPTS),
            gt(signupCode.createdAt, youngestLive),
          )!,
        ),
      ),
    );
    const rows = await tx
      .insert(signupCode)
      .values({
        scope,
        email,
        codeHash: hashSignupCode(scope, email, code),
        attempts: 0,
        expiresAt: new Date(now.getTime() + SIGNUP_CODE_TTL_MS),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: signupCode.id });
    return rows.length > 0 ? { code } : null;
  });
}

/**
 * Spends one attempt on the live code for `scope` and, if `code` sent to
 * `email` is it, consumes it. The attempt is reserved in the statement that
 * checks the cap, before comparing, and consuming is conditional on the code
 * still being unused, so of two right answers at once exactly one wins. Ten
 * wrong guesses across codes shut the scope for an hour, like an account.
 */
export async function redeemSignupCode(
  db: McpDatabase,
  scope: string,
  email: string,
  code: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!LOGIN_CODE_PATTERN.test(code)) return false;
  const submitted = Buffer.from(hashSignupCode(scope, email, code), "hex");
  const locked = (await lockStartedAt(db, failureRow(scope), now)) !== null;

  const live = locked
    ? []
    : await db
        .update(signupCode)
        .set({ attempts: sql`${signupCode.attempts} + 1` })
        .where(
          and(
            eq(signupCode.scope, scope),
            isNull(signupCode.consumedAt),
            gt(signupCode.expiresAt, now),
            lt(signupCode.attempts, MAX_LOGIN_CODE_ATTEMPTS),
          ),
        )
        .returning({ id: signupCode.id, codeHash: signupCode.codeHash });

  let matchId: string | null = null;
  for (const row of live.length > 0 ? live : [{ id: null, codeHash: ABSENT_CODE_HASH }]) {
    const stored = Buffer.from(row.codeHash, "hex");
    if (stored.length === submitted.length && timingSafeEqual(stored, submitted)) {
      matchId = row.id;
    }
  }
  if (!matchId) {
    // Only a guess that spent an attempt on a live code counts.
    if (live.length > 0) await chargeFailureRow(db, failureRow(scope), now);
    return false;
  }

  const [consumed] = await db
    .update(signupCode)
    .set({ consumedAt: now })
    .where(and(eq(signupCode.id, matchId), isNull(signupCode.consumedAt)))
    .returning({ id: signupCode.id });
  return Boolean(consumed);
}

/** The email that carries a signup code. Portuguese, short, the code kept out of the subject. */
export function signupCodeEmail(purpose: "setup" | "invite", to: string, code: string) {
  const what =
    purpose === "setup"
      ? "criar a conta admin deste overclick"
      : "aceitar o convite para o overclick";
  return {
    to,
    subject:
      purpose === "setup"
        ? "Seu código para criar a conta no overclick"
        : "Seu código para aceitar o convite do overclick",
    text: [
      `Seu código para ${what} é ${code}.`,
      "",
      "Ele vale por 10 minutos e só pode ser usado uma vez.",
      "Se você não pediu este código, ignore este e-mail.",
    ].join("\n"),
  };
}
