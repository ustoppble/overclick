import { loginCode, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { MAX_CODE_USER_FAILURES } from "./login-rate-limit";
import {
  LOGIN_CODE_TTL_MS,
  MAX_LOGIN_CODE_ATTEMPTS,
  generateLoginCode,
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

    it("stays locked for a day from the tenth guess, then opens", async () => {
      await guess(0, 5);
      await guess(2 * MINUTE, 5);

      // A day after the FIRST guess is still inside a day after the tenth.
      const early = await issueLoginCode(world.db, EMAIL, at(24 * HOUR + MINUTE));
      expect(
        await redeemLoginCode(world.db, EMAIL, early!.code, at(24 * HOUR + MINUTE + 1000)),
      ).toBeNull();

      const later = await issueLoginCode(world.db, EMAIL, at(24 * HOUR + 5 * MINUTE));
      expect(
        await redeemLoginCode(world.db, EMAIL, later!.code, at(24 * HOUR + 5 * MINUTE + 1000)),
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
