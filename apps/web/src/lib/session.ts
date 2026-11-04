import { hkdfSync } from "node:crypto";
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

/** What `openssl rand -base64 32` / `-hex 32` produce: 32 random bytes. */
const MIN_SECRET_BYTES = 32;
/**
 * The fewest distinct values 32 random bytes ever show (the least seen in
 * 200,000 draws is 23) and the fewest distinct characters their base64 or hex
 * form shows (23, and 12). A secret under these repeats itself too much to
 * have come from a random source.
 */
const MIN_DISTINCT_BYTES = 12;
const MIN_DISTINCT_CHARS = { hex: 12, base64: 22 } as const;

/**
 * Why `secret` does not look like 32 or more random bytes written as hex or
 * base64 — null when it does. Length alone let `"s".repeat(32)` through; this
 * is the shape the docs ask for (`openssl rand -base64 32`). It looks at the
 * value's form, never prints it, and cannot prove randomness: it only turns
 * away what visibly is not.
 */
export function authSecretWeakness(secret: string): string | null {
  const isHex = /^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0;
  const isBase64 = /^[A-Za-z0-9+/_-]+={0,2}$/.test(secret);
  if (!isHex && !isBase64) return "it is not hex or base64";
  const bytes = Buffer.from(secret, isHex ? "hex" : "base64");
  if (bytes.length < MIN_SECRET_BYTES) return `it stands for fewer than ${MIN_SECRET_BYTES} bytes`;
  if (new Set(bytes).size < MIN_DISTINCT_BYTES) return "it repeats the same few values";
  const chars = new Set(secret.replace(/=+$/, "")).size;
  if (chars < MIN_DISTINCT_CHARS[isHex ? "hex" : "base64"]) {
    return "it repeats the same few characters";
  }
  return null;
}

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET must be set (${MIN_SECRET_LENGTH}+ characters)`,
    );
  }
  // This key signs every session and, through `deriveKey`, hashes every
  // sign-in code. A secret that visibly is not random is refused rather than
  // warned about: a warning nobody reads leaves the instance signing with it.
  // The message says why and how to fix it, and never carries the value.
  const why = authSecretWeakness(secret);
  if (why) {
    throw new Error(
      `AUTH_SECRET is too weak (${why}). It signs every session; generate one with: openssl rand -base64 32. Replacing it signs everyone out.`,
    );
  }
  return new TextEncoder().encode(secret);
}

/**
 * A key for one purpose, derived from AUTH_SECRET with HKDF (`info` names the
 * purpose). The session key itself stays in this module: a feature that needs
 * a secret of its own takes a subkey, so leaking what it computes with it
 * says nothing about the key that signs sessions.
 */
export function deriveKey(info: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secretKey(), "", info, 32));
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
