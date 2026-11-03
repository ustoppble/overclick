import { loginCodeRequest, loginFailure } from "@agent-board/db";
import { headers } from "next/headers";
import { clearBudget, spendBudget, spendBudgetStatement } from "./attempt-budget";
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
function loginFailureScope(kind: "email" | "origin", value: string): string {
  return `login-${kind}:${value}`;
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
 * Charges one attempt to both buckets and reports whether the login may
 * proceed to `verifyPassword`. Both are always spent — never short-circuited
 * on the first bucket's answer — so which bucket trips first cannot become a
 * second timing signal.
 */
export async function withinLoginBudget(
  db: McpDatabase,
  email: string,
  origin: string | null,
): Promise<boolean> {
  const emailOk = await spendBudget(
    db,
    loginFailure,
    loginFailureScope("email", email),
    MAX_LOGIN_FAILURES,
    LOGIN_ATTEMPT_WINDOW_MS,
  );
  const originOk = origin
    ? await spendBudget(
        db,
        loginFailure,
        loginFailureScope("origin", origin),
        MAX_LOGIN_FAILURES,
        LOGIN_ATTEMPT_WINDOW_MS,
      )
    : true;
  return emailOk && originOk;
}

/** A successful login clears both budgets: nobody there was guessing. */
export async function clearLoginBudget(
  db: McpDatabase,
  email: string,
  origin: string | null,
): Promise<void> {
  await clearBudget(db, loginFailure, loginFailureScope("email", email));
  if (origin) {
    await clearBudget(db, loginFailure, loginFailureScope("origin", origin));
  }
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
 * Charges one code request to every bucket and says whether a code may be
 * issued. All buckets are always spent, for the same reason as in
 * `withinLoginBudget`.
 */
export async function withinCodeRequestBudget(
  db: McpDatabase,
  email: string,
  origin: string | null,
): Promise<boolean> {
  const minuteOk = await spendBudget(
    db,
    loginCodeRequest,
    codeRequestScope("minute-email", email),
    CODE_REQUESTS_PER_MINUTE,
    CODE_REQUEST_MINUTE_MS,
  );
  const hourOk = await spendBudget(
    db,
    loginCodeRequest,
    codeRequestScope("hour-email", email),
    CODE_REQUESTS_PER_HOUR,
    CODE_REQUEST_HOUR_MS,
  );
  const originOk = origin
    ? await spendBudget(
        db,
        loginCodeRequest,
        codeRequestScope("hour-origin", origin),
        CODE_REQUESTS_PER_ORIGIN_HOUR,
        CODE_REQUEST_HOUR_MS,
      )
    : true;
  if (!(minuteOk && hourOk && originOk)) return false;

  // Charged for every ask that got this far, account or not, so the cap is
  // no more an oracle than the buckets above.
  const cap = loginCodeSendCap();
  const [global] = await spendBudgetStatement(
    db,
    loginCodeRequest,
    codeRequestScope("hour-global", "all"),
    new Date(),
    CODE_REQUEST_HOUR_MS,
  );
  const count = global?.count ?? 1;
  if (count > cap) {
    // One line per window, with no address in it: enough to alert on.
    if (count === cap + 1) {
      console.error(
        `[login-code] hourly send cap reached (${cap}); no sign-in codes go out until the window passes`,
      );
    }
    return false;
  }
  return true;
}
