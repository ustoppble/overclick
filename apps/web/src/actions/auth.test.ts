import { TEST_AUTH_SECRET } from "../test-support/auth-secret";
import { user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { issueLoginCode, redeemLoginCode } from "../lib/login-code";
import { createTestWorld, type TestWorld } from "../mcp/test-db";

let world: TestWorld;

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

vi.mock("../lib/login-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/login-code")>();
  return { ...actual, redeemLoginCode: vi.fn(actual.redeemLoginCode) };
});

const redirectSpy = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectSpy(url),
}));

const cookieSet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: cookieSet, delete: vi.fn() }),
  headers: async () => new Headers(),
}));

vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./auth");
const { loginWithCodeAction } = actions;

function codeForm(email: string, code: string): FormData {
  const form = new FormData();
  form.set("email", email);
  form.set("code", code);
  return form;
}

/**
 * The board takes no password any more: the only way in is a code sent to the
 * address. These keep the guarantees the password sign-in had (GHSA-rrc7-jvcm-
 * 35r5: one verification on every failing path, the same words for an address
 * with no account, a switched-off account and a wrong guess) on the flow that
 * replaced it, and pin that nothing takes a password at all.
 */
describe("signing in takes a code, never a password", () => {
  let offCode = "";

  beforeAll(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    world = await createTestWorld();
    await world.db.insert(user).values([
      { email: "active@local.test" },
      { email: "off@local.test" },
    ]);
    // A code that was live when the account was switched off by hand, so the
    // only thing turning it away is `active`.
    offCode = (await issueLoginCode(world.db, "off@local.test"))!.code;
    await world.db.update(user).set({ active: false }).where(eq(user.email, "off@local.test"));
    await issueLoginCode(world.db, "active@local.test");
  });

  beforeEach(() => {
    vi.mocked(redeemLoginCode).mockClear();
    redirectSpy.mockClear();
    cookieSet.mockClear();
  });

  it("has no password sign-in action left to call", () => {
    expect("loginAction" in actions).toBe(false);
  });

  it("does not sign anyone in from a password, whatever the form carries", async () => {
    const form = new FormData();
    form.set("email", "active@local.test");
    form.set("password", "correct-horse-battery");

    expect(await loginWithCodeAction(null, form)).toEqual({ error: expect.any(String) });
    expect(redirectSpy).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("checks the code once for an address with no account", async () => {
    const result = await loginWithCodeAction(null, codeForm("ghost@local.test", "123456"));

    expect(result?.error).toBeTruthy();
    expect(redeemLoginCode).toHaveBeenCalledTimes(1);
  });

  it("checks the code once for a switched-off account, and still turns it away", async () => {
    const result = await loginWithCodeAction(null, codeForm("off@local.test", offCode));

    expect(result?.error).toBeTruthy();
    expect(redeemLoginCode).toHaveBeenCalledTimes(1);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("checks the code once for a wrong guess", async () => {
    const result = await loginWithCodeAction(null, codeForm("active@local.test", "000000"));

    expect(result?.error).toBeTruthy();
    expect(redeemLoginCode).toHaveBeenCalledTimes(1);
  });

  it("answers all three with the same words", async () => {
    const answers = await Promise.all([
      loginWithCodeAction(null, codeForm("ghost@local.test", "123456")),
      loginWithCodeAction(null, codeForm("off@local.test", "123456")),
      loginWithCodeAction(null, codeForm("active@local.test", "111111")),
    ]);

    expect(new Set(answers.map((answer) => answer?.error)).size).toBe(1);
  });
});
