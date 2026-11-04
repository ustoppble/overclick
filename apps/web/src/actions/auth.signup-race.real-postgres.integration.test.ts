import { user } from "@agent-board/db";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSignupCode, setupScope } from "../lib/signup-code";
import { createRealPostgresWorld, type RealPostgresWorld } from "../mcp/test-db-postgres";

let world: (RealPostgresWorld & { close: () => Promise<void> }) | undefined;

vi.mock("../lib/db", () => ({
  db: () => world!.db,
  getDatabaseUrl: () => "postgres://test",
}));

vi.mock("../lib/email", () => ({
  emailConfigured: () => true,
  sendEmail: async () => true,
}));

const sessions = vi.hoisted(() => [] as Array<{ userId: string }>);
vi.mock("../lib/cookies", () => ({
  setSession: async (payload: { userId: string }) => {
    sessions.push(payload);
  },
  clearSession: async () => {},
}));

vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { signupAction } = await import("./auth");

function signup(email: string, code: string) {
  const form = new FormData();
  form.set("email", email);
  form.set("code", code);
  return signupAction(null, form);
}

/**
 * Two people finish setup at the same moment, each with a code that is right
 * for their own address. The count of accounts is read before either account
 * exists, so without one transaction around "is the instance empty" and "make
 * the admin" both pass and the instance has two admins. PGlite runs one
 * transaction at a time, so only a real server can race them.
 *
 * Skipped without DATABASE_URL, like the other real-Postgres suites.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "first-admin setup race against real postgres-js",
  () => {
    beforeAll(async () => {
      process.env.AUTH_SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");
      world = await createRealPostgresWorld();
    }, 60_000);

    afterAll(async () => {
      await world?.close();
    });

    beforeEach(async () => {
      await world!.db.delete(user);
      sessions.length = 0;
    });

    it("creates one admin when two setups with different addresses finish together", async () => {
      const emails = ["a@race.test", "b@race.test", "c@race.test", "d@race.test"];
      const codes = new Map<string, string>();
      for (const email of emails) {
        const issued = await issueSignupCode(world!.db, setupScope(email), email);
        codes.set(email, issued!.code);
      }

      // Open the pool's connections first: a fresh one takes longer to come up
      // than a whole signup takes to commit, and the race never happens.
      const raw = world!.db as unknown as { execute(query: SQL): Promise<unknown> };
      await Promise.all(emails.map(() => raw.execute(sql`select pg_sleep(0.05)`)));

      const results = await Promise.all(emails.map((email) => signup(email, codes.get(email)!)));

      const admins = await world!.db.select().from(user);
      expect(admins).toHaveLength(1);
      expect(admins[0]?.role).toBe("admin");
      // One signed in; the others were told an admin exists, not a 500.
      expect(sessions).toHaveLength(1);
      expect(results.filter((r) => r && "error" in r)).toHaveLength(emails.length - 1);
    }, 60_000);
  },
);
