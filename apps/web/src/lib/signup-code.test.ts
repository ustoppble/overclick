import { createHmac, hkdfSync } from "node:crypto";
import { signupCode } from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { sweepLoginRows } from "./login-housekeeping";
import { MAX_CODE_USER_FAILURES } from "./login-rate-limit";
import {
  SIGNUP_CODE_TTL_MS,
  inviteScope,
  issueSignupCode,
  redeemSignupCode,
  setupScope,
  signupCodeEmail,
} from "./signup-code";

let world: TestWorld;

const EMAIL = "new@local.test";
const T0 = new Date("2026-11-03T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

/**
 * The code that proves an address before any account exists for it: the
 * first admin's at setup and an invited member's at the invite link. Same
 * rules as the sign-in code — hashed, ten minutes, five tries, once — but
 * bound to what it was sent for, not to an account.
 */
describe("signup codes", () => {
  const SCOPE = setupScope(EMAIL);

  beforeEach(async () => {
    process.env.AUTH_SECRET = "s".repeat(32);
    world = await createTestWorld();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    delete process.env.AUTH_SECRET;
  });

  it("stores only a keyed hash of the code, bound to its scope and address", async () => {
    const issued = await issueSignupCode(world.db, SCOPE, EMAIL, at(0));
    expect(issued?.code).toMatch(/^\d{6}$/);

    const [row] = await world.db.select().from(signupCode);
    expect(row?.codeHash).not.toContain(issued!.code);
    const key = Buffer.from(hkdfSync("sha256", "s".repeat(32), "", "login-code", 32));
    expect(row?.codeHash).toBe(
      createHmac("sha256", key)
        .update(`ovk-signup-code:${SCOPE}:${EMAIL}:${issued!.code}`, "utf8")
        .digest("hex"),
    );
    expect(row?.email).toBe(EMAIL);
  });

  it("takes the right code once, and never again", async () => {
    const issued = await issueSignupCode(world.db, SCOPE, EMAIL, at(0));

    expect(await redeemSignupCode(world.db, SCOPE, EMAIL, issued!.code, at(1000))).toBe(true);
    expect(await redeemSignupCode(world.db, SCOPE, EMAIL, issued!.code, at(2000))).toBe(false);
  });

  it("refuses a code once ten minutes have passed", async () => {
    const issued = await issueSignupCode(world.db, SCOPE, EMAIL, at(0));

    expect(
      await redeemSignupCode(world.db, SCOPE, EMAIL, issued!.code, at(SIGNUP_CODE_TTL_MS + 1)),
    ).toBe(false);
  });

  it("kills the code after five wrong attempts, even for the right code after", async () => {
    const issued = await issueSignupCode(world.db, SCOPE, EMAIL, at(0));
    for (let i = 0; i < 5; i++) {
      expect(await redeemSignupCode(world.db, SCOPE, EMAIL, wrongCode(issued!.code), at(1000))).toBe(
        false,
      );
    }

    expect(await redeemSignupCode(world.db, SCOPE, EMAIL, issued!.code, at(2000))).toBe(false);
  });

  it("does not let a code sent for one scope or address prove another", async () => {
    const other = inviteScope("00000000-0000-0000-0000-0000000000aa");
    const issued = await issueSignupCode(world.db, SCOPE, EMAIL, at(0));

    expect(await redeemSignupCode(world.db, other, EMAIL, issued!.code, at(1000))).toBe(false);
    expect(
      await redeemSignupCode(world.db, SCOPE, "someone-else@local.test", issued!.code, at(1000)),
    ).toBe(false);
    expect(await redeemSignupCode(world.db, SCOPE, EMAIL, issued!.code, at(2000))).toBe(true);
  });

  it("keeps one live code per scope: a young one is left alone, an older one replaced", async () => {
    const first = await issueSignupCode(world.db, SCOPE, EMAIL, at(0));
    expect(await issueSignupCode(world.db, SCOPE, EMAIL, at(30 * 1000))).toBeNull();
    expect(await world.db.select().from(signupCode)).toHaveLength(1);

    const second = await issueSignupCode(world.db, SCOPE, EMAIL, at(2 * MINUTE));
    expect(second).not.toBeNull();
    expect(await redeemSignupCode(world.db, SCOPE, EMAIL, first!.code, at(2 * MINUTE + 1))).toBe(
      first!.code === second!.code,
    );
    expect(await redeemSignupCode(world.db, SCOPE, EMAIL, second!.code, at(3 * MINUTE))).toBe(true);
  });

  it("shuts the scope for an hour after ten wrong guesses across new codes, then opens", async () => {
    for (let round = 0; round < MAX_CODE_USER_FAILURES / 5; round++) {
      const issued = await issueSignupCode(world.db, SCOPE, EMAIL, at(round * 2 * MINUTE));
      for (let i = 0; i < 5; i++) {
        await redeemSignupCode(world.db, SCOPE, EMAIL, wrongCode(issued!.code), at(round * 2 * MINUTE + 1000));
      }
    }
    const locked = await issueSignupCode(world.db, SCOPE, EMAIL, at(5 * MINUTE));
    expect(await redeemSignupCode(world.db, SCOPE, EMAIL, locked!.code, at(5 * MINUTE + 1000))).toBe(
      false,
    );

    const open = await issueSignupCode(world.db, SCOPE, EMAIL, at(HOUR + 5 * MINUTE));
    expect(
      await redeemSignupCode(world.db, SCOPE, EMAIL, open!.code, at(HOUR + 5 * MINUTE + 1000)),
    ).toBe(true);
  });

  it("is swept once used or expired, like a sign-in code", async () => {
    const used = await issueSignupCode(world.db, SCOPE, EMAIL, at(0));
    await redeemSignupCode(world.db, SCOPE, EMAIL, used!.code, at(1000));
    await issueSignupCode(world.db, inviteScope("00000000-0000-0000-0000-0000000000bb"), EMAIL, at(0));
    const live = await issueSignupCode(world.db, setupScope("live@local.test"), "live@local.test", at(
      SIGNUP_CODE_TTL_MS,
    ));

    await sweepLoginRows(world.db, at(SIGNUP_CODE_TTL_MS + 1000));

    const left = await world.db.select().from(signupCode);
    expect(live).not.toBeNull();
    expect(left.map((row) => row.scope)).toEqual([setupScope("live@local.test")]);
  });

  it("writes an email that carries the code and its ten minutes, and says what it is for", () => {
    const setup = signupCodeEmail("setup", EMAIL, "042424");
    expect(setup.to).toBe(EMAIL);
    expect(setup.subject).not.toContain("042424");
    expect(setup.text).toContain("042424");
    expect(setup.text).toContain("10 minutos");

    const invite = signupCodeEmail("invite", EMAIL, "042424");
    expect(invite.subject).not.toBe(setup.subject);
    expect(invite.text).toContain("convite");
  });
});
