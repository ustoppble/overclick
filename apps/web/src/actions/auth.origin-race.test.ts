import { TEST_AUTH_SECRET } from "../test-support/auth-secret";
import { loginFailure, user } from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LOGIN_FAILURES } from "../lib/login-rate-limit";
import { issueLoginCode, redeemLoginCode } from "../lib/login-code";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

let world: TestWorld;

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

// The real function, only counted: a guess that reaches it is a guess the
// origin's budget let through.

vi.mock("../lib/login-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/login-code")>();
  return { ...actual, redeemLoginCode: vi.fn(actual.redeemLoginCode) };
});

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const requestHeaders = vi.hoisted(() => ({
  current: { "x-forwarded-for": "198.51.100.7" } as Record<string, string>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(requestHeaders.current),
}));

vi.mock("next/server", () => ({ after: () => undefined }));

const { loginWithCodeAction } = await import("./auth");

const BURST = 30;

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
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    world = await createTestWorld();
    await world.db.insert(user).values({ email: "real@local.test" });
    vi.mocked(redeemLoginCode).mockClear();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
    delete process.env.OVERCLICK_TRUSTED_PROXY;
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
      id: "logincode-email:real@local.test",
      count: MAX_LOGIN_FAILURES,
      windowStartedAt: new Date(),
    });

    for (let i = 0; i < 5; i++) {
      await loginWithCodeAction(null, codeForm("real@local.test", "123456"));
    }

    expect(redeemLoginCode).not.toHaveBeenCalled();
    const origin = (await world.db.select().from(loginFailure)).find(
      (row) => row.id === "logincode-origin:198.51.100.7",
    );
    expect(origin?.count ?? 0).toBe(0);
  });
});

const ORIGIN_CODE = "logincode-origin:198.51.100.7";

async function originCount(id: string): Promise<number> {
  const rows = await world.db.select().from(loginFailure);
  return rows.find((row) => row.id === id)?.count ?? 0;
}

/** `n` accounts, one address each. */
async function seedAccounts(n: number): Promise<string[]> {
  const emails = Array.from({ length: n }, (_, i) => `ok${i}@local.test`);
  await world.db.insert(user).values(emails.map((email) => ({ email })));
  return emails;
}

/** A live code for each of `emails`, in the order given. */
async function seedCodes(emails: string[]): Promise<string[]> {
  return Promise.all(
    emails.map(async (email) => {
      const issued = await issueLoginCode(world.db, email);
      if (!issued) throw new Error("no code issued");
      return issued.code;
    }),
  );
}

/** A sign-in that works answers with a redirect, which is mocked: no error comes back. */
function signedIn(answers: Array<{ error: string } | null | undefined>): number {
  return answers.filter((answer) => !answer).length;
}

/**
 * Behind a NAT or an edge proxy the origin is shared by everyone, so people
 * signing in correctly must not lock it out — however many of them arrive at
 * once. The origin's charge is taken before the guess is checked, so a burst
 * wider than the budget finds some of its members turned away while the rest
 * are in flight; what is turned away must not stay charged, or the origin is
 * left locked for the whole window with nobody having been wrong.
 */
describe.each([12, 30])("a parallel burst of %i right sign-ins from one origin", (burst) => {
  beforeEach(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    world = await createTestWorld();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
    delete process.env.OVERCLICK_TRUSTED_PROXY;
  });

  it("leaves the origin's code budget untouched", async () => {
    // One account more than the burst, kept out of it: the one to sign in
    // with afterwards.
    const [afterwards, ...emails] = (await seedAccounts(burst + 1)).reverse();
    const codes = await seedCodes([afterwards!, ...emails]);
    const answers = await Promise.all(
      emails.map((email, i) => loginWithCodeAction(null, codeForm(email, codes[i + 1]!))),
    );

    // The budget is what bounds how many guesses are in flight at once.
    expect(signedIn(answers)).toBeGreaterThanOrEqual(MAX_LOGIN_FAILURES);
    expect(await originCount(ORIGIN_CODE)).toBe(0);
    // And nobody is shut out afterwards.
    expect(await loginWithCodeAction(null, codeForm(afterwards!, codes[0]!))).toBeUndefined();
  });
});

describe("right sign-ins from one origin, one after the other", () => {
  beforeEach(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    world = await createTestWorld();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
    delete process.env.OVERCLICK_TRUSTED_PROXY;
  });

  it("never run out of code budget, however many there are", async () => {
    const emails = await seedAccounts(14);
    const codes = await seedCodes(emails);
    const answers: Array<{ error: string } | null | undefined> = [];
    for (const [i, email] of emails.entries()) {
      answers.push(await loginWithCodeAction(null, codeForm(email, codes[i]!)));
    }

    expect(signedIn(answers)).toBe(14);
    expect(await originCount(ORIGIN_CODE)).toBe(0);
  });
});

describe("what a right sign-in gives back", () => {
  beforeEach(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    world = await createTestWorld();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
    delete process.env.OVERCLICK_TRUSTED_PROXY;
  });

  it("is its own charge on the code budget, never the wrong guesses before it", async () => {
    const [email] = await seedAccounts(1);
    const [code] = await seedCodes([email!]);
    for (let i = 0; i < 3; i++) {
      await loginWithCodeAction(null, codeForm(`ghost${i}@local.test`, "123456"));
    }
    expect(await originCount(ORIGIN_CODE)).toBe(3);

    expect(await loginWithCodeAction(null, codeForm(email!, code!))).toBeUndefined();

    expect(await originCount(ORIGIN_CODE)).toBe(3);
  });

  it("does not let right sign-ins wipe the wrong ones: eight failures still lock, then none gets in", async () => {
    // A fresh account and code for every right sign-in, so nothing but the
    // origin's count stands between each one and the board.
    const emails = await seedAccounts(MAX_LOGIN_FAILURES + 1);
    const codes = await seedCodes(emails);
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await loginWithCodeAction(null, codeForm(`ghost${i}@local.test`, "123456"));
      await loginWithCodeAction(null, codeForm(emails[i]!, codes[i]!));
    }
    vi.mocked(redeemLoginCode).mockClear();

    const last = MAX_LOGIN_FAILURES;
    expect(await loginWithCodeAction(null, codeForm(emails[last]!, codes[last]!))).toEqual({
      error: expect.any(String),
    });
    expect(redeemLoginCode).not.toHaveBeenCalled();
  });
});

/**
 * Behind Cloudflare everyone arrives from the same edge: with the last hop as
 * the origin they all share one bucket. Named with OVERCLICK_CLIENT_IP_HEADER,
 * the visitor's own address is the origin, so one visitor's wrong guesses do
 * not lock out the next one.
 */
describe("two visitors behind the same edge", () => {
  const EDGE = "203.0.113.10";

  function from(visitor: string) {
    requestHeaders.current = {
      "x-forwarded-for": `${visitor}, ${EDGE}`,
      "cf-connecting-ip": visitor,
    };
  }

  beforeEach(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    world = await createTestWorld();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
    delete process.env.OVERCLICK_TRUSTED_PROXY;
    delete process.env.OVERCLICK_CLIENT_IP_HEADER;
    requestHeaders.current = { "x-forwarded-for": "198.51.100.7" };
  });

  async function lockOneThenTryTheOther(): Promise<{ error: string } | null | undefined> {
    const [email] = await seedAccounts(1);
    const [code] = await seedCodes([email!]);
    from("198.51.100.1");
    for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
      await loginWithCodeAction(null, codeForm(`ghost${i}@local.test`, "123456"));
    }
    from("198.51.100.2");
    return loginWithCodeAction(null, codeForm(email!, code!));
  }

  it("get buckets of their own when the client IP header is named", async () => {
    process.env.OVERCLICK_CLIENT_IP_HEADER = "cf-connecting-ip";

    expect(await lockOneThenTryTheOther()).toBeUndefined();
    expect(await originCount("logincode-origin:198.51.100.1")).toBe(MAX_LOGIN_FAILURES);
    expect(await originCount(`logincode-origin:${EDGE}`)).toBe(0);
  });

  it("share the edge's bucket when it is not, as before", async () => {
    expect(await lockOneThenTryTheOther()).toEqual({ error: expect.any(String) });
    expect(await originCount(`logincode-origin:${EDGE}`)).toBe(MAX_LOGIN_FAILURES);
  });
});
