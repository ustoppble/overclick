import { afterEach, describe, expect, it } from "vitest";
import { readSessionToken, signSession } from "./session";

const SECRET = "test-secret-at-least-32-characters-long";

describe("session token", () => {
  afterEach(() => {
    delete process.env.AUTH_SECRET;
  });

  it("round-trips user id and email", async () => {
    process.env.AUTH_SECRET = SECRET;
    const token = await signSession({
      userId: "user-1",
      email: "admin@local",
    });
    const session = await readSessionToken(token);
    expect(session).toEqual({ userId: "user-1", email: "admin@local" });
  });

  // Every document and the deploy path asks for 32: .env.example, CONTRIBUTING,
  // deploy/README, getting-started, and the cloud compose file, which refuses
  // to start without it. The signing key for every board session should not be
  // allowed to be half of what the operator was told to provide.
  it("refuses a secret shorter than the 32 characters the docs require", async () => {
    process.env.AUTH_SECRET = "a".repeat(31);
    await expect(
      signSession({ userId: "user-1", email: "a@b.c" }),
    ).rejects.toThrow(/32/);
  });

  it("rejects a tampered token", async () => {
    process.env.AUTH_SECRET = SECRET;
    const token = await signSession({ userId: "user-1", email: "a@b.c" });
    const session = await readSessionToken(`${token}x`);
    expect(session).toBeNull();
  });
});
