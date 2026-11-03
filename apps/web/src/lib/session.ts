import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "ab_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type SessionTokenPayload = {
  userId: string;
  sessionVersion: number;
};

export type SessionPayload = SessionTokenPayload & {
  email: string;
};

// 32 is the floor every document and the deploy path already state, and the
// cloud compose file refuses to boot without it. This is the key that signs
// every session, so the code enforces what the operator was told to provide.
const MIN_SECRET_LENGTH = 32;

/** Also keys the sign-in code hashes (`login-code.ts`). */
export function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET must be set (${MIN_SECRET_LENGTH}+ characters)`,
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(
  payload: SessionTokenPayload,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

export async function readSessionToken(
  token: string,
): Promise<SessionTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
    });
    const userId = payload.userId;
    const sessionVersion = payload.sessionVersion;
    if (
      typeof userId !== "string" ||
      !Number.isSafeInteger(sessionVersion) ||
      (sessionVersion as number) < 1
    ) {
      return null;
    }
    return { userId, sessionVersion: sessionVersion as number };
  } catch {
    return null;
  }
}
