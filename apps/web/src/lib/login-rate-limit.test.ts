import { loginCodeRequest } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import {
  CODE_REQUESTS_PER_HOUR,
  CODE_REQUESTS_PER_ORIGIN_HOUR,
  withinCodeRequestBudget,
} from "./login-rate-limit";

let world: TestWorld;

async function count(id: string): Promise<number | undefined> {
  const [row] = await world.db.select().from(loginCodeRequest).where(eq(loginCodeRequest.id, id));
  return row?.count;
}

const ORIGIN = "198.51.100.7";

describe("a refused code request gives back what it was charged", () => {
  beforeEach(async () => {
    world = await createTestWorld();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("lets 20 asks at one address leave the origin's allowance for other addresses untouched", async () => {
    for (let i = 0; i < CODE_REQUESTS_PER_ORIGIN_HOUR; i++) {
      await withinCodeRequestBudget(world.db, "victim@local.test", ORIGIN);
    }
    // Only the first one was let through; the 19 the minute bucket turned away
    // cost the origin nothing.
    expect(await count(`code-hour-origin:${ORIGIN}`)).toBe(1);
    expect(await withinCodeRequestBudget(world.db, "other@local.test", ORIGIN)).toBe(true);
  });

  it("gives back the origin and the minute charge when the hour bucket refuses", async () => {
    const now = Date.now();
    await world.db.insert(loginCodeRequest).values({
      id: "code-hour-email:victim@local.test",
      count: CODE_REQUESTS_PER_HOUR,
      windowStartedAt: new Date(now - 5 * 60 * 1000),
    });

    expect(await withinCodeRequestBudget(world.db, "victim@local.test", ORIGIN)).toBe(false);

    expect(await count(`code-hour-origin:${ORIGIN}`)).toBeUndefined();
    expect(await count("code-minute-email:victim@local.test")).toBeUndefined();
    expect(await count("code-hour-email:victim@local.test")).toBe(CODE_REQUESTS_PER_HOUR);
  });

  it("keeps the charges of an ask that goes through", async () => {
    expect(await withinCodeRequestBudget(world.db, "a@local.test", ORIGIN)).toBe(true);
    expect(await count(`code-hour-origin:${ORIGIN}`)).toBe(1);
    expect(await count("code-minute-email:a@local.test")).toBe(1);
    expect(await count("code-hour-email:a@local.test")).toBe(1);
  });

  it("spends the instance-wide cap for every ask it lets through, whatever the address is", async () => {
    await withinCodeRequestBudget(world.db, "a@local.test", ORIGIN);
    await withinCodeRequestBudget(world.db, "b@local.test", ORIGIN);
    expect(await count("code-hour-global:all")).toBe(2);
  });

  it("turns every ask away once the cap is spent and gives back the charges it had taken", async () => {
    process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR = "2";
    try {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await withinCodeRequestBudget(world.db, "a@local.test", ORIGIN)).toBe(true);
      expect(await withinCodeRequestBudget(world.db, "b@local.test", ORIGIN)).toBe(true);
      expect(await withinCodeRequestBudget(world.db, "c@local.test", ORIGIN)).toBe(false);
      logged.mockRestore();
    } finally {
      delete process.env.LOGIN_CODE_MAX_SENDS_PER_HOUR;
    }
    expect(await count("code-hour-global:all")).toBe(2);
    expect(await count("code-minute-email:c@local.test")).toBeUndefined();
    expect(await count("code-hour-email:c@local.test")).toBeUndefined();
    expect(await count(`code-hour-origin:${ORIGIN}`)).toBe(2);
  });

  it("does not spend the cap on an ask the address's own bucket turned away", async () => {
    await withinCodeRequestBudget(world.db, "a@local.test", ORIGIN);
    await withinCodeRequestBudget(world.db, "a@local.test", ORIGIN);
    expect(await count("code-hour-global:all")).toBe(1);
  });

  it("turns an origin away once its own allowance is gone, whoever asks", async () => {
    for (let i = 0; i < CODE_REQUESTS_PER_ORIGIN_HOUR; i++) {
      expect(await withinCodeRequestBudget(world.db, `p${i}@local.test`, ORIGIN)).toBe(true);
    }
    expect(await withinCodeRequestBudget(world.db, "late@local.test", ORIGIN)).toBe(false);
    expect(await count("code-minute-email:late@local.test")).toBeUndefined();
  });
});
