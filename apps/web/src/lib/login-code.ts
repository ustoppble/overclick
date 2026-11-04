import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { loginCode, user } from "@agent-board/db";
import { and, eq, gt, inArray, isNull, lt, not, sql } from "drizzle-orm";
import type { McpDatabase } from "../mcp/types";
import {
  chargeCodeFailure,
  claimLockNoticeRow,
  codeLoginLock,
  codeLoginLocked,
  countSentEmail,
} from "./login-rate-limit";
import { deriveKey } from "./session";

/**
 * A live code this young is left alone by a new ask: whoever just received it
 * is probably typing it in, and replacing it would let a stranger who knows
 * the address kill it by asking again.
 */
export const LOGIN_CODE_REISSUE_AFTER_MS = 60 * 1000;
/** How long an emailed sign-in code stays good. */
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
/** Verifications one code survives; the fifth wrong one kills it. */
export const MAX_LOGIN_CODE_ATTEMPTS = 5;

export const LOGIN_CODE_PATTERN = /^\d{6}$/;

/** Six digits from the CSPRNG, leading zeros kept. */
export function generateLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * A million codes is nothing to brute-force from a leaked table, so a plain
 * digest would store the code in all but name. Keyed with a subkey of the
 * session secret (HKDF, info "login-code") and bound to the address it was
 * sent to, the hash is worthless without the server's key, and a code cannot
 * be replayed on another account.
 */
export function hashLoginCode(email: string, code: string): string {
  return createHmac("sha256", deriveKey("login-code"))
    .update(`ovk-login-code:${email}:${code}`, "utf8")
    .digest("hex");
}

/** Stands in for the account when there is none to charge or look up. */
const NO_ACCOUNT = "00000000-0000-0000-0000-000000000000";

/** Compared against when there is no live code, so a miss costs a compare too. */
const ABSENT_CODE_HASH = "0".repeat(64);

function accountId(db: McpDatabase, email: string) {
  return db.select({ id: user.id }).from(user).where(eq(user.email, email));
}

/**
 * Issues a code for the active account at `email`, deleting any code it had
 * before, and returns the code in clear — the only time it exists in clear,
 * on its way into the email. Null when there is no active account there, and
 * also when the account has a live code under a minute old: that one stays,
 * and the ask is accepted without a new code.
 */
export async function issueLoginCode(
  db: McpDatabase,
  email: string,
  now: Date = new Date(),
): Promise<{ code: string } | null> {
  const code = generateLoginCode();
  const codeHash = hashLoginCode(email, code);
  const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS);

  return db.transaction(async (tx) => {
    const youngestLive = new Date(now.getTime() - LOGIN_CODE_REISSUE_AFTER_MS);
    await tx.delete(loginCode).where(
      and(
        inArray(loginCode.userId, accountId(tx as McpDatabase, email)),
        not(
          and(
            isNull(loginCode.consumedAt),
            gt(loginCode.expiresAt, now),
            lt(loginCode.attempts, MAX_LOGIN_CODE_ATTEMPTS),
            gt(loginCode.createdAt, youngestLive),
          )!,
        ),
      ),
    );

    const [account] = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.email, email), eq(user.active, true)));
    if (!account) return null;

    // Columns and values go in by name, not by position in a select. Anything
    // still here is the live code the delete above spared, and the one-live-
    // code-per-account index turns the insert into a no-op; so does losing a
    // race with another ask.
    const rows = await tx
      .insert(loginCode)
      .values({
        userId: account.id,
        codeHash,
        attempts: 0,
        expiresAt,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: loginCode.id });
    return rows.length > 0 ? { code } : null;
  });
}

/**
 * Deletes every sign-in code of the account. Anything that changes who may
 * get into it — switching it off, a new password, a bumped session version —
 * has to call this, or a code sent before the change keeps working for up to
 * ten minutes after it, as the one way in the change was meant to close.
 */
export async function clearLoginCodes(db: McpDatabase, userId: string): Promise<void> {
  await db.delete(loginCode).where(eq(loginCode.userId, userId));
}

/**
 * Spends one attempt on the live code for `email` and, if `code` is it,
 * consumes it and returns its account. Null for anything else: no account,
 * no live code, a wrong code, an expired, used or exhausted one.
 *
 * The attempt is reserved in the same statement that checks the cap, before
 * comparing, so concurrent guesses cannot all slip in under it. Activity of
 * the account is the caller's to check, as with the password sign-in.
 */
export async function redeemLoginCode(
  db: McpDatabase,
  email: string,
  code: string,
  now: Date = new Date(),
): Promise<{ userId: string } | null> {
  if (!LOGIN_CODE_PATTERN.test(code)) return null;
  const submitted = Buffer.from(hashLoginCode(email, code), "hex");

  // Every miss runs the same four statements — find the account, read its
  // lock, try to spend an attempt, count a failure — whether the address has
  // an account, the account is locked or there is no live code, so none of
  // those shows as a shorter round trip. A statement with nothing to do is
  // pointed at NO_ACCOUNT and matches no row.
  const [account] = await accountId(db, email);
  const accountKey = account?.id ?? NO_ACCOUNT;
  const locked = await codeLoginLocked(db, accountKey, now);
  const mayGuess = account !== undefined && !locked;

  const live = await db
    .update(loginCode)
    .set({ attempts: sql`${loginCode.attempts} + 1` })
    .where(
      and(
        eq(loginCode.userId, mayGuess ? accountKey : NO_ACCOUNT),
        isNull(loginCode.consumedAt),
        gt(loginCode.expiresAt, now),
        lt(loginCode.attempts, MAX_LOGIN_CODE_ATTEMPTS),
      ),
    )
    .returning({ id: loginCode.id, codeHash: loginCode.codeHash });

  let matchId: string | null = null;
  for (const row of live.length > 0 ? live : [{ id: null, codeHash: ABSENT_CODE_HASH }]) {
    const stored = Buffer.from(row.codeHash, "hex");
    if (stored.length === submitted.length && timingSafeEqual(stored, submitted)) {
      matchId = row.id;
    }
  }
  if (!matchId) {
    // Only a guess that spent an attempt on a live code counts against the
    // account; any other miss is booked on the sink nobody reads.
    await chargeCodeFailure(db, live.length > 0 ? accountKey : NO_ACCOUNT, now);
    return null;
  }

  // Conditional on still being unconsumed: of two requests carrying the
  // right code at once, exactly one gets the account.
  const [consumed] = await db
    .update(loginCode)
    .set({ consumedAt: now })
    .where(and(eq(loginCode.id, matchId), isNull(loginCode.consumedAt)))
    .returning({ userId: loginCode.userId });
  return consumed ? { userId: consumed.userId } : null;
}

/**
 * The address to warn, when the account at `email` is locked out of code
 * sign-in, nobody has been told about this lock yet and the hourly send cap
 * has room for the warning; null otherwise. Run
 * after a failed sign-in, once the response is out, so whether it finds
 * anything never shows in the response.
 */
export async function claimLockNotice(
  db: McpDatabase,
  email: string,
  now: Date = new Date(),
): Promise<{ to: string; lockMs: number } | null> {
  const [account] = await accountId(db, email);
  if (!account) return null;
  const lock = await codeLoginLock(db, account.id, now);
  if (!lock) return null;
  if (!(await claimLockNoticeRow(db, account.id, lock.start))) return null;
  // The warning is an email like any other: it counts in the hourly count of
  // emails really sent, and once that passes the cap this lock goes without
  // one. Only the account's owner can see the difference.
  return (await countSentEmail(db)) ? { to: email, lockMs: lock.ms } : null;
}

/** "1 hora", "2 horas": how long a lock lasts, in whole hours. */
function lockLength(lockMs: number): string {
  const hours = Math.round(lockMs / (60 * 60 * 1000));
  return hours === 1 ? "1 hora" : `${hours} horas`;
}

/** The warning a lock sends: what happened, for how long, and what to do. No code in it. */
export function lockNoticeEmail(to: string, lockMs: number) {
  const length = lockLength(lockMs);
  return {
    to,
    subject: `Seu login no overclick foi travado por ${length}`,
    text: [
      "Alguém errou o código de acesso da sua conta no overclick 10 vezes,",
      `então o login por código desta conta ficou travado por ${length}.`,
      "Se os erros continuarem, cada nova trava dura o dobro, até 24 horas.",
      "",
      "Se foi você, espere o prazo passar e peça um código novo.",
      "Se não foi, alguém conhece o seu e-mail e está tentando entrar: o código",
      "só chega na sua caixa, então ele não entrou. Avise o admin do board.",
    ].join("\n"),
  };
}

/** The email that carries a code. Portuguese, short: the code and how long it lasts. */
export function loginCodeEmail(to: string, code: string) {
  return {
    to,
    subject: "Seu código de acesso ao overclick",
    text: [
      `Seu código para entrar no overclick é ${code}.`,
      "",
      "Ele vale por 10 minutos e só pode ser usado uma vez.",
      "Se você não pediu este código, ignore este e-mail.",
    ].join("\n"),
  };
}
