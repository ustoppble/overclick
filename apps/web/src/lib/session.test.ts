import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authSecretWeakness,
  readSessionToken,
  resetAuthSecretWarning,
  signSession,
} from "./session";

const SECRET = "test-secret-at-least-32-characters-long";

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

  it("warns once, never prints the secret, and does not refuse a weak one that is long enough", async () => {
    const secret = "weak-but-long-enough-secret-value-xyz-123";
    process.env.AUTH_SECRET = secret;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetAuthSecretWarning();

    await signSession({ userId: "user-1", sessionVersion: 1 });
    await signSession({ userId: "user-1", sessionVersion: 1 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(warn.mock.calls)).toMatch(/AUTH_SECRET/);
  });

  it("does not warn for a strong secret", async () => {
    process.env.AUTH_SECRET = random32().toString("base64");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetAuthSecretWarning();

    await signSession({ userId: "user-1", sessionVersion: 1 });

    expect(warn).not.toHaveBeenCalled();
  });
});
