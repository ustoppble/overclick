import { loginCodeRequest, loginFailure } from "@agent-board/db";
import { eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import {
  budgetExhausted,
  clearBudget,
  refundBudget,
  spendBudget,
  spendBudgetStatement,
} from "./attempt-budget";
import type { McpDatabase } from "../mcp/types";

/**
 * Failed logins one identifier may spend inside a window before the endpoint
 * stops paying for the scrypt call at all.
 *
 * OCL-99 made every failing login pay for one scrypt verification, real
 * account or not, to close a timing gap that told a caller which addresses
 * exist. That is the right trade, but it turned "no rate limit" from
 * inconvenient into a CPU-exhaustion vector: verifyPassword runs on the
 * libuv threadpool (4 threads by default), so unauthenticated garbage now
 * occupies the same threads real logins need.
 *
 * 8 failures in 15 minutes is picked to survive a genuine mistyped-password
 * afternoon (a human retyping a forgotten password, an old saved credential
 * in a second browser) without giving a guesser more than a token number of
 * scrypt calls per identifier. It is a product call, not a security
 * invariant — see the PR description for the number actually shipped.
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
function loginFailureScope(
  flow: "login" | "logincode",
  kind: "email" | "origin",
  value: string,
): string {
  return `${flow}-${kind}:${value}`;
}

/**
 * The caller's origin, as far as this deployment can honestly tell — see
 * `guessOrigin` in `app/api/pair/route.ts`, which this mirrors. Trusting a
 * forwarded-for header on a directly exposed instance would hand a guesser a
 * fresh budget per request just by varying a string, so it only counts where
 * the deploy declares it sits behind a proxy. Server Actions do not receive
 * a `Request`, so this reads `next/headers` instead; guarded so a caller
 * outside a request scope (a unit test invoking the action directly) simply
 * sees no origin rather than throwing — the same behaviour as an undeclared
 * proxy.
 */
export async function loginOrigin(): Promise<string | null> {
  if (process.env.OVERCLICK_TRUSTED_PROXY !== "1") return null;
  try {
    const store = await headers();
    const forwarded = store.get("x-forwarded-for");
    if (!forwarded) return store.get("x-real-ip");
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    return hops.at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Lets a password attempt proceed to `verifyPassword`, or not. Both buckets
 * are charged now, before anything is verified, and the email's as
 * submitted. Neither looks at whether the account exists, so which one
 * refuses says nothing about it. The origin's charge is given back by
 * `refundLoginOrigin` if the attempt turns out to be a sign-in that works.
 */
export async function withinLoginBudget(
  db: McpDatabase,
  email: string,
  origin: string | null,
): Promise<boolean> {
  return spendLoginBuckets(db, "login", email, origin);
}

/**
 * The same budget for signing in with an emailed code, in buckets of its own.
 * Sharing the password's meant that anyone who knew an address could spend 8
 * malformed codes and lock the owner out of both ways in, so each way in has
 * its own allowance and running out of one leaves the other alone.
 */
export async function withinCodeLoginBudget(
  db: McpDatabase,
  email: string,
  origin: string | null,
): Promise<boolean> {
  return spendLoginBuckets(db, "logincode", email, origin);
}

async function spendLoginBuckets(
  db: McpDatabase,
  flow: "login" | "logincode",
  email: string,
  origin: string | null,
): Promise<boolean> {
  // The origin first, and a refusal stops here: an origin that has used its
  // allowance gets no new per-address row for whatever it makes up next.
  // Charged before the guess is checked, in one statement: reading the count
  // and charging it after the check let a burst of parallel guesses, one
  // address each, all read an untouched origin and pass together. The charge
  // is given back on success (`refundLoginOrigin`), because behind a NAT or
  // an edge proxy the origin is shared by everyone, and sign-ins that work
  // must not lock out the people it serves.
  if (
    origin &&
    !(await spendBudget(
      db,
      loginFailure,
      loginFailureScope(flow, "origin", origin),
      MAX_LOGIN_FAILURES,
      LOGIN_ATTEMPT_WINDOW_MS,
    ))
  ) {
    return false;
  }
  const emailOk = await spendBudget(
    db,
    loginFailure,
    loginFailureScope(flow, "email", email),
    MAX_LOGIN_FAILURES,
    LOGIN_ATTEMPT_WINDOW_MS,
  );
  // Turned away before any guess was checked: nothing to count against the
  // origin, so a stranger hammering one address cannot use up the allowance
  // of the people sharing its origin.
  if (!emailOk) await refundOriginCharge(db, flow, origin);
  return emailOk;
}

/**
 * Gives back the origin's charge for a password sign-in that worked. The
 * charge stays for every way an attempt can fail — no such account, switched
 * off, wrong password — so what is kept says nothing about the account.
 */
export async function refundLoginOrigin(
  db: McpDatabase,
  origin: string | null,
): Promise<void> {
  await refundOriginCharge(db, "login", origin);
}

/** Same as `refundLoginOrigin`, for a code sign-in that worked. */
export async function refundCodeLoginOrigin(
  db: McpDatabase,
  origin: string | null,
): Promise<void> {
  await refundOriginCharge(db, "logincode", origin);
}

async function refundOriginCharge(
  db: McpDatabase,
  flow: "login" | "logincode",
  origin: string | null,
): Promise<void> {
  if (!origin) return;
  await refundBudget(
    db,
    loginFailure,
    loginFailureScope(flow, "origin", origin),
    LOGIN_ATTEMPT_WINDOW_MS,
  );
}

/**
 * A successful login clears the email's budget, nobody there was guessing.
 * It never clears the origin's: that bucket is shared by everyone behind the
 * address, so anyone with an account of their own could otherwise wipe it
 * between rounds of guessing at somebody else's. A success gives back only
 * its own charge (`refundLoginOrigin`), never what other attempts spent.
 */
export async function clearLoginBudget(db: McpDatabase, email: string): Promise<void> {
  await clearBudget(db, loginFailure, loginFailureScope("login", "email", email));
}

/** Same as `clearLoginBudget`, for the sign-in-by-code buckets. */
export async function clearCodeLoginBudget(
  db: McpDatabase,
  email: string,
): Promise<void> {
  await clearBudget(db, loginFailure, loginFailureScope("logincode", "email", email));
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
 * sign-in for that account is shut for 24 hours from the tenth. The password
 * keeps working, and the refusal is the same generic one as any wrong code.
 */
export const CODE_USER_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_CODE_USER_FAILURES = 10;

function codeUserScope(userId: string): string {
  return `logincode-user:${userId}`;
}

/** Whether code sign-in is shut for this account right now. */
export async function codeLoginLocked(
  db: McpDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ count: loginFailure.count, windowStartedAt: loginFailure.windowStartedAt })
    .from(loginFailure)
    .where(eq(loginFailure.id, codeUserScope(userId)));
  if (!row) return false;
  return (
    row.count >= MAX_CODE_USER_FAILURES &&
    row.windowStartedAt.getTime() >= now.getTime() - CODE_USER_FAILURE_WINDOW_MS
  );
}

/**
 * Counts one wrong guess against the account. The window restarts at the
 * guess that reaches the cap, so the lock lasts a full day from then rather
 * than from whenever the first guess of the day happened.
 */
export async function chargeCodeFailure(
  db: McpDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const floor = new Date(now.getTime() - CODE_USER_FAILURE_WINDOW_MS);
  const floorParam = sql`${floor.toISOString()}::timestamptz`;
  const nowParam = sql`${now.toISOString()}::timestamptz`;
  await db
    .insert(loginFailure)
    .values({ id: codeUserScope(userId), count: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: loginFailure.id,
      set: {
        count: sql`case when ${loginFailure.windowStartedAt} < ${floorParam}
          then 1 else ${loginFailure.count} + 1 end`,
        windowStartedAt: sql`case when ${loginFailure.windowStartedAt} < ${floorParam}
          then ${nowParam}
          when ${loginFailure.count} + 1 >= ${MAX_CODE_USER_FAILURES}
          then ${nowParam} else ${loginFailure.windowStartedAt} end`,
      },
    });
}
