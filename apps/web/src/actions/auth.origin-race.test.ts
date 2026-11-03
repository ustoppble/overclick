import { loginFailure, user } from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LOGIN_FAILURES } from "../lib/login-rate-limit";
import { hashPassword, verifyPassword } from "../lib/password";
import { redeemLoginCode } from "../lib/login-code";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

let world: TestWorld;

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

// Both are the real functions, only counted: a guess that reaches either one
// is a guess the origin's budget let through.
vi.mock("../lib/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/password")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

vi.mock("../lib/login-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/login-code")>();
  return { ...actual, redeemLoginCode: vi.fn(actual.redeemLoginCode) };
});

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers({ "x-forwarded-for": "198.51.100.7" }),
}));

vi.mock("next/server", () => ({ after: () => undefined }));

const { loginAction, loginWithCodeAction } = await import("./auth");

const BURST = 30;

function passwordForm(email: string, password: string): FormData {
  const form = new FormData();
  form.set("email", email);
  form.set("password", password);
  return form;
}

function codeForm(email: string, code: string): FormData {
  const form = new FormData();
  form.set("email", email);
  form.set("code", code);
  return form;
}

/**
 * The origin's allowance is spent before the guess is checked, in one
 * statement, so a burst of parallel guesses cannot all read an untouched
 * count and pass together. Each address here is new, so the per-address
 * bucket holds nobody back: only the origin can.
 */
describe("a parallel burst from one origin, one address per guess", () => {
  beforeEach(async () => {
    process.env.AUTH_SECRET = "s".repeat(32);
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    world = await createTestWorld();
    await world.db
      .insert(user)
      .values({ email: "real@local.test", passwordHash: await hashPassword("right-one-123") });
    vi.mocked(verifyPassword).mockClear();
    vi.mocked(redeemLoginCode).mockClear();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
    delete process.env.OVERCLICK_TRUSTED_PROXY;
  });

  it("lets at most the failure budget of wrong passwords reach verification", async () => {
    await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        loginAction(null, passwordForm(`ghost${i}@local.test`, "nope-nope")),
      ),
    );

    expect(verifyPassword).toHaveBeenCalledTimes(MAX_LOGIN_FAILURES);
  });

  it("lets at most the failure budget of wrong codes reach verification", async () => {
    await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        loginWithCodeAction(null, codeForm(`ghost${i}@local.test`, "123456")),
      ),
    );

    expect(redeemLoginCode).toHaveBeenCalledTimes(MAX_LOGIN_FAILURES);
  });

  it("does not charge the origin for a guess turned away by the address's own budget", async () => {
    await world.db.insert(loginFailure).values({
      id: "login-email:real@local.test",
      count: MAX_LOGIN_FAILURES,
      windowStartedAt: new Date(),
    });

    for (let i = 0; i < 5; i++) {
      await loginAction(null, passwordForm("real@local.test", "nope-nope"));
    }

    expect(verifyPassword).not.toHaveBeenCalled();
    const origin = (await world.db.select().from(loginFailure)).find(
      (row) => row.id === "login-origin:198.51.100.7",
    );
    expect(origin?.count ?? 0).toBe(0);
  });
});
