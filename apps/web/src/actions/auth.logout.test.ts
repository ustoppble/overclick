import { TEST_AUTH_SECRET } from "../test-support/auth-secret";
import { loginCode, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSession } from "../lib/cookies";
import { issueLoginCode } from "../lib/login-code";
import { SESSION_COOKIE, signSession } from "../lib/session";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

let world: TestWorld;

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

// A browser's cookie jar: what `set`/`delete` do is kept, so a test can copy a
// cookie out before the logout and put it back after, as a thief would.
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.values.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      jar.values.set(name, value);
    },
    delete: (name: string) => {
      jar.values.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("next/server", () => ({ after: () => undefined }));

const { logoutAction } = await import("./auth");

async function logout(): Promise<void> {
  await expect(logoutAction()).rejects.toThrow("NEXT_REDIRECT:/login");
}

describe("logging out revokes the session, not just the cookie", () => {
  let userId = "";

  beforeEach(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    world = await createTestWorld();
    const [row] = await world.db
      .insert(user)
      .values({ email: "owner@local.test", role: "admin" })
      .returning({ id: user.id, sessionVersion: user.sessionVersion });
    userId = row!.id;
    jar.values.clear();
    jar.values.set(
      SESSION_COOKIE,
      await signSession({ userId, sessionVersion: row!.sessionVersion }),
    );
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
  });

  it("refuses a cookie copied before the logout", async () => {
    const copied = jar.values.get(SESSION_COOKIE)!;
    expect(await getSession()).not.toBeNull();

    await logout();

    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
    jar.values.set(SESSION_COOKIE, copied);
    expect(await getSession()).toBeNull();
  });

  it("lets the same person sign in again afterwards with the new version", async () => {
    await logout();
    const [row] = await world.db.select().from(user).where(eq(user.id, userId));
    jar.values.set(
      SESSION_COOKIE,
      await signSession({ userId, sessionVersion: row!.sessionVersion }),
    );
    expect(await getSession()).toMatchObject({ userId, email: "owner@local.test" });
  });

  it("drops the sign-in codes still waiting for the account", async () => {
    await issueLoginCode(world.db, "owner@local.test");
    expect(await world.db.select().from(loginCode).where(eq(loginCode.userId, userId))).toHaveLength(1);

    await logout();

    expect(await world.db.select().from(loginCode).where(eq(loginCode.userId, userId))).toHaveLength(0);
  });

  it("does not bump anyone's version from a cookie that is no longer current", async () => {
    // A stale copy of the cookie (older version) cannot be used to sign the
    // real, current session out.
    await world.db.update(user).set({ sessionVersion: 5 }).where(eq(user.id, userId));
    const [before] = await world.db.select().from(user).where(eq(user.id, userId));
    jar.values.set(SESSION_COOKIE, await signSession({ userId, sessionVersion: 1 }));

    await logout();

    const [after] = await world.db.select().from(user).where(eq(user.id, userId));
    expect(after!.sessionVersion).toBe(before!.sessionVersion);
  });

  it("still clears the cookie and redirects with no session at all", async () => {
    jar.values.clear();
    await logout();
    expect(jar.values.size).toBe(0);
  });
});
