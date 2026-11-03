import { loginFailure } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { chargeBudget, refundBudget, spendBudget } from "./attempt-budget";

const SCOPE = "login-origin:203.0.113.9";
const MAX = 8;
const WINDOW_MS = 15 * 60 * 1000;
const T0 = new Date("2026-11-03T12:00:00.000Z");

let world: TestWorld;

beforeEach(async () => {
  world = await createTestWorld();
});

afterEach(async () => {
  if (world) await closeTestWorld(world);
});

async function row() {
  const [found] = await world.db.select().from(loginFailure).where(eq(loginFailure.id, SCOPE));
  return found;
}

describe("a spend the budget turns away", () => {
  it("does not raise the count past the limit", async () => {
    const answers: boolean[] = [];
    for (let i = 0; i < MAX + 5; i++) {
      answers.push(await spendBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS));
    }

    expect(answers).toEqual([...Array(MAX).fill(true), ...Array(5).fill(false)]);
    expect((await row())?.count).toBe(MAX);
  });

  it("does not move the window it was turned away in", async () => {
    for (let i = 0; i < MAX; i++) {
      await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, T0);
    }
    const later = new Date(T0.getTime() + 60 * 1000);
    const refused = await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, later);

    expect(refused).toEqual({ ok: false, windowStartedAt: null });
    expect((await row())?.windowStartedAt.getTime()).toBe(T0.getTime());
  });

  it("starts a new window once the old one has run its course", async () => {
    for (let i = 0; i < MAX; i++) {
      await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, T0);
    }
    const after = new Date(T0.getTime() + WINDOW_MS + 1);
    const fresh = await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, after);

    expect(fresh.ok).toBe(true);
    expect(fresh.windowStartedAt?.getTime()).toBe(after.getTime());
    expect((await row())?.count).toBe(1);
  });

  it("lets exactly the limit through when charged in parallel", async () => {
    const answers = await Promise.all(
      Array.from({ length: 30 }, () => spendBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS)),
    );

    expect(answers.filter(Boolean)).toHaveLength(MAX);
    expect((await row())?.count).toBe(MAX);
  });
});

describe("giving a charge back", () => {
  it("takes back one charge for each, one to one", async () => {
    const charges = [];
    for (let i = 0; i < 3; i++) {
      charges.push(await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, T0));
    }
    expect((await row())?.count).toBe(3);

    await refundBudget(world.db, loginFailure, SCOPE, charges[0]!.windowStartedAt!);
    expect((await row())?.count).toBe(2);
  });

  it("drops the row when the last charge goes back", async () => {
    const charge = await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, T0);

    await refundBudget(world.db, loginFailure, SCOPE, charge.windowStartedAt!);

    expect(await row()).toBeUndefined();
  });

  it("never takes the count below zero, however many times it is asked", async () => {
    const charge = await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, T0);
    await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, T0);

    for (let i = 0; i < 5; i++) {
      await refundBudget(world.db, loginFailure, SCOPE, charge.windowStartedAt!);
    }

    expect((await row())?.count ?? 0).toBe(0);
  });

  it("has nothing to give back for a scope that was never charged", async () => {
    await refundBudget(world.db, loginFailure, SCOPE, T0);

    expect(await row()).toBeUndefined();
  });

  it("leaves a window that replaced the charge's own alone", async () => {
    const first = await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, T0);
    // The window the charge was taken in runs out before the sign-in finishes,
    // and the next caller opens a new one.
    const later = new Date(T0.getTime() + WINDOW_MS + 1);
    const second = await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, later);
    expect((await row())?.count).toBe(1);

    await refundBudget(world.db, loginFailure, SCOPE, first.windowStartedAt!);

    expect((await row())?.count).toBe(1);
    expect((await row())?.windowStartedAt.getTime()).toBe(later.getTime());

    await refundBudget(world.db, loginFailure, SCOPE, second.windowStartedAt!);
    expect(await row()).toBeUndefined();
  });
});
