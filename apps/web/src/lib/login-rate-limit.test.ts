import { loginCodeRequest } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("does not touch the instance-wide cap: that is spent when an email is really going out", async () => {
    await withinCodeRequestBudget(world.db, "a@local.test", ORIGIN);
    expect(await count("code-hour-global:all")).toBeUndefined();
  });

  it("turns an origin away once its own allowance is gone, whoever asks", async () => {
    for (let i = 0; i < CODE_REQUESTS_PER_ORIGIN_HOUR; i++) {
      expect(await withinCodeRequestBudget(world.db, `p${i}@local.test`, ORIGIN)).toBe(true);
    }
    expect(await withinCodeRequestBudget(world.db, "late@local.test", ORIGIN)).toBe(false);
    expect(await count("code-minute-email:late@local.test")).toBeUndefined();
  });
});
