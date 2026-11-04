import { user } from "@agent-board/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  readSessionToken,
  signSession,
  type SessionPayload,
  type SessionTokenPayload,
} from "./session";
import { db } from "./db";
import { clearLoginCodes } from "./login-code";

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await readSessionToken(token);
  if (!session) return null;

  const [found] = await db()
    .select({
      id: user.id,
      email: user.email,
      active: user.active,
      sessionVersion: user.sessionVersion,
    })
    .from(user)
    .where(eq(user.id, session.userId))
    .limit(1);

  if (
    !found ||
    !found.active ||
    found.sessionVersion !== session.sessionVersion
  ) {
    return null;
  }

  return {
    userId: found.id,
    email: found.email,
    sessionVersion: found.sessionVersion,
  };
}

export async function setSession(payload: SessionTokenPayload): Promise<void> {
  const token = await signSession(payload);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Ends the session for good. Deleting the cookie only forgets it in this
 * browser: a copy of it (a stolen profile, a log, a proxy) stays a valid
 * signed token for its 30 days. So the account's `session_version` goes up
 * first, which is what every token is checked against (`getSession`), and the
 * sign-in codes still waiting for the account go with it.
 *
 * The bump is conditional on the cookie being the current session, so an old
 * copy of a cookie cannot be replayed at the logout to sign the live one out.
 * The version belongs to the account, not to a device: every browser signed in
 * as this person has to sign in again, which is the price of revoking without
 * a table of sessions.
 */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  const session = await getSession();
  if (session) {
    await db()
      .update(user)
      .set({ sessionVersion: sql`${user.sessionVersion} + 1` })
      .where(
        and(
          eq(user.id, session.userId),
          eq(user.sessionVersion, session.sessionVersion),
        ),
      );
    await clearLoginCodes(db(), session.userId);
  }
  store.delete(SESSION_COOKIE);
}
