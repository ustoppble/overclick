import { TEST_AUTH_SECRET } from "../test-support/auth-secret";
import { mcpToken, user } from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const sessions = vi.hoisted(() => [] as Array<{ userId: string; sessionVersion: number }>);
vi.mock("../lib/cookies", () => ({
  setSession: async (payload: { userId: string; sessionVersion: number }) => {
    sessions.push(payload);
  },
  clearSession: async () => {},
}));

const redirectSpy = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectSpy(url),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const afterState = vi.hoisted(() => ({ queued: [] as Array<() => unknown> }));
vi.mock("next/server", () => ({
  after: (callback: () => unknown) => {
    afterState.queued.push(callback);
  },
}));

const actions = await import("./auth");

async function requestSetupCode(email: string) {
  const form = new FormData();
  form.set("email", email);
  const answer = await actions.requestSetupCodeAction(null, form);
  while (afterState.queued.length > 0) await afterState.queued.shift()!();
  return answer;
}

function signup(email: string, code: string) {
  const form = new FormData();
  form.set("email", email);
  form.set("code", code);
  return actions.signupAction(null, form);
}

function lastCodeSentTo(email: string): string {
  const message = emailState.sendEmail.mock.calls.filter(([m]) => m.to === email).at(-1)?.[0];
  const match = message?.text.match(/\b(\d{6})\b/);
  if (!match) throw new Error("no code was sent");
  return match[1]!;
}

/**
 * The first admin proves the address before the account exists: setup asks
 * for the email, sends a code to it, and only the code creates the admin. No
 * password is asked for or stored.
 */
describe("setting up the first admin", () => {
  beforeEach(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    world = await createTestWorld();
    // A fresh instance: nobody has an account yet.
    await world.db.delete(mcpToken);
    await world.db.delete(user);
    emailState.configured = true;
    emailState.sendEmail.mockClear();
    afterState.queued.length = 0;
    sessions.length = 0;
    redirectSpy.mockClear();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
  });

  it("emails a code to the address and creates nothing yet", async () => {
    expect(await requestSetupCode("Owner@Local.test")).toEqual({ sent: true });

    expect(emailState.sendEmail).toHaveBeenCalledTimes(1);
    expect(lastCodeSentTo("owner@local.test")).toMatch(/^\d{6}$/);
    expect(await world.db.select().from(user)).toHaveLength(0);
  });

  it("creates the admin with no password once the code is right, signs them in and sends them on", async () => {
    await requestSetupCode("owner@local.test");
    await signup("owner@local.test", lastCodeSentTo("owner@local.test"));

    const [admin] = await world.db.select().from(user);
    expect(admin?.email).toBe("owner@local.test");
    expect(admin?.role).toBe("admin");
    expect(admin?.passwordHash).toBeNull();
    expect(sessions).toEqual([{ userId: admin!.id, sessionVersion: admin!.sessionVersion }]);
    expect(redirectSpy).toHaveBeenCalledWith("/onboarding");
  });

  it("creates nobody for a wrong code, or for a code sent to another address", async () => {
    await requestSetupCode("owner@local.test");
    const code = lastCodeSentTo("owner@local.test");

    expect(await signup("owner@local.test", code === "000000" ? "111111" : "000000")).toEqual({
      error: expect.any(String),
    });
    expect(await signup("intruder@local.test", code)).toEqual({ error: expect.any(String) });
    expect(await world.db.select().from(user)).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it("takes no password: a form with one and no code creates nobody", async () => {
    const form = new FormData();
    form.set("email", "owner@local.test");
    form.set("password", "s3cret-pass");
    form.set("confirm", "s3cret-pass");

    expect(await actions.signupAction(null, form)).toEqual({ error: expect.any(String) });
    expect(await world.db.select().from(user)).toHaveLength(0);
  });

  it("says it is unavailable, sends nothing and creates nobody when email is not configured", async () => {
    emailState.configured = false;

    expect(await requestSetupCode("owner@local.test")).toEqual({
      error: "Sign-in unavailable: email is not configured.",
    });
    expect(emailState.sendEmail).not.toHaveBeenCalled();
  });

  it("closes both steps once an admin exists", async () => {
    await requestSetupCode("owner@local.test");
    await signup("owner@local.test", lastCodeSentTo("owner@local.test"));
    emailState.sendEmail.mockClear();

    expect(await requestSetupCode("intruder@local.test")).toEqual({ error: expect.any(String) });
    expect(emailState.sendEmail).not.toHaveBeenCalled();
    expect(await signup("intruder@local.test", "123456")).toEqual({ error: expect.any(String) });
    expect(await world.db.select().from(user)).toHaveLength(1);
  });
});
