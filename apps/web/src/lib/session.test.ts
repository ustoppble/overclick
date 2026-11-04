import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authSecretWeakness,
  deriveKey,
  readSessionToken,
  signSession,
} from "./session";
import { TEST_AUTH_SECRET } from "../test-support/auth-secret";

const SECRET = TEST_AUTH_SECRET;

describe("session token", () => {
  afterEach(() => {
    delete process.env.AUTH_SECRET;
  });

  it("round-trips user id and session version", async () => {
    process.env.AUTH_SECRET = SECRET;
    const token = await signSession({
      userId: "user-1",
      sessionVersion: 3,
    });
    const session = await readSessionToken(token);
    expect(session).toEqual({ userId: "user-1", sessionVersion: 3 });
  });

  // Every document and the deploy path asks for 32: .env.example, CONTRIBUTING,
  // deploy/README, getting-started, and the cloud compose file, which refuses
  // to start without it. The signing key for every board session should not be
  // allowed to be half of what the operator was told to provide.
  it("refuses a secret shorter than the 32 characters the docs require", async () => {
    process.env.AUTH_SECRET = "a".repeat(31);
    await expect(
      signSession({ userId: "user-1", sessionVersion: 1 }),
    ).rejects.toThrow(/32/);
  });

  it("rejects a tampered token", async () => {
    process.env.AUTH_SECRET = SECRET;
    const token = await signSession({ userId: "user-1", sessionVersion: 1 });
    const session = await readSessionToken(`${token}x`);
    expect(session).toBeNull();
  });

  it("rejects a token without a session version", async () => {
    process.env.AUTH_SECRET = SECRET;
    const token = await new SignJWT({ userId: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));

    await expect(readSessionToken(token)).resolves.toBeNull();
  });
});

describe("AUTH_SECRET strength", () => {
  afterEach(() => {
    delete process.env.AUTH_SECRET;
    vi.restoreAllMocks();
  });

  const random32 = () => randomBytes(32);

  it("accepts 32 random bytes as base64, base64url or hex", () => {
    const bytes = random32();
    expect(authSecretWeakness(bytes.toString("base64"))).toBeNull();
    expect(authSecretWeakness(bytes.toString("base64url"))).toBeNull();
    expect(authSecretWeakness(bytes.toString("hex"))).toBeNull();
  });

  it("flags a secret that is only long, not random", () => {
    expect(authSecretWeakness("s".repeat(32))).not.toBeNull();
    expect(authSecretWeakness("test-secret-at-least-32-characters-long")).not.toBeNull();
    expect(authSecretWeakness("replace-with-a-long-random-string-at-least-32-chars")).not.toBeNull();
  });

  it("flags a base64 value that stands for fewer than 32 bytes", () => {
    expect(authSecretWeakness(randomBytes(24).toString("base64"))).not.toBeNull();
    expect(authSecretWeakness(randomBytes(16).toString("hex"))).not.toBeNull();
  });

  it("flags a secret of 32 bytes that repeats a handful of values", () => {
    expect(authSecretWeakness(Buffer.alloc(32, 7).toString("base64"))).not.toBeNull();
    expect(authSecretWeakness(Buffer.from("abababababababababababababababab").toString("hex"))).not.toBeNull();
    expect(authSecretWeakness("ab".repeat(32))).not.toBeNull();
  });

  it("refuses a secret that is long enough but visibly not random, and never prints it", async () => {
    for (const secret of [
      "weak-but-long-enough-secret-value-xyz-123",
      "s".repeat(32),
      "test-secret-at-least-32-characters-long",
      "replace-with-a-long-random-string-at-least-32-chars",
    ]) {
      process.env.AUTH_SECRET = secret;
      const failures: unknown[] = [];
      await signSession({ userId: "user-1", sessionVersion: 1 }).catch((e) => failures.push(e));
      try {
        deriveKey("anything");
      } catch (e) {
        failures.push(e);
      }
      expect(failures).toHaveLength(2);
      for (const failure of failures) {
        const message = (failure as Error).message;
        expect(message).toMatch(/AUTH_SECRET/);
        expect(message).toMatch(/openssl rand -base64 32/);
        expect(message).not.toContain(secret);
      }
    }
  });

  it("does not sign or verify anything with a weak secret", async () => {
    process.env.AUTH_SECRET = SECRET;
    const token = await signSession({ userId: "user-1", sessionVersion: 1 });
    process.env.AUTH_SECRET = "s".repeat(32);
    await expect(readSessionToken(token)).resolves.toBeNull();
  });

  it("signs with a strong secret and says nothing", async () => {
    process.env.AUTH_SECRET = random32().toString("base64");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(signSession({ userId: "user-1", sessionVersion: 1 })).resolves.toEqual(expect.any(String));

    expect(warn).not.toHaveBeenCalled();
  });
});
