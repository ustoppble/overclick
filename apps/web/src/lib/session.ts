import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "ab_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type SessionPayload = {
  userId: string;
  email: string;
};

// 32 is the floor every document and the deploy path already state, and the
// cloud compose file refuses to boot without it. This is the key that signs
// every session, so the code enforces what the operator was told to provide.
const MIN_SECRET_LENGTH = 32;

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET must be set (${MIN_SECRET_LENGTH}+ characters)`,
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

export async function readSessionToken(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const userId = payload.userId;
    const email = payload.email;
    if (typeof userId !== "string" || typeof email !== "string") return null;
    return { userId, email };
  } catch {
    return null;
  }
}
