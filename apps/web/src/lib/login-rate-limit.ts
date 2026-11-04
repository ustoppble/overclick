import { loginCodeRequest, loginFailure } from "@agent-board/db";
import { eq, inArray, sql } from "drizzle-orm";
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

/** Thrown inside the request transaction to undo every charge it took. */
class RequestRefused extends Error {}

/**
 * Charges one code request to the address's and the origin's buckets and says
 * whether the ask may go on to issue a code. Two rules decide the order and
 * the bookkeeping:
 *
 * - The instance-wide cap is only read here, first: when it is spent nothing
 *   else is charged, so asks turned away for it cost their owners none of the
 *   minute's or hour's allowance. It is *spent* when an email is really about
 *   to go out (`spendGlobalSend`, from the callback that runs after the
 *   response), never by an ask for an address with no account, so a stranger
 *   typing made-up addresses cannot use up the cap and shut everyone out.
 * - The charges are one transaction. A refusal by any bucket — the minute's,
 *   the hour's, or the origin's own — undoes the ones taken before it, so an
 *   ask that is turned away costs nothing anywhere. Without that, twenty asks
 *   at one address (refused after the first by the minute bucket) used up the
 *   origin's twenty and locked out every other address behind the same proxy.
 *
 * Which bucket refused cannot tell a caller whether the address has an
 * account — none of them looks at that.
 *
 * Where a challenge would go: a CAPTCHA/Turnstile token, once the owner opens
 * the account and key it needs, is verified by the action *before* this is
 * called (`requestLoginCodeAction`, `requestSetupCodeAction`,
 * `requestInviteCodeAction`), so a request that fails it costs no bucket and
 * no email. Nothing here changes for it.
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

  try {
    await db.transaction(async (tx) => {
      const charges = tx as McpDatabase;
      if (
        origin &&
        !(await spendBudget(
          charges,
          loginCodeRequest,
          codeRequestScope("hour-origin", origin),
          CODE_REQUESTS_PER_ORIGIN_HOUR,
          CODE_REQUEST_HOUR_MS,
        ))
      ) {
        throw new RequestRefused();
      }
      if (
        !(await spendBudget(
          charges,
          loginCodeRequest,
          codeRequestScope("minute-email", email),
          CODE_REQUESTS_PER_MINUTE,
          CODE_REQUEST_MINUTE_MS,
        ))
      ) {
        throw new RequestRefused();
      }
      if (
        !(await spendBudget(
          charges,
          loginCodeRequest,
          codeRequestScope("hour-email", email),
          CODE_REQUESTS_PER_HOUR,
          CODE_REQUEST_HOUR_MS,
        ))
      ) {
        throw new RequestRefused();
      }
    });
  } catch (error) {
    if (error instanceof RequestRefused) return false;
    throw error;
  }
  return true;
}

/**
 * Charges one email to the instance-wide hourly cap and says whether it fits.
 * Called only when an email is really about to leave — a code issued to an
 * account (or to the address setup or an invitation is for), and the warning a
 * lock sends (`claimLockNotice`) — never for an ask that found nothing to
 * send. The read in `withinCodeRequestBudget` is not atomic with this charge,
 * so a burst may overshoot by a few; the count here is what keeps it from
 * going further, and an email that does not fit is not sent.
 */
export async function spendGlobalSend(db: McpDatabase): Promise<boolean> {
  const cap = loginCodeSendCap();
  const [global] = await spendBudgetStatement(
    db,
    loginCodeRequest,
    codeRequestScope("hour-global", "all"),
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
 * sign-in for that account is shut from the tenth.
 *
 * The first lock lasts an hour, not a day, because there is no password to
 * fall back on any more: whoever knows the admin's address could otherwise
 * keep them out for good. Each lock is fixed: it runs from the tenth wrong
 * guess and nothing stretches it. Guesses made while it is shut are not
 * counted (`redeemLoginCode` books them on a sink, and `chargeFailureRow`
 * ignores one that still lands), and when it is over the account has its ten
 * attempts again. Every new lock that starts within a day of the last one
 * ending lasts twice as long — 1, 2, 4, 8, 16 hours, then 24 for as long as
 * it goes on — so a stranger cannot keep guessing at ten an hour. A sign-in
 * that works zeroes both counts (`clearCodeUserFailures`), and a day with no
 * new lock brings the next one back to an hour.
 *
 * The worst a guesser gets is ten guesses per lock: 50 in the first day of a
 * series (locks of 1, 2, 4 and 8 hours, then the tenth guess of the fifth),
 * and 779 in 30 days, ~26 a day (a few locks, then a day of waiting for the
 * series to reset, again and again), ~0.08% of hitting a code. The account is emailed
 * once per lock (`claimLockNotice`), and the server owner's emergency link
 * ignores it. The refusal is the same generic one as any wrong code.
 */
export const CODE_USER_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CODE_USER_LOCK_MS = 60 * 60 * 1000;
export const CODE_USER_MAX_LOCK_MS = 24 * 60 * 60 * 1000;
/** How long after a lock ends a new one still counts as the next in its series. */
export const CODE_USER_LOCK_SERIES_MS = 24 * 60 * 60 * 1000;
export const MAX_CODE_USER_FAILURES = 10;

/** How long the `level`th lock of a series lasts: 1 h, doubled each time, at most 24 h. */
export function codeUserLockMs(level: number): number {
  return Math.min(CODE_USER_LOCK_MS * 2 ** (level - 1), CODE_USER_MAX_LOCK_MS);
}

/** The level from which every lock lasts `CODE_USER_MAX_LOCK_MS`; the count stops there. */
const MAX_LOCK_LEVEL = Math.ceil(Math.log2(CODE_USER_MAX_LOCK_MS / CODE_USER_LOCK_MS)) + 1;

function codeUserScope(userId: string): string {
  return `logincode-user:${userId}`;
}

/**
 * The account's last lock, kept in `login_failure` beside the wrong-guess
 * count so no new column is needed: `count` is how many locks the series has
 * had, and `window_started_at` is when the last one ends. Keyed by its end,
 * the housekeeping sweep drops the row a day after that lock is over — which
 * is exactly when the series no longer counts.
 */
function codeUserLockScope(userId: string): string {
  return `logincode-userlock:${userId}`;
}

type BudgetRow = { count: number; windowStartedAt: Date };

/**
 * The level of the lock that started at `start`, from the last lock written
 * down. Worked out the same way by whoever reads it, so a lock is the same
 * length for the guess that started it and for every check after, even before
 * `chargeCodeFailure` has written it down: the one on record if it is that
 * lock, the next one up if it came within a day of the last ending, and the
 * first otherwise.
 */
function lockLevel(start: Date, last: BudgetRow | undefined): number {
  if (!last) return 1;
  const lastEnd = last.windowStartedAt.getTime();
  if (lastEnd - codeUserLockMs(last.count) === start.getTime()) return last.count;
  if (start.getTime() - lastEnd > CODE_USER_LOCK_SERIES_MS) return 1;
  return Math.min(last.count + 1, MAX_LOCK_LEVEL);
}

/** Both rows of the account's code sign-in count, in one read. */
async function codeUserRows(
  db: McpDatabase,
  userId: string,
): Promise<{ failures: BudgetRow | undefined; lastLock: BudgetRow | undefined }> {
  const rows = await db
    .select({
      id: loginFailure.id,
      count: loginFailure.count,
      windowStartedAt: loginFailure.windowStartedAt,
    })
    .from(loginFailure)
    .where(inArray(loginFailure.id, [codeUserScope(userId), codeUserLockScope(userId)]));
  return {
    failures: rows.find((row) => row.id === codeUserScope(userId)),
    lastLock: rows.find((row) => row.id === codeUserLockScope(userId)),
  };
}

/** How long the lock recorded on `failures` lasts, if it is one; the first lock's length otherwise. */
function failuresLockMs(failures: BudgetRow | undefined, lastLock: BudgetRow | undefined): number {
  if (!failures || failures.count < MAX_CODE_USER_FAILURES) return CODE_USER_LOCK_MS;
  return codeUserLockMs(lockLevel(failures.windowStartedAt, lastLock));
}

/**
 * When the lock that holds right now on `rowId` started, or null when there is
 * none. The window restarts at the guess that reaches the cap (see
 * `chargeFailureRow`), so its start is when the lock began, and it is fixed.
 * `lockMs` is how long it lasts: an hour for signup codes, which keep a count
 * of their own; an account's grows (`codeLoginLock`).
 */
export async function lockStartedAt(
  db: McpDatabase,
  rowId: string,
  now: Date = new Date(),
  lockMs: number = CODE_USER_LOCK_MS,
): Promise<Date | null> {
  const [row] = await db
    .select({ count: loginFailure.count, windowStartedAt: loginFailure.windowStartedAt })
    .from(loginFailure)
    .where(eq(loginFailure.id, rowId));
  if (!row || row.count < MAX_CODE_USER_FAILURES) return null;
  return row.windowStartedAt.getTime() >= now.getTime() - lockMs ? row.windowStartedAt : null;
}

/** The lock holding on this account right now — when it started and how long it lasts — or null. */
export async function codeLoginLock(
  db: McpDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<{ start: Date; ms: number } | null> {
  const { failures, lastLock } = await codeUserRows(db, userId);
  if (!failures || failures.count < MAX_CODE_USER_FAILURES) return null;
  const ms = failuresLockMs(failures, lastLock);
  return failures.windowStartedAt.getTime() >= now.getTime() - ms
    ? { start: failures.windowStartedAt, ms }
    : null;
}

/** Whether code sign-in is shut for this account right now. */
export async function codeLoginLocked(
  db: McpDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await codeLoginLock(db, userId, now)) !== null;
}

/**
 * Counts one wrong guess against the account. The window restarts at the
 * guess that reaches the cap, which starts a lock (see `codeUserLockMs` for
 * how long). A guess that arrives while the lock holds changes nothing; the
 * first one after it is over starts a new round of ten. The lock is written
 * down as the series' latest in the same three statements every miss runs —
 * read, charge, record — so a guess that starts one takes no longer than any
 * other.
 */
export async function chargeCodeFailure(
  db: McpDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const { failures, lastLock } = await codeUserRows(db, userId);
  const charged = await chargeFailureRow(
    db,
    codeUserScope(userId),
    now,
    failuresLockMs(failures, lastLock),
  );
  const lockStart = charged.count >= MAX_CODE_USER_FAILURES ? charged.windowStartedAt : null;
  const level = lockLevel(lockStart ?? now, lastLock);
  const lockEnd = new Date((lockStart ?? now).getTime() + codeUserLockMs(level));
  // Always run, written only when a lock holds: the same lock is written down
  // the same way by every charge that lands on it.
  await db
    .insert(loginFailure)
    .select(
      sql`select ${codeUserLockScope(userId)}::text, ${level}::integer,
        ${lockEnd.toISOString()}::timestamptz where ${lockStart !== null}::boolean`,
    )
    .onConflictDoUpdate({
      target: loginFailure.id,
      set: { count: sql`excluded.count`, windowStartedAt: sql`excluded.window_started_at` },
    });
}

/**
 * `chargeCodeFailure` for any row id: signup codes keep a count of their own.
 * `lockMs` is how long the lock on the row lasts, if it holds one.
 */
export async function chargeFailureRow(
  db: McpDatabase,
  rowId: string,
  now: Date = new Date(),
  lockMs: number = CODE_USER_LOCK_MS,
): Promise<BudgetRow> {
  const floor = new Date(now.getTime() - CODE_USER_FAILURE_WINDOW_MS);
  const lockFloor = new Date(now.getTime() - lockMs);
  const floorParam = sql`${floor.toISOString()}::timestamptz`;
  const lockFloorParam = sql`${lockFloor.toISOString()}::timestamptz`;
  const nowParam = sql`${now.toISOString()}::timestamptz`;
  // At or past the cap the row is a lock, and its window start is when the
  // lock began (see `lockStartedAt`): inside it a charge is a no-op, and once
  // it is over the next one is the first of a new round.
  const locked = sql`${loginFailure.count} >= ${MAX_CODE_USER_FAILURES}`;
  const lockHolds = sql`${locked} and ${loginFailure.windowStartedAt} >= ${lockFloorParam}`;
  const [row] = await db
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
    })
    .returning({ count: loginFailure.count, windowStartedAt: loginFailure.windowStartedAt });
  return row!;
}

/**
 * Zeroes the account's wrong-guess count and its series of locks. A sign-in
 * that works proves whoever made it is the owner, so the mistakes before it
 * should not add up with those after, and the next lock is an hour again. It
 * cannot be called to lift a lock from outside: a locked account cannot sign
 * in by code.
 */
export async function clearCodeUserFailures(db: McpDatabase, userId: string): Promise<void> {
  await clearBudget(db, loginFailure, codeUserScope(userId));
  await clearBudget(db, loginFailure, codeUserLockScope(userId));
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
