import { loginCode, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODE_REQUESTS_PER_HOUR,
  CODE_REQUESTS_PER_ORIGIN_HOUR,
  DEFAULT_LOGIN_CODE_MAX_SENDS_PER_HOUR,
  loginCodeSendCap,
} from "../lib/login-rate-limit";
import { hashPassword } from "../lib/password";
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

const { loginAction, loginWithCodeAction, requestLoginCodeAction } = await import(
  "./auth"
);

const PASSWORD = "correct-horse-battery";
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

function passwordForm(email: string, password: string): FormData {
  const form = new FormData();
  form.set("email", email);
  form.set("password", password);
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
    const passwordHash = await hashPassword(PASSWORD);
    const [row] = await world.db
      .insert(user)
      .values([
        { email: EMAIL, passwordHash },
        { email: "off@local.test", passwordHash, active: false },
      ])
      .returning({ id: user.id });
    userId = row!.id;
    emailState.configured = true;
    emailState.sendEmail.mockClear();
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
        await world.db.insert(user).values({ email, passwordHash: "x" });
      }

      for (const email of emails) {
        await requestLoginCodeAction(null, emailForm(email));
      }
      expect(emailState.sendEmail).toHaveBeenCalledTimes(CODE_REQUESTS_PER_ORIGIN_HOUR);
    });

    describe("the global hourly send cap", () => {
      async function addAccounts(count: number): Promise<string[]> {
        const emails = Array.from({ length: count }, (_, i) => `g${i}@local.test`);
        for (const email of emails) {
          await world.db.insert(user).values({ email, passwordHash: "x" });
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
    it("signs in with the exact same cookie the password sign-in sets", async () => {
      await loginAction(null, passwordForm(EMAIL, PASSWORD));
      expect(redirectSpy).toHaveBeenLastCalledWith("/home");
      expect(requestState.cookieSet).toHaveBeenCalledTimes(1);
      const passwordCookie = requestState.cookieSet.mock.calls[0];

      await requestLoginCodeAction(null, emailForm(EMAIL));
      await loginWithCodeAction(null, codeForm(EMAIL, lastSentCode()));

      expect(redirectSpy).toHaveBeenLastCalledWith("/home");
      expect(requestState.cookieSet).toHaveBeenCalledTimes(2);
      const codeCookie = requestState.cookieSet.mock.calls[1];
      expect(codeCookie?.[0]).toBe(SESSION_COOKIE);
      // Same clock, same user, same session version: the signed token and
      // every cookie option are byte for byte the password sign-in's.
      expect(codeCookie).toEqual(passwordCookie);
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

  it("keeps the password sign-in working", async () => {
    const wrong = await loginAction(null, passwordForm(EMAIL, "not-the-password"));
    expect(wrong?.error).toBeTruthy();

    await loginAction(null, passwordForm(EMAIL, PASSWORD));
    expect(redirectSpy).toHaveBeenCalledWith("/home");
    expect(requestState.cookieSet).toHaveBeenCalledTimes(1);
  });
});
