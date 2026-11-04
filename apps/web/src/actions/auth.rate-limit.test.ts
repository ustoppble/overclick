import { TEST_AUTH_SECRET } from "../test-support/auth-secret";
import { loginFailure, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueLoginCode, redeemLoginCode } from "../lib/login-code";
import { MAX_LOGIN_FAILURES } from "../lib/login-rate-limit";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

let world: TestWorld;

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

// The real function, only counted: a guess that reaches it is a guess the
// budget let through.
vi.mock("../lib/login-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/login-code")>();
  return { ...actual, redeemLoginCode: vi.fn(actual.redeemLoginCode) };
});

const redirectSpy = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectSpy(url),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: vi.fn(),
    delete: vi.fn(),
  }),
  headers: async () => new Headers(),
}));

vi.mock("next/server", () => ({ after: () => undefined }));

const { loginWithCodeAction } = await import("./auth");

function codeForm(email: string, code: string): FormData {
  const form = new FormData();
  form.set("email", email);
  form.set("code", code);
  return form;
}

/** Six digits that are not `code`. */
function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

/**
 * OCL-100, carried over from the password sign-in to the code that replaced
 * it: failed attempts are budgeted per identifier, the address as typed, so
 * an address with no account is turned away the same way and no refusal costs
 * the check it is meant to spare.
 */
describe("loginWithCodeAction rate limits failed attempts per identifier", () => {
  let code = "";

  beforeEach(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    world = await createTestWorld();
    await world.db.insert(user).values([{ email: "exists@local.test" }]);
    code = (await issueLoginCode(world.db, "exists@local.test"))!.code;
    vi.mocked(redeemLoginCode).mockClear();
    redirectSpy.mockClear();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
  });

  it("refuses the attempt past the budget for an email that has an account, without checking the code", async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      const result = await loginWithCodeAction(
        null,
        codeForm("exists@local.test", wrongCode(code)),
      );
      expect(result?.error).toBeTruthy();
    }
    expect(redeemLoginCode).toHaveBeenCalledTimes(MAX_LOGIN_FAILURES);

    const overBudget = await loginWithCodeAction(null, codeForm("exists@local.test", code));
    expect(overBudget?.error).toBeTruthy();
    // Turned away before the code was looked at: the count did not grow.
    expect(redeemLoginCode).toHaveBeenCalledTimes(MAX_LOGIN_FAILURES);
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("refuses the same way for an email with no account at all", async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      const result = await loginWithCodeAction(null, codeForm("ghost@local.test", "123456"));
      expect(result?.error).toBeTruthy();
    }
    expect(redeemLoginCode).toHaveBeenCalledTimes(MAX_LOGIN_FAILURES);

    const overBudget = await loginWithCodeAction(null, codeForm("ghost@local.test", "123456"));
    expect(overBudget?.error).toBeTruthy();
    expect(redeemLoginCode).toHaveBeenCalledTimes(MAX_LOGIN_FAILURES);
  });

  it("answers a real account over budget and a fake account over budget with the exact same words", async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await loginWithCodeAction(null, codeForm("exists@local.test", wrongCode(code)));
      await loginWithCodeAction(null, codeForm("nobody@local.test", "123456"));
    }

    const [realOverBudget, fakeOverBudget] = await Promise.all([
      loginWithCodeAction(null, codeForm("exists@local.test", wrongCode(code))),
      loginWithCodeAction(null, codeForm("nobody@local.test", "123456")),
    ]);

    expect(realOverBudget?.error).toBeTruthy();
    expect(realOverBudget?.error).toBe(fakeOverBudget?.error);
  });

  it("lets a right code through while still under budget, and clears the counter on success", async () => {
    // Four wrong on this code is all it survives before the right one.
    for (let i = 0; i < 4; i++) {
      const result = await loginWithCodeAction(
        null,
        codeForm("exists@local.test", wrongCode(code)),
      );
      expect(result?.error).toBeTruthy();
    }

    await loginWithCodeAction(null, codeForm("exists@local.test", code));
    expect(redirectSpy).toHaveBeenCalledWith("/board");

    const [row] = await world.db
      .select()
      .from(loginFailure)
      .where(eq(loginFailure.id, "logincode-email:exists@local.test"));
    expect(row).toBeUndefined();
  });

  it("keeps one identifier's budget from blocking another's sign-in", async () => {
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await loginWithCodeAction(null, codeForm("exists@local.test", "123456"));
    }

    await world.db.insert(user).values({ email: "neighbour@local.test" });
    const theirs = (await issueLoginCode(world.db, "neighbour@local.test"))!.code;

    await loginWithCodeAction(null, codeForm("neighbour@local.test", theirs));
    expect(redirectSpy).toHaveBeenCalledWith("/board");
  });
});
