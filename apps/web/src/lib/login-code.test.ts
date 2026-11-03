import { createHmac, hkdfSync } from "node:crypto";
import { loginCode, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@agent-board/db/schema";
import type { McpDatabase } from "../mcp/types";
import { setMemberActive } from "./invitations";
import * as session from "./session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { MAX_CODE_USER_FAILURES } from "./login-rate-limit";
import {
  LOGIN_CODE_TTL_MS,
  MAX_LOGIN_CODE_ATTEMPTS,
  clearLoginCodes,
  generateLoginCode,
  hashLoginCode,
  issueLoginCode,
  redeemLoginCode,
} from "./login-code";

let world: TestWorld;

const EMAIL = "person@local.test";
const T0 = new Date("2026-11-03T12:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

/** Any six digits that are not `code`, so a wrong guess is never accidentally right. */
function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe("login codes", () => {
  let userId: string;

  beforeEach(async () => {
    process.env.AUTH_SECRET = "s".repeat(32);
    world = await createTestWorld();
    const [row] = await world.db
      .insert(user)
      .values({ email: EMAIL, passwordHash: "x" })
      .returning({ id: user.id });
    userId = row!.id;
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
  });

  it("generates six digits", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateLoginCode()).toMatch(/^\d{6}$/);
    }
  });

  it("stores only a hash of the code, never the code itself", async () => {
    const issued = await issueLoginCode(world.db, EMAIL, T0);
    expect(issued).not.toBeNull();

    const rows = await world.db.select().from(loginCode);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userId);
    expect(rows[0]!.codeHash).not.toContain(issued!.code);
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.expiresAt.getTime()).toBe(T0.getTime() + LOGIN_CODE_TTL_MS);
  });

  it("redeems a fresh code for the account it was issued to", async () => {
    const issued = await issueLoginCode(world.db, EMAIL, T0);

    const redeemed = await redeemLoginCode(world.db, EMAIL, issued!.code, at(1000));
    expect(redeemed).toEqual({ userId });
  });

  it("redeems a code only once", async () => {
    const issued = await issueLoginCode(world.db, EMAIL, T0);

    expect(await redeemLoginCode(world.db, EMAIL, issued!.code, at(1000))).not.toBeNull();
    expect(await redeemLoginCode(world.db, EMAIL, issued!.code, at(2000))).toBeNull();
  });

  it("refuses a code once ten minutes have passed", async () => {
    const issued = await issueLoginCode(world.db, EMAIL, T0);

    expect(
      await redeemLoginCode(world.db, EMAIL, issued!.code, at(LOGIN_CODE_TTL_MS + 1)),
    ).toBeNull();
  });

  it("still takes a code one second before it expires", async () => {
    const issued = await issueLoginCode(world.db, EMAIL, T0);

    expect(
      await redeemLoginCode(world.db, EMAIL, issued!.code, at(LOGIN_CODE_TTL_MS - 1000)),
    ).not.toBeNull();
  });

  it("kills the code after five wrong attempts, even for the right code after", async () => {
    const issued = await issueLoginCode(world.db, EMAIL, T0);
    const wrong = wrongCode(issued!.code);

    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS; i++) {
      expect(await redeemLoginCode(world.db, EMAIL, wrong, at(1000))).toBeNull();
    }
    expect(await redeemLoginCode(world.db, EMAIL, issued!.code, at(2000))).toBeNull();
  });

  it("takes the right code after four wrong attempts", async () => {
    const issued = await issueLoginCode(world.db, EMAIL, T0);
    const wrong = wrongCode(issued!.code);

    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS - 1; i++) {
      expect(await redeemLoginCode(world.db, EMAIL, wrong, at(1000))).toBeNull();
    }
    expect(await redeemLoginCode(world.db, EMAIL, issued!.code, at(2000))).toEqual({
      userId,
    });
  });

  it("invalidates the previous code when a new one is issued", async () => {
    const first = await issueLoginCode(world.db, EMAIL, T0);
    // A minute on, the first code no longer protects itself from a new ask.
    let when = 61 * 1000;
    let second = await issueLoginCode(world.db, EMAIL, at(when));
    // Two draws can land on the same six digits; the old one is only provably
    // dead when it differs from the live one.
    while (second!.code === first!.code) {
      when += 61 * 1000;
      second = await issueLoginCode(world.db, EMAIL, at(when));
    }

    expect(await redeemLoginCode(world.db, EMAIL, first!.code, at(when + 1000))).toBeNull();
    expect(await redeemLoginCode(world.db, EMAIL, second!.code, at(when + 2000))).toEqual({
      userId,
    });
  });

  it("leaves a live code younger than a minute alone and issues nothing new", async () => {
    const first = await issueLoginCode(world.db, EMAIL, T0);

    expect(await issueLoginCode(world.db, EMAIL, at(30 * 1000))).toBeNull();

    expect(await world.db.select().from(loginCode)).toHaveLength(1);
    expect(await redeemLoginCode(world.db, EMAIL, first!.code, at(31 * 1000))).toEqual({
      userId,
    });
  });

  it("replaces a live code once it is a minute old", async () => {
    const first = await issueLoginCode(world.db, EMAIL, T0);
    let second = await issueLoginCode(world.db, EMAIL, at(61 * 1000));
    while (second && second.code === first!.code) {
      await world.db.delete(loginCode);
      second = await issueLoginCode(world.db, EMAIL, at(61 * 1000));
    }

    expect(second).not.toBeNull();
    expect(await world.db.select().from(loginCode)).toHaveLength(1);
  });

  it("replaces a young code that was used up, since nothing live is being protected", async () => {
    const first = await issueLoginCode(world.db, EMAIL, T0);
    await redeemLoginCode(world.db, EMAIL, first!.code, at(1000));

    expect(await issueLoginCode(world.db, EMAIL, at(5000))).not.toBeNull();
  });

  it("does not let one account's code open another account", async () => {
    await world.db.insert(user).values({ email: "other@local.test", passwordHash: "x" });
    const issued = await issueLoginCode(world.db, EMAIL, T0);

    expect(
      await redeemLoginCode(world.db, "other@local.test", issued!.code, at(1000)),
    ).toBeNull();
  });

  it("issues nothing for an address with no account", async () => {
    expect(await issueLoginCode(world.db, "ghost@local.test", T0)).toBeNull();
    expect(await world.db.select().from(loginCode)).toHaveLength(0);
  });

  it("issues nothing for an account that is switched off", async () => {
    await world.db.update(user).set({ active: false }).where(eq(user.id, userId));

    expect(await issueLoginCode(world.db, EMAIL, T0)).toBeNull();
    expect(await world.db.select().from(loginCode)).toHaveLength(0);
  });

  it("writes the code with its columns named beside their values, never positionally from a select", async () => {
    const statements: string[] = [];
    const logged = drizzle(world.client, {
      schema,
      logger: { logQuery: (query) => void statements.push(query) },
    }) as unknown as McpDatabase;

    const issued = await issueLoginCode(logged, EMAIL, T0);

    expect(issued).not.toBeNull();
    const inserts = statements.filter((query) => /^insert into "login_code"/i.test(query));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatch(/^insert into "login_code" \("[^)]*\) values \(/i);
  });

  describe("the key that hashes codes", () => {
    const message = `ovk-login-code:${EMAIL}:123456`;

    it("is a subkey derived from AUTH_SECRET with HKDF and the info 'login-code', not the session key itself", () => {
      const secret = process.env.AUTH_SECRET!;
      const subkey = Buffer.from(hkdfSync("sha256", secret, "", "login-code", 32));
      const expected = createHmac("sha256", subkey).update(message, "utf8").digest("hex");
      const withSessionKey = createHmac("sha256", secret).update(message, "utf8").digest("hex");

      expect(hashLoginCode(EMAIL, "123456")).toBe(expected);
      expect(expected).not.toBe(withSessionKey);
    });

    it("changes with the secret", () => {
      const before = hashLoginCode(EMAIL, "123456");
      process.env.AUTH_SECRET = "t".repeat(32);
      expect(hashLoginCode(EMAIL, "123456")).not.toBe(before);
    });

    it("leaves the session key private to the session module", () => {
      expect(Object.keys(session)).not.toContain("secretKey");
    });
  });

  describe("a code does not outlive the state of the account it was sent for", () => {
    it("is gone when the member is switched off, and does not come back when they are switched on", async () => {
      const issued = await issueLoginCode(world.db, EMAIL, T0);

      const off = await setMemberActive(world.db, {
        targetUserId: userId,
        active: false,
        actingUserId: world.adminUserId,
      });
      expect(off).toEqual({ ok: true });
      expect(await world.db.select().from(loginCode)).toHaveLength(0);

      await setMemberActive(world.db, {
        targetUserId: userId,
        active: true,
        actingUserId: world.adminUserId,
      });
      expect(await redeemLoginCode(world.db, EMAIL, issued!.code, at(1000))).toBeNull();
    });

    it("leaves other accounts' codes alone", async () => {
      const [other] = await world.db
        .insert(user)
        .values({ email: "other@local.test", passwordHash: "x" })
        .returning({ id: user.id });
      await issueLoginCode(world.db, "other@local.test", T0);

      await setMemberActive(world.db, {
        targetUserId: userId,
        active: false,
        actingUserId: world.adminUserId,
      });

      const rows = await world.db.select().from(loginCode);
      expect(rows.map((row) => row.userId)).toEqual([other!.id]);
    });

    it("is gone through clearLoginCodes, for any path that changes a password or the session version", async () => {
      await issueLoginCode(world.db, EMAIL, T0);
      await clearLoginCodes(world.db, userId);
      expect(await world.db.select().from(loginCode)).toHaveLength(0);
    });
  });

  describe("one live code per account, enforced by the database", () => {
    const row = (overrides: Partial<typeof loginCode.$inferInsert> = {}) => ({
      userId,
      codeHash: "0".repeat(64),
      expiresAt: at(LOGIN_CODE_TTL_MS),
      ...overrides,
    });

    it("refuses a second unused code for the same account", async () => {
      await world.db.insert(loginCode).values(row());

      await expect(world.db.insert(loginCode).values(row())).rejects.toThrow();
    });

    it("lets a used code sit beside a live one, and any number of used ones", async () => {
      await world.db.insert(loginCode).values(row({ consumedAt: at(1000) }));
      await world.db.insert(loginCode).values(row({ consumedAt: at(2000) }));
      await world.db.insert(loginCode).values(row());

      expect(await world.db.select().from(loginCode)).toHaveLength(3);
    });

    it("lets two accounts each have a live code", async () => {
      const [other] = await world.db
        .insert(user)
        .values({ email: "other@local.test", passwordHash: "x" })
        .returning({ id: user.id });
      await world.db.insert(loginCode).values(row());
      await world.db.insert(loginCode).values(row({ userId: other!.id }));

      expect(await world.db.select().from(loginCode)).toHaveLength(2);
    });

    it("leaves exactly one live code when two asks race", async () => {
      const results = await Promise.all([
        issueLoginCode(world.db, EMAIL, T0),
        issueLoginCode(world.db, EMAIL, T0),
      ]);

      expect(results.filter(Boolean).length).toBeLessThanOrEqual(2);
      expect(await world.db.select().from(loginCode)).toHaveLength(1);
    });
  });

  describe("wrong guesses across new codes", () => {
    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;

    /** Issues a fresh code at `when` and burns `wrongs` guesses on it. */
    async function guess(when: number, wrongs: number) {
      const issued = await issueLoginCode(world.db, EMAIL, at(when));
      for (let i = 0; i < wrongs; i++) {
        await redeemLoginCode(world.db, EMAIL, wrongCode(issued!.code), at(when + 1000));
      }
      return issued;
    }

    it("locks code sign-in for the account after ten wrong guesses in a day, even for the right code", async () => {
      await guess(0, 5);
      await guess(2 * MINUTE, MAX_CODE_USER_FAILURES - 5);
      const fresh = await issueLoginCode(world.db, EMAIL, at(4 * MINUTE));

      expect(await redeemLoginCode(world.db, EMAIL, fresh!.code, at(4 * MINUTE + 1000))).toBeNull();
    });

    it("does not lock at nine wrong guesses", async () => {
      await guess(0, 5);
      await guess(2 * MINUTE, MAX_CODE_USER_FAILURES - 6);
      const fresh = await issueLoginCode(world.db, EMAIL, at(4 * MINUTE));

      expect(await redeemLoginCode(world.db, EMAIL, fresh!.code, at(4 * MINUTE + 1000))).toEqual({
        userId,
      });
    });

    it("keeps counting when a new code is issued instead of starting over", async () => {
      // Two guesses per code, a new code each time: never five on one code.
      for (let i = 0; i < MAX_CODE_USER_FAILURES / 2; i++) {
        await guess(i * 2 * MINUTE, 2);
      }
      const fresh = await issueLoginCode(world.db, EMAIL, at(HOUR));

      expect(await redeemLoginCode(world.db, EMAIL, fresh!.code, at(HOUR + 1000))).toBeNull();
    });

    it("stays locked for an hour from the tenth guess, then opens", async () => {
      await guess(0, 5);
      await guess(2 * MINUTE, 5);

      // An hour after the FIRST guess is still inside an hour after the tenth.
      const early = await issueLoginCode(world.db, EMAIL, at(HOUR + MINUTE));
      expect(
        await redeemLoginCode(world.db, EMAIL, early!.code, at(HOUR + MINUTE + 1000)),
      ).toBeNull();

      const later = await issueLoginCode(world.db, EMAIL, at(HOUR + 5 * MINUTE));
      expect(
        await redeemLoginCode(world.db, EMAIL, later!.code, at(HOUR + 5 * MINUTE + 1000)),
      ).toEqual({ userId });
    });

    it("locks for another hour at the next wrong guess inside the day, instead of handing out ten more", async () => {
      await guess(0, 5);
      await guess(2 * MINUTE, 5);

      // The hour is over; one wrong guess shuts it again.
      await guess(HOUR + 5 * MINUTE, 1);
      const relocked = await issueLoginCode(world.db, EMAIL, at(HOUR + 7 * MINUTE));
      expect(
        await redeemLoginCode(world.db, EMAIL, relocked!.code, at(HOUR + 7 * MINUTE + 1000)),
      ).toBeNull();

      const open = await issueLoginCode(world.db, EMAIL, at(2 * HOUR + 10 * MINUTE));
      expect(
        await redeemLoginCode(world.db, EMAIL, open!.code, at(2 * HOUR + 10 * MINUTE + 1000)),
      ).toEqual({ userId });
    });

    it("does not count guesses made while it is locked, so they cannot stretch the hour", async () => {
      await guess(0, 5);
      await guess(2 * MINUTE, 5);
      // Every one of these lands while the lock holds.
      for (let i = 0; i < 5; i++) await guess(10 * MINUTE + i * 2 * MINUTE, 5);

      const open = await issueLoginCode(world.db, EMAIL, at(HOUR + 5 * MINUTE));
      expect(
        await redeemLoginCode(world.db, EMAIL, open!.code, at(HOUR + 5 * MINUTE + 1000)),
      ).toEqual({ userId });
    });

    it("is per account: another account's codes still work", async () => {
      await guess(0, 5);
      await guess(2 * MINUTE, 5);
      const [other] = await world.db
        .insert(user)
        .values({ email: "other@local.test", passwordHash: "x" })
        .returning({ id: user.id });
      const issued = await issueLoginCode(world.db, "other@local.test", at(4 * MINUTE));

      expect(
        await redeemLoginCode(world.db, "other@local.test", issued!.code, at(4 * MINUTE + 1000)),
      ).toEqual({ userId: other!.id });
    });
  });
});
