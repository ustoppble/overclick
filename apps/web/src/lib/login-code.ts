import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { loginCode, user } from "@agent-board/db";
import { and, eq, gt, inArray, isNull, lt, not, sql } from "drizzle-orm";
import type { McpDatabase } from "../mcp/types";
import { secretKey } from "./session";

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
 * digest would store the code in all but name. Keyed with the session
 * secret and bound to the address it was sent to, the hash is worthless
 * without the server's key, and a code cannot be replayed on another account.
 */
export function hashLoginCode(email: string, code: string): string {
  return createHmac("sha256", secretKey())
    .update(`ovk-login-code:${email}:${code}`, "utf8")
    .digest("hex");
}

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
 *
 * Both statements run whether or not the address has an account: they are
 * keyed by the email, not by a user row looked up first, so an address with
 * no account costs the same two round trips as a real one.
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

    // Column order is the table's: id, user_id, code_hash, attempts,
    // expires_at, consumed_at, created_at.
    const rows = await tx
      .insert(loginCode)
      .select(
        sql`select gen_random_uuid(), ${user.id}, ${codeHash}, 0,
          ${expiresAt.toISOString()}::timestamptz, null,
          ${now.toISOString()}::timestamptz
          from ${user} where ${user.email} = ${email} and ${user.active}
          and not exists (select 1 from ${loginCode} where ${loginCode.userId} = ${user.id})`,
      )
      .returning({ id: loginCode.id });
    return rows.length > 0 ? { code } : null;
  });
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

  const live = await db
    .update(loginCode)
    .set({ attempts: sql`${loginCode.attempts} + 1` })
    .where(
      and(
        inArray(loginCode.userId, accountId(db, email)),
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
  if (!matchId) return null;

  // Conditional on still being unconsumed: of two requests carrying the
  // right code at once, exactly one gets the account.
  const [consumed] = await db
    .update(loginCode)
    .set({ consumedAt: now })
    .where(and(eq(loginCode.id, matchId), isNull(loginCode.consumedAt)))
    .returning({ userId: loginCode.userId });
  return consumed ? { userId: consumed.userId } : null;
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
