import { loginCodeRequest, loginFailure } from "@agent-board/db";
import { eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import {
  budgetExhausted,
  chargeBudget,
  clearBudget,
  refundBudget,
  spendBudget,
  spendBudgetStatement,
} from "./attempt-budget";
import type { McpDatabase } from "../mcp/types";
import { clientOrigin } from "./client-origin";

/**
 * Failed sign-ins one identifier may spend inside a window before the
 * endpoint stops checking codes for it at all.
 *
 * The number was picked for the password sign-in this replaced (OCL-100):
 * enough to survive a person mistyping a few times, without giving a guesser
 * more than a token number of checks per identifier. A code also dies after
 * five wrong guesses of its own, and the account has a count that outlives
 * codes (`MAX_CODE_USER_FAILURES`). It is a product call, not a security
 * invariant.
 */
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_LOGIN_FAILURES = 8;

/**
 * Which buckets an attempt is charged to.
 *
 * The decision to refuse must never depend on whether the account exists —
 * that is exactly the oracle OCL-99 closed — so the primary bucket is the
 * email as submitted, existing or not. A second bucket by origin is layered
 * on top, same as `pairingFailureScope` in `pairing.ts`: undeclared
 * (`OVERCLICK_TRUSTED_PROXY` unset) everyone shares one shared bucket, which
 * still refuses a burst without being able to single a caller out.
 */
function loginFailureScope(kind: "email" | "origin", value: string): string {
  return `logincode-${kind}:${value}`;
}

/**
 * The caller's origin for the sign-in budgets — see `clientOrigin`, which the
 * pairing endpoint reads too. Server Actions do not receive a `Request`, so
 * this reads `next/headers` instead; guarded so a caller outside a request
 * scope (a unit test invoking the action directly) simply sees no origin
 * rather than throwing — the same behaviour as an undeclared proxy.
 */
export async function loginOrigin(): Promise<string | null> {
  if (process.env.OVERCLICK_TRUSTED_PROXY !== "1") return null;
  try {
    return clientOrigin(await headers());
  } catch {
    return null;
  }
}

/**
 * What an attempt was charged: whether it may go on to be checked, and the
 * window of the origin's bucket the charge landed in, which is what gives it
 * back (`refundCodeLoginOrigin`) to that window and no other. `originWindow` is
 * null when there is no origin to charge, or when the attempt was turned away
 * and nothing is left to give back.
 */
export type LoginCharge = { ok: boolean; originWindow: Date | null };

/**
 * Lets an attempt at signing in with an emailed code go on to be checked, or
 * not. Both buckets are charged now, before anything is checked, and the
 * email's as submitted. Neither looks at whether the account exists, so which
 * one refuses says nothing about it. The origin's charge is given back by
 * `refundCodeLoginOrigin` if the attempt turns out to be a sign-in that works.
 *
 * The buckets keep the `logincode-` names they had when a password sign-in
 * sat beside this one with buckets of its own (`login-`, unused since).
 */
export async function withinCodeLoginBudget(
  db: McpDatabase,
  email: string,
  origin: string | null,
): Promise<LoginCharge> {
  // The origin first, and a refusal stops here: an origin that has used its
  // allowance gets no new per-address row for whatever it makes up next.
  // Charged before the guess is checked, in one statement: reading the count
  // and charging it after the check let a burst of parallel guesses, one
  // address each, all read an untouched origin and pass together. A charge
  // the origin has no room for is not taken at all, so a burst of sign-ins
  // that work and are turned away only for being too many at once leaves
  // nothing behind to lock the origin out afterwards. The charge is given
  // back on success (`refundCodeLoginOrigin`), because behind a NAT or an edge
  // proxy the origin is shared by everyone, and sign-ins that work must not
  // lock out the people it serves.
  let originWindow: Date | null = null;
  if (origin) {
    const charge = await chargeBudget(
      db,
      loginFailure,
      loginFailureScope("origin", origin),
      MAX_LOGIN_FAILURES,
      LOGIN_ATTEMPT_WINDOW_MS,
    );
    if (!charge.ok) return { ok: false, originWindow: null };
    originWindow = charge.windowStartedAt;
  }
  const emailOk = await spendBudget(
    db,
    loginFailure,
    loginFailureScope("email", email),
    MAX_LOGIN_FAILURES,
    LOGIN_ATTEMPT_WINDOW_MS,
  );
  // Turned away before any guess was checked: nothing to count against the
  // origin, so a stranger hammering one address cannot use up the allowance
  // of the people sharing its origin.
  if (!emailOk) {
    await refundOriginCharge(db, origin, originWindow);
    return { ok: false, originWindow: null };
  }
  return { ok: true, originWindow };
}

/**
 * Gives back the origin's charge for a code sign-in that worked. The charge
 * stays for every way an attempt can fail — no such account, switched off,
 * wrong code — so what is kept says nothing about the account.
 */
export async function refundCodeLoginOrigin(
  db: McpDatabase,
  origin: string | null,
  charge: LoginCharge,
): Promise<void> {
  await refundOriginCharge(db, origin, charge.originWindow);
}

async function refundOriginCharge(
  db: McpDatabase,
  origin: string | null,
  originWindow: Date | null,
): Promise<void> {
  if (!origin || !originWindow) return;
  await refundBudget(
    db,
    loginFailure,
    loginFailureScope("origin", origin),
    originWindow,
  );
}

/**
 * A successful sign-in clears the email's budget, nobody there was guessing.
 * It never clears the origin's: that bucket is shared by everyone behind the
 * address, so anyone with an account of their own could otherwise wipe it
 * between rounds of guessing at somebody else's. A success gives back only
 * its own charge (`refundCodeLoginOrigin`), never what other attempts spent.
 */
export async function clearCodeLoginBudget(
  db: McpDatabase,
  email: string,
): Promise<void> {
  await clearBudget(db, loginFailure, loginFailureScope("email", email));
}

/**
 * Sign-in codes one address may ask for: one a minute, five an hour. Every
 * ask costs an email the owner of the address did not necessarily request,
 * so the cap is about their inbox as much as about guessing. Like the login
 * budget, it is charged to the email as submitted, before anything looks at
 * whether the account exists.
 */
export const CODE_REQUEST_MINUTE_MS = 60 * 1000;
export const CODE_REQUESTS_PER_MINUTE = 1;
export const CODE_REQUEST_HOUR_MS = 60 * 60 * 1000;
export const CODE_REQUESTS_PER_HOUR = 5;
/**
 * Asks one origin may make in an hour across every address — wider than one
 * address's five, since a team behind one NAT signs in from one origin.
 * Only counted where `loginOrigin` can tell an origin at all.
 */
export const CODE_REQUESTS_PER_ORIGIN_HOUR = 20;

/**
 * Emails of sign-in codes the whole instance sends in an hour, whoever asks.
 * The per-address and per-origin caps do not bound the total: without a
 * trusted proxy there is no origin, and with one a botnet has plenty. This is
 * the kill switch that keeps the email provider's quota (and the domain's
 * reputation) from being spent by strangers. Past it nobody gets an email and
 * the answer stays the neutral one. Set `LOGIN_CODE_MAX_SENDS_PER_HOUR` to
 * change it.
 */
export const DEFAULT_LOGIN_CODE_MAX_SENDS_PER_HOUR = 60;

export function loginCodeSendCap(): number {
  const raw = process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR;
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_LOGIN_CODE_MAX_SENDS_PER_HOUR;
  const cap = Number(raw);
  return cap > 0 ? cap : DEFAULT_LOGIN_CODE_MAX_SENDS_PER_HOUR;
}

function codeRequestScope(
  kind: "minute-email" | "hour-email" | "hour-origin" | "hour-global",
  value: string,
): string {
  return `code-${kind}:${value}`;
}

/**
 * Charges one code request and says whether a code may be issued. The global
 * cap is only read first: when it is spent nothing else is charged, so asks
 * turned away for it cost their owners none of the minute's or hour's
 * allowance and the address works again the moment the window opens. Then
 * the buckets are charged in order and a refusal stops the chain: an ask the
 * minute bucket turned away must not also eat the hour's allowance, or a
 * stranger hammering an address for a second would leave its owner without
 * codes for the whole hour. Which bucket refused cannot tell a caller
 * whether the address has an account — none of them looks at that.
 */
export async function withinCodeRequestBudget(
  db: McpDatabase,
  email: string,
  origin: string | null,
): Promise<boolean> {
  const cap = loginCodeSendCap();
  const globalScope = codeRequestScope("hour-global", "all");
  if (await budgetExhausted(db, loginCodeRequest, globalScope, cap, CODE_REQUEST_HOUR_MS)) {
    return false;
  }

  const originOk = origin
    ? await spendBudget(
        db,
        loginCodeRequest,
        codeRequestScope("hour-origin", origin),
        CODE_REQUESTS_PER_ORIGIN_HOUR,
        CODE_REQUEST_HOUR_MS,
      )
    : true;
  if (!originOk) return false;

  const minuteOk = await spendBudget(
    db,
    loginCodeRequest,
    codeRequestScope("minute-email", email),
    CODE_REQUESTS_PER_MINUTE,
    CODE_REQUEST_MINUTE_MS,
  );
  if (!minuteOk) return false;

  const hourOk = await spendBudget(
    db,
    loginCodeRequest,
    codeRequestScope("hour-email", email),
    CODE_REQUESTS_PER_HOUR,
    CODE_REQUEST_HOUR_MS,
  );
  if (!hourOk) return false;

  // Charged for every ask that got this far, account or not, so the cap is
  // no more an oracle than the buckets above. The read above is not atomic
  // with this charge, so a burst may overshoot by a few; the count here is
  // what keeps it from going further.
  const [global] = await spendBudgetStatement(
    db,
    loginCodeRequest,
    globalScope,
    new Date(),
    CODE_REQUEST_HOUR_MS,
  );
  const count = global?.count ?? 1;
  if (count > cap) return false;
  // One line per window, with no address in it: enough to alert on.
  if (count === cap) {
    console.error(
      `[login-code] hourly send cap reached (${cap}); no sign-in codes go out until the window passes`,
    );
  }
  return true;
}

/**
 * Wrong sign-in codes one account may collect in a day, across every code it
 * is sent. A code only survives 5 guesses, but asking for a new one is cheap,
 * so without a count that outlives the code a guesser's allowance is 5 per
 * request, every request — about 25 an hour for any address they know. This
 * bucket belongs to the account (by id, not by the email as typed) and is not
 * reset when a new code goes out: at 10 wrong guesses in 24 hours code
 * sign-in for that account is shut for an hour from the tenth.
 *
 * An hour, not a day, because there is no password to fall back on any more:
 * whoever knows the admin's address could otherwise keep them out for good.
 * The hour is fixed: it runs from the tenth wrong guess and nothing stretches
 * it. Guesses made while it is shut are not counted (`redeemLoginCode` books
 * them on a sink, and `chargeFailureRow` ignores one that still lands), and
 * when it is over the account has its ten attempts again, so a stranger who
 * knows the address cannot keep it shut by missing once an hour. A sign-in
 * that works zeroes the count (`clearCodeUserFailures`). The worst a guesser
 * gets is ten guesses per lock, 24 locks a day: 240 guesses a day. The
 * account is emailed once per lock (`claimLockNotice`), and the server
 * owner's emergency link ignores it.
 * The refusal is the same generic one as any wrong code.
 */
export const CODE_USER_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CODE_USER_LOCK_MS = 60 * 60 * 1000;
export const MAX_CODE_USER_FAILURES = 10;

function codeUserScope(userId: string): string {
  return `logincode-user:${userId}`;
}

/**
 * When the lock that holds right now on `rowId` started, or null when there is
 * none. The window restarts at the guess that reaches the cap (see
 * `chargeCodeFailure`), so its start is when the lock began, and it is fixed.
 */
export async function lockStartedAt(
  db: McpDatabase,
  rowId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const [row] = await db
    .select({ count: loginFailure.count, windowStartedAt: loginFailure.windowStartedAt })
    .from(loginFailure)
    .where(eq(loginFailure.id, rowId));
  if (!row || row.count < MAX_CODE_USER_FAILURES) return null;
  return row.windowStartedAt.getTime() >= now.getTime() - CODE_USER_LOCK_MS
    ? row.windowStartedAt
    : null;
}

/** Whether code sign-in is shut for this account right now. */
export async function codeLoginLocked(
  db: McpDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await lockStartedAt(db, codeUserScope(userId), now)) !== null;
}

/** The start of the lock holding on this account right now, or null. */
export async function codeLoginLockStart(
  db: McpDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  return lockStartedAt(db, codeUserScope(userId), now);
}

/**
 * Counts one wrong guess against the account. The window restarts at the
 * guess that reaches the cap, which starts a lock an hour long. A guess that
 * arrives while the lock holds changes nothing; the first one after it is
 * over starts a new round of ten.
 */
export async function chargeCodeFailure(
  db: McpDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await chargeFailureRow(db, codeUserScope(userId), now);
}

/** `chargeCodeFailure` for any row id: signup codes keep a count of their own. */
export async function chargeFailureRow(
  db: McpDatabase,
  rowId: string,
  now: Date = new Date(),
): Promise<void> {
  const floor = new Date(now.getTime() - CODE_USER_FAILURE_WINDOW_MS);
  const lockFloor = new Date(now.getTime() - CODE_USER_LOCK_MS);
  const floorParam = sql`${floor.toISOString()}::timestamptz`;
  const lockFloorParam = sql`${lockFloor.toISOString()}::timestamptz`;
  const nowParam = sql`${now.toISOString()}::timestamptz`;
  // At or past the cap the row is a lock, and its window start is when the
  // lock began (see `lockStartedAt`): inside the hour a charge is a no-op, and
  // once the hour is over the next one is the first of a new round.
  const locked = sql`${loginFailure.count} >= ${MAX_CODE_USER_FAILURES}`;
  const lockHolds = sql`${locked} and ${loginFailure.windowStartedAt} >= ${lockFloorParam}`;
  await db
    .insert(loginFailure)
    .values({ id: rowId, count: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: loginFailure.id,
      set: {
        count: sql`case when ${lockHolds} then ${loginFailure.count}
          when ${locked} or ${loginFailure.windowStartedAt} < ${floorParam}
          then 1 else ${loginFailure.count} + 1 end`,
        windowStartedAt: sql`case when ${lockHolds} then ${loginFailure.windowStartedAt}
          when ${locked} or ${loginFailure.windowStartedAt} < ${floorParam}
          then ${nowParam}
          when ${loginFailure.count} + 1 >= ${MAX_CODE_USER_FAILURES}
          then ${nowParam} else ${loginFailure.windowStartedAt} end`,
      },
    });
}

/**
 * Zeroes the account's wrong-guess count. A sign-in that works proves whoever
 * made it is the owner, so the mistakes before it should not add up with
 * those after. It cannot be called to lift a lock from outside: a locked
 * account cannot sign in by code, so only the emergency link gets this far.
 */
export async function clearCodeUserFailures(db: McpDatabase, userId: string): Promise<void> {
  await clearBudget(db, loginFailure, codeUserScope(userId));
}

/**
 * Claims the one notice a lock gets: true the first time it is asked for the
 * lock that started at `lockStart`, false every time after. The row is keyed
 * by the lock itself, so a new lock gets a notice of its own and two failed
 * sign-ins finishing at once cannot both send one.
 */
export async function claimLockNoticeRow(
  db: McpDatabase,
  userId: string,
  lockStart: Date,
): Promise<boolean> {
  const charge = await chargeBudget(
    db,
    loginFailure,
    `logincode-locknotice:${userId}:${lockStart.getTime()}`,
    1,
    CODE_USER_FAILURE_WINDOW_MS,
  );
  return charge.ok;
}
