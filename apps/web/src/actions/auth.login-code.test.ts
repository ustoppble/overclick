import { loginCode, loginCodeRequest, loginFailure, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODE_REQUESTS_PER_HOUR,
  CODE_REQUESTS_PER_ORIGIN_HOUR,
  DEFAULT_LOGIN_CODE_MAX_SENDS_PER_HOUR,
  MAX_CODE_USER_FAILURES,
  MAX_LOGIN_FAILURES,
  loginCodeSendCap,
} from "../lib/login-rate-limit";
import { setSession } from "../lib/cookies";
import { SESSION_COOKIE } from "../lib/session";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

let world: TestWorld;

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

const emailState = vi.hoisted(() => ({
  configured: true,
  sendEmail: vi.fn(async (_message: { to: string; subject: string; text: string }) => true),
}));

vi.mock("../lib/email", () => ({
  emailConfigured: () => emailState.configured,
  sendEmail: emailState.sendEmail,
}));

const redirectSpy = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectSpy(url),
}));

const requestState = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  headers: {} as Record<string, string>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: requestState.cookieSet,
    delete: vi.fn(),
  }),
  headers: async () => new Headers(requestState.headers),
}));

// `after` only exists inside a request; here it queues the callback so a test
// decides when the work that follows the response gets to run.
const afterState = vi.hoisted(() => ({
  queued: [] as Array<() => unknown>,
}));

vi.mock("next/server", () => ({
  after: (callback: () => unknown) => {
    afterState.queued.push(callback);
  },
}));

const actions = await import("./auth");
const { loginWithCodeAction } = actions;

/** Runs, in order, what the action handed to `after`. */
async function runAfter(): Promise<void> {
  while (afterState.queued.length > 0) {
    await afterState.queued.shift()!();
  }
}

/** The action, then everything that follows its response. */
const requestLoginCodeAction: typeof actions.requestLoginCodeAction = async (
  prev,
  formData,
) => {
  const answer = await actions.requestLoginCodeAction(prev, formData);
  await runAfter();
  return answer;
};

const EMAIL = "person@local.test";
const T0 = new Date("2026-11-03T12:00:00.000Z");
const MINUTE = 60 * 1000;

function emailForm(email: string): FormData {
  const form = new FormData();
  form.set("email", email);
  return form;
}

function codeForm(email: string, code: string): FormData {
  const form = new FormData();
  form.set("email", email);
  form.set("code", code);
  return form;
}

/** The six digits the last email carried — the only place the code exists in clear. */
function lastSentCode(): string {
  const message = emailState.sendEmail.mock.calls.at(-1)?.[0];
  const match = message?.text.match(/\b(\d{6})\b/);
  if (!match) throw new Error("no code was sent");
  return match[1]!;
}

function sentTo(email: string): number {
  return emailState.sendEmail.mock.calls.filter(([message]) => message.to === email)
    .length;
}

function at(offsetMs: number): void {
  vi.setSystemTime(new Date(T0.getTime() + offsetMs));
}

describe("signing in with a code sent by email", () => {
  let userId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    process.env.AUTH_SECRET = "s".repeat(32);
    delete process.env.OVERCLICK_TRUSTED_PROXY;
    requestState.headers = {};
    world = await createTestWorld();
    const [row] = await world.db
      .insert(user)
      .values([{ email: EMAIL }, { email: "off@local.test", active: false }])
      .returning({ id: user.id });
    userId = row!.id;
    emailState.configured = true;
    emailState.sendEmail.mockClear();
    afterState.queued.length = 0;
    requestState.cookieSet.mockClear();
    redirectSpy.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
    delete process.env.OVERCLICK_TRUSTED_PROXY;
    delete process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR;
  });

  describe("asking for a code", () => {
    it("sends a six-digit code, in Portuguese, with the ten-minute validity, to an active account", async () => {
      const answer = await requestLoginCodeAction(null, emailForm(" Person@Local.test "));

      expect(answer).toEqual({ sent: true });
      expect(emailState.sendEmail).toHaveBeenCalledTimes(1);
      const message = emailState.sendEmail.mock.calls[0]![0];
      expect(message.to).toBe(EMAIL);
      expect(message.subject).toMatch(/código/i);
      expect(message.text).toMatch(/\b\d{6}\b/);
      expect(message.text).toMatch(/10 minutos/);
    });

    it("answers an unknown address and a switched-off account exactly like a real one, and sends nothing to either", async () => {
      const real = await requestLoginCodeAction(null, emailForm(EMAIL));
      const ghost = await requestLoginCodeAction(null, emailForm("ghost@local.test"));
      const off = await requestLoginCodeAction(null, emailForm("off@local.test"));

      expect(ghost).toEqual(real);
      expect(off).toEqual(real);
      expect(sentTo("ghost@local.test")).toBe(0);
      expect(sentTo("off@local.test")).toBe(0);
      expect(sentTo(EMAIL)).toBe(1);
      const rows = await world.db.select().from(loginCode);
      expect(rows.map((row) => row.userId)).toEqual([userId]);
    });

    it("sends one code a minute per address, answering the extra ask the same way", async () => {
      const first = await requestLoginCodeAction(null, emailForm(EMAIL));
      at(30 * 1000);
      const second = await requestLoginCodeAction(null, emailForm(EMAIL));

      expect(second).toEqual(first);
      expect(sentTo(EMAIL)).toBe(1);

      at(MINUTE + 1000);
      await requestLoginCodeAction(null, emailForm(EMAIL));
      expect(sentTo(EMAIL)).toBe(2);
    });

    it("does not charge the hourly bucket for asks the minute bucket refused, so a burst cannot lock the owner out for the hour", async () => {
      await requestLoginCodeAction(null, emailForm(EMAIL));
      expect(sentTo(EMAIL)).toBe(1);

      // A stranger hammering the owner's address.
      for (let i = 0; i < 20; i++) {
        at(1000 + i);
        await requestLoginCodeAction(null, emailForm(EMAIL));
      }
      expect(sentTo(EMAIL)).toBe(1);

      at(MINUTE + 5000);
      await requestLoginCodeAction(null, emailForm(EMAIL));
      expect(sentTo(EMAIL)).toBe(2);
    });

    it("sends at most five codes an hour per address", async () => {
      for (let i = 0; i < CODE_REQUESTS_PER_HOUR; i++) {
        at(i * (MINUTE + 1000));
        await requestLoginCodeAction(null, emailForm(EMAIL));
      }
      expect(sentTo(EMAIL)).toBe(CODE_REQUESTS_PER_HOUR);

      at(CODE_REQUESTS_PER_HOUR * (MINUTE + 1000));
      const refused = await requestLoginCodeAction(null, emailForm(EMAIL));
      expect(refused).toEqual({ sent: true });
      expect(sentTo(EMAIL)).toBe(CODE_REQUESTS_PER_HOUR);

      at(61 * MINUTE);
      await requestLoginCodeAction(null, emailForm(EMAIL));
      expect(sentTo(EMAIL)).toBe(CODE_REQUESTS_PER_HOUR + 1);
    });

    it("charges an unknown address the same budget, so the limit says nothing about who has an account", async () => {
      const first = await requestLoginCodeAction(null, emailForm("ghost@local.test"));
      const second = await requestLoginCodeAction(null, emailForm("ghost@local.test"));
      expect(second).toEqual(first);
      expect(emailState.sendEmail).not.toHaveBeenCalled();
    });

    it("caps how many codes one origin can ask for behind a trusted proxy", async () => {
      process.env.OVERCLICK_TRUSTED_PROXY = "1";
      requestState.headers = { "x-forwarded-for": "198.51.100.7" };
      const emails: string[] = [];
      for (let i = 0; i <= CODE_REQUESTS_PER_ORIGIN_HOUR; i++) {
        const email = `p${i}@local.test`;
        emails.push(email);
        await world.db.insert(user).values({ email });
      }

      for (const email of emails) {
        await requestLoginCodeAction(null, emailForm(email));
      }
      expect(emailState.sendEmail).toHaveBeenCalledTimes(CODE_REQUESTS_PER_ORIGIN_HOUR);
    });

    describe("after the response", () => {
      it("answers before a code exists or an email leaves, and does both once the response is out", async () => {
        const answer = await actions.requestLoginCodeAction(null, emailForm(EMAIL));

        expect(answer).toEqual({ sent: true });
        expect(emailState.sendEmail).not.toHaveBeenCalled();
        expect(await world.db.select().from(loginCode)).toHaveLength(0);
        expect(afterState.queued).toHaveLength(1);

        await runAfter();
        expect(emailState.sendEmail).toHaveBeenCalledTimes(1);
        expect(await world.db.select().from(loginCode)).toHaveLength(1);
      });

      it("hands the same work to after for an address with no account, so the response cannot tell them apart", async () => {
        await actions.requestLoginCodeAction(null, emailForm(EMAIL));
        const real = afterState.queued.length;
        afterState.queued.length = 0;
        await actions.requestLoginCodeAction(null, emailForm("ghost@local.test"));

        expect(afterState.queued).toHaveLength(real);
      });

      it("logs a failure after the response without the address and without throwing", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        emailState.sendEmail.mockRejectedValueOnce(new Error(`boom ${EMAIL}`));

        await actions.requestLoginCodeAction(null, emailForm(EMAIL));
        await expect(runAfter()).resolves.toBeUndefined();

        expect(logged).toHaveBeenCalled();
        expect(JSON.stringify(logged.mock.calls)).not.toContain(EMAIL);
        logged.mockRestore();
      });
    });

    describe("the global hourly send cap", () => {
      async function addAccounts(count: number): Promise<string[]> {
        const emails = Array.from({ length: count }, (_, i) => `g${i}@local.test`);
        for (const email of emails) {
          await world.db.insert(user).values({ email });
        }
        return emails;
      }

      it("defaults to 60 an hour and reads LOGIN_CODE_MAX_SENDS_PER_HOUR", () => {
        expect(DEFAULT_LOGIN_CODE_MAX_SENDS_PER_HOUR).toBe(60);
        expect(loginCodeSendCap()).toBe(60);
        process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR = "7";
        expect(loginCodeSendCap()).toBe(7);
        for (const junk of ["", "0", "-3", "abc", "1.5"]) {
          process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR = junk;
          expect(loginCodeSendCap()).toBe(60);
        }
      });

      it("sends nothing to anyone past the cap, answers every address the same and logs one line without personal data", async () => {
        process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR = "3";
        const emails = await addAccounts(6);
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        const answers = [];
        for (const email of emails) {
          answers.push(await requestLoginCodeAction(null, emailForm(email)));
        }

        expect(emailState.sendEmail).toHaveBeenCalledTimes(3);
        expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(
          new Set([JSON.stringify({ sent: true })]),
        );
        expect(logged).toHaveBeenCalledTimes(1);
        const line = JSON.stringify(logged.mock.calls);
        expect(line).toMatch(/cap/i);
        for (const email of emails) expect(line).not.toContain(email);
        logged.mockRestore();
      });

      it("counts an address with no account against the cap too, so the cap says nothing about who has one", async () => {
        process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR = "2";
        const [first] = await addAccounts(1);
        await requestLoginCodeAction(null, emailForm("ghost1@local.test"));
        await requestLoginCodeAction(null, emailForm("ghost2@local.test"));
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        await requestLoginCodeAction(null, emailForm(first!));
        logged.mockRestore();

        expect(emailState.sendEmail).not.toHaveBeenCalled();
      });

      it("reads the cap before charging the address's own buckets, so asks refused for it cost the owner nothing", async () => {
        process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR = "2";
        process.env.OVERCLICK_TRUSTED_PROXY = "1";
        requestState.headers = { "x-forwarded-for": "198.51.100.7" };
        const [a, b] = await addAccounts(2);
        await requestLoginCodeAction(null, emailForm(a!));
        await requestLoginCodeAction(null, emailForm(b!));
        const spent = await world.db.select().from(loginCodeRequest);
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        const answers = [];
        for (let i = 0; i < 6; i++) {
          at((i + 1) * 2 * MINUTE);
          answers.push(await requestLoginCodeAction(null, emailForm(EMAIL)));
        }
        logged.mockRestore();

        expect(answers).toEqual(Array(6).fill({ sent: true }));
        expect(emailState.sendEmail).toHaveBeenCalledTimes(2);
        const rows = await world.db.select().from(loginCodeRequest);
        expect(rows.map((row) => row.id)).not.toContain(`code-minute-email:${EMAIL}`);
        expect(rows.map((row) => row.id)).not.toContain(`code-hour-email:${EMAIL}`);
        const origin = (list: typeof rows) =>
          list.find((row) => row.id === "code-hour-origin:198.51.100.7")?.count;
        expect(origin(rows)).toBe(origin(spent));
      });

      it("opens again in the next hour", async () => {
        process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR = "1";
        const [a, b] = await addAccounts(2);
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        await requestLoginCodeAction(null, emailForm(a!));
        await requestLoginCodeAction(null, emailForm(b!));
        expect(emailState.sendEmail).toHaveBeenCalledTimes(1);

        at(61 * MINUTE);
        await requestLoginCodeAction(null, emailForm(b!));
        expect(emailState.sendEmail).toHaveBeenCalledTimes(2);
        logged.mockRestore();
      });
    });

    it("fails in a controlled way, the same for everyone, when email is not configured", async () => {
      emailState.configured = false;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      const real = await requestLoginCodeAction(null, emailForm(EMAIL));
      const ghost = await requestLoginCodeAction(null, emailForm("ghost@local.test"));

      expect(real && "error" in real ? real.error : "").toBeTruthy();
      expect(ghost).toEqual(real);
      expect(emailState.sendEmail).not.toHaveBeenCalled();
      expect(await world.db.select().from(loginCode)).toHaveLength(0);
      expect(logged).toHaveBeenCalled();
      expect(JSON.stringify(logged.mock.calls)).not.toContain(EMAIL);
      logged.mockRestore();
    });

    it("refuses an address that is not an email without sending anything", async () => {
      const answer = await requestLoginCodeAction(null, emailForm("not-an-email"));
      expect(answer && "error" in answer ? answer.error : "").toBeTruthy();
      expect(emailState.sendEmail).not.toHaveBeenCalled();
    });
  });

  describe("entering the code", () => {
    it("signs in with the exact cookie setSession writes for the account", async () => {
      await setSession({ userId, sessionVersion: 1 });
      expect(requestState.cookieSet).toHaveBeenCalledTimes(1);
      const sessionCookie = requestState.cookieSet.mock.calls[0];

      await requestLoginCodeAction(null, emailForm(EMAIL));
      await loginWithCodeAction(null, codeForm(EMAIL, lastSentCode()));

      expect(redirectSpy).toHaveBeenLastCalledWith("/home");
      expect(requestState.cookieSet).toHaveBeenCalledTimes(2);
      const codeCookie = requestState.cookieSet.mock.calls[1];
      expect(codeCookie?.[0]).toBe(SESSION_COOKIE);
      // Same clock, same user, same session version: the signed token and
      // every cookie option are byte for byte the ones every session gets.
      expect(codeCookie).toEqual(sessionCookie);
    });

    it("answers a wrong code, an unknown address and a malformed code with the same words, and sets no cookie", async () => {
      await requestLoginCodeAction(null, emailForm(EMAIL));
      const code = lastSentCode();
      const wrong = code === "000000" ? "111111" : "000000";

      const answers = await Promise.all([
        loginWithCodeAction(null, codeForm(EMAIL, wrong)),
        loginWithCodeAction(null, codeForm("ghost@local.test", code)),
        loginWithCodeAction(null, codeForm(EMAIL, "12ab")),
      ]);

      for (const answer of answers) expect(answer?.error).toBeTruthy();
      expect(new Set(answers.map((answer) => answer?.error)).size).toBe(1);
      expect(requestState.cookieSet).not.toHaveBeenCalled();
      expect(redirectSpy).not.toHaveBeenCalled();
    });

    it("refuses a valid code once the account is switched off", async () => {
      await requestLoginCodeAction(null, emailForm(EMAIL));
      const code = lastSentCode();
      await world.db.update(user).set({ active: false }).where(eq(user.id, userId));

      const answer = await loginWithCodeAction(null, codeForm(EMAIL, code));
      expect(answer?.error).toBeTruthy();
      expect(requestState.cookieSet).not.toHaveBeenCalled();
    });

    it("zeroes the account's wrong-guess count on a sign-in that works, so old mistakes do not add up to a lock", async () => {
      const { issueLoginCode } = await import("../lib/login-code");
      const issued = await issueLoginCode(world.db, EMAIL);
      for (let i = 0; i < 4; i++) await loginWithCodeAction(null, codeForm(EMAIL, issued!.code === "000000" ? "111111" : "000000"));
      const [before] = await world.db
        .select()
        .from(loginFailure)
        .where(eq(loginFailure.id, `logincode-user:${userId}`));
      expect(before!.count).toBe(4);

      await loginWithCodeAction(null, codeForm(EMAIL, issued!.code));
      expect(redirectSpy).toHaveBeenCalledWith("/home");
      expect(
        await world.db.select().from(loginFailure).where(eq(loginFailure.id, `logincode-user:${userId}`)),
      ).toHaveLength(0);
    });

    it("refuses the code a second time", async () => {
      await requestLoginCodeAction(null, emailForm(EMAIL));
      const code = lastSentCode();

      await loginWithCodeAction(null, codeForm(EMAIL, code));
      expect(redirectSpy).toHaveBeenCalledWith("/home");

      const again = await loginWithCodeAction(null, codeForm(EMAIL, code));
      expect(again?.error).toBeTruthy();
      expect(requestState.cookieSet).toHaveBeenCalledTimes(1);
    });

    it("refuses the code after ten minutes", async () => {
      await requestLoginCodeAction(null, emailForm(EMAIL));
      const code = lastSentCode();

      at(10 * MINUTE + 1000);
      const answer = await loginWithCodeAction(null, codeForm(EMAIL, code));
      expect(answer?.error).toBeTruthy();
      expect(requestState.cookieSet).not.toHaveBeenCalled();
    });
  });

  describe("what a stranger can make the database keep", () => {
    const LONG = `${"a".repeat(300)}@local.test`;

    it("creates no row at all for an address over 254 characters, asking or entering", async () => {
      const asked = await requestLoginCodeAction(null, emailForm(LONG));
      const entered = await loginWithCodeAction(null, codeForm(LONG, "123456"));

      expect(asked && "error" in asked ? asked.error : "").toBeTruthy();
      expect(entered?.error).toBeTruthy();
      expect(await world.db.select().from(loginCodeRequest)).toHaveLength(0);
      expect(await world.db.select().from(loginFailure)).toHaveLength(0);
      expect(emailState.sendEmail).not.toHaveBeenCalled();
    });

    it("stops creating per-address rows for asks from an origin that is over its own limit", async () => {
      process.env.OVERCLICK_TRUSTED_PROXY = "1";
      requestState.headers = { "x-forwarded-for": "198.51.100.7" };
      for (let i = 0; i < CODE_REQUESTS_PER_ORIGIN_HOUR; i++) {
        await requestLoginCodeAction(null, emailForm(`spent${i}@local.test`));
      }
      const rowsBefore = (await world.db.select().from(loginCodeRequest)).length;

      for (let i = 0; i < 10; i++) {
        await requestLoginCodeAction(null, emailForm(`flood${i}@local.test`));
      }

      expect(await world.db.select().from(loginCodeRequest)).toHaveLength(rowsBefore);
    });

    it("stops creating per-address rows for sign-ins from an origin that is over its own limit", async () => {
      process.env.OVERCLICK_TRUSTED_PROXY = "1";
      requestState.headers = { "x-forwarded-for": "198.51.100.7" };
      for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
        await loginWithCodeAction(null, codeForm(`spent${i}@local.test`, "123456"));
      }
      const rowsBefore = (await world.db.select().from(loginFailure)).length;

      for (let i = 0; i < 10; i++) {
        await loginWithCodeAction(null, codeForm(`flood${i}@local.test`, "123456"));
      }

      expect(await world.db.select().from(loginFailure)).toHaveLength(rowsBefore);
    });

    it("sweeps expired budget rows and used or expired codes as a side effect of an ask", async () => {
      const old = new Date(T0.getTime() - 25 * 60 * MINUTE);
      await world.db.insert(loginCodeRequest).values({
        id: "code-hour-email:old@local.test",
        count: 3,
        windowStartedAt: old,
      });
      await world.db.insert(loginFailure).values({
        id: "login-email:old@local.test",
        count: 3,
        windowStartedAt: old,
      });
      await world.db.insert(loginCode).values({
        userId,
        codeHash: "0".repeat(64),
        expiresAt: new Date(T0.getTime() - MINUTE),
      });

      await requestLoginCodeAction(null, emailForm("other@local.test"));

      const requests = await world.db.select().from(loginCodeRequest);
      expect(requests.map((row) => row.id)).not.toContain("code-hour-email:old@local.test");
      const failures = await world.db.select().from(loginFailure);
      expect(failures.map((row) => row.id)).not.toContain("login-email:old@local.test");
      expect(await world.db.select().from(loginCode)).toHaveLength(0);
    });
  });

  describe("budgets", () => {
    async function originRows(): Promise<{ id: string; count: number }[]> {
      const rows = await world.db.select().from(loginFailure);
      return rows.filter((row) => row.id.includes("origin:198.51.100.7"));
    }

    describe("a sign-in that works is not charged to its origin", () => {
      beforeEach(() => {
        process.env.OVERCLICK_TRUSTED_PROXY = "1";
        requestState.headers = { "x-forwarded-for": "198.51.100.7" };
      });

      it("lets more than the failure budget of correct code sign-ins through from one origin", async () => {
        const { issueLoginCode } = await import("../lib/login-code");
        for (let i = 0; i < MAX_LOGIN_FAILURES + 4; i++) {
          at(i * 2 * MINUTE);
          const issued = await issueLoginCode(world.db, EMAIL);
          redirectSpy.mockClear();
          const answer = await loginWithCodeAction(null, codeForm(EMAIL, issued!.code));
          expect(answer?.error).toBeUndefined();
          expect(redirectSpy).toHaveBeenCalledWith("/home");
        }
        expect(await originRows()).toHaveLength(0);
      });

      it("locks an origin after as many wrong codes as the budget, for a correct one too", async () => {
        const { issueLoginCode } = await import("../lib/login-code");
        for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
          await loginWithCodeAction(null, codeForm(`ghost${i}@local.test`, "123456"));
        }
        const issued = await issueLoginCode(world.db, EMAIL);

        const refused = await loginWithCodeAction(null, codeForm(EMAIL, issued!.code));

        expect(refused?.error).toBeTruthy();
        expect(redirectSpy).not.toHaveBeenCalled();
        expect(requestState.cookieSet).not.toHaveBeenCalled();
      });
    });

    it("does not let a successful code sign-in wipe what its origin has spent", async () => {
      process.env.OVERCLICK_TRUSTED_PROXY = "1";
      requestState.headers = { "x-forwarded-for": "198.51.100.7" };
      for (let i = 0; i < 5; i++) {
        await loginWithCodeAction(null, codeForm(`ghost${i}@local.test`, "123456"));
      }
      const before = (await originRows()).reduce((sum, row) => sum + row.count, 0);
      expect(before).toBeGreaterThanOrEqual(5);

      await requestLoginCodeAction(null, emailForm(EMAIL));
      await loginWithCodeAction(null, codeForm(EMAIL, lastSentCode()));
      expect(redirectSpy).toHaveBeenLastCalledWith("/home");

      const after = (await originRows()).reduce((sum, row) => sum + row.count, 0);
      expect(after).toBeGreaterThanOrEqual(before);
    });

  });

  describe("the account is told when code sign-in locks", () => {
    /** `MAX_CODE_USER_FAILURES` wrong codes through the action, a fresh code every five. */
    async function lockThroughTheAction(email: string, startMs = 0) {
      const { issueLoginCode } = await import("../lib/login-code");
      for (let round = 0; round < MAX_CODE_USER_FAILURES / 5; round++) {
        at(startMs + round * 2 * MINUTE);
        const issued = await issueLoginCode(world.db, email);
        const guess = issued ? (issued.code === "000000" ? "111111" : "000000") : "000000";
        for (let i = 0; i < 5; i++) {
          // A new minute each time, so the address's own 8-per-15-minutes
          // budget is not what stops the guessing.
          await world.db.delete(loginFailure).where(eq(loginFailure.id, `logincode-email:${email}`));
          await loginWithCodeAction(null, codeForm(email, guess));
        }
      }
      await runAfter();
    }

    function lockNotices(email: string) {
      return emailState.sendEmail.mock.calls.filter(
        ([message]) => message.to === email && /travad/.test(message.subject),
      );
    }

    it("emails the account once when the lock starts, never the code, and only after the response", async () => {
      await lockThroughTheAction(EMAIL);

      const notices = lockNotices(EMAIL);
      expect(notices).toHaveLength(1);
      const [message] = notices[0]!;
      expect(message.text).toContain("1 hora");
      expect(message.text).not.toMatch(/\b\d{6}\b/);
    });

    it("sends no second notice for guesses made while the same lock holds", async () => {
      await lockThroughTheAction(EMAIL);
      at(10 * MINUTE);
      for (let i = 0; i < 5; i++) await loginWithCodeAction(null, codeForm(EMAIL, "000000"));
      await runAfter();

      expect(lockNotices(EMAIL)).toHaveLength(1);
    });

    it("sends a new notice for a new lock once the hour is over, but not for a single miss after it", async () => {
      await lockThroughTheAction(EMAIL);
      at(65 * MINUTE);
      const { issueLoginCode } = await import("../lib/login-code");
      const issued = await issueLoginCode(world.db, EMAIL);
      await loginWithCodeAction(
        null,
        codeForm(EMAIL, issued!.code === "000000" ? "111111" : "000000"),
      );
      await runAfter();
      expect(lockNotices(EMAIL)).toHaveLength(1);

      await lockThroughTheAction(EMAIL, 70 * MINUTE);
      expect(lockNotices(EMAIL)).toHaveLength(2);
    });

    it("counts the notice in the hourly send cap, and sends none once the cap is spent", async () => {
      process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR = "5";
      await world.db
        .insert(loginCodeRequest)
        .values({ id: "code-hour-global:all", count: 4, windowStartedAt: new Date(T0.getTime()) });
      await lockThroughTheAction(EMAIL);

      expect(lockNotices(EMAIL)).toHaveLength(1);
      const [global] = await world.db
        .select()
        .from(loginCodeRequest)
        .where(eq(loginCodeRequest.id, "code-hour-global:all"));
      expect(global!.count).toBe(5);
    });

    it("drops the notice when the hourly cap is already spent, without throwing", async () => {
      process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR = "5";
      await world.db
        .insert(loginCodeRequest)
        .values({ id: "code-hour-global:all", count: 5, windowStartedAt: new Date(T0.getTime()) });
      await lockThroughTheAction(EMAIL);

      expect(lockNotices(EMAIL)).toHaveLength(0);
    });

    it("sends nothing for an address with no account, however many wrong codes it gets", async () => {
      for (let i = 0; i < 12; i++) {
        await loginWithCodeAction(null, codeForm("ghost@local.test", "000000"));
      }
      await runAfter();

      expect(emailState.sendEmail).not.toHaveBeenCalled();
    });
  });

  it("answers a locked account's right code the same generic way as a wrong one", async () => {
    const { redeemLoginCode, issueLoginCode } = await import("../lib/login-code");
    const wrong = "000000";
    for (let round = 0; round < MAX_CODE_USER_FAILURES / 5; round++) {
      at(round * 2 * MINUTE);
      const issued = await issueLoginCode(world.db, EMAIL);
      const guess = issued!.code === wrong ? "111111" : wrong;
      for (let i = 0; i < 5; i++) await redeemLoginCode(world.db, EMAIL, guess);
    }

    at(5 * MINUTE);
    await requestLoginCodeAction(null, emailForm(EMAIL));
    const refused = await loginWithCodeAction(null, codeForm(EMAIL, lastSentCode()));
    const wrongCodeAnswer = await loginWithCodeAction(null, codeForm("ghost@local.test", wrong));
    expect(refused?.error).toBeTruthy();
    expect(refused).toEqual(wrongCodeAnswer);
    expect(requestState.cookieSet).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});
