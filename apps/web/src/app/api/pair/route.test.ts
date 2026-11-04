import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_LIMITS } from "../../../lib/body-limit";
import { closeTestWorld, createTestWorld, type TestWorld } from "../../../mcp/test-db";

let world: TestWorld;

vi.mock("../../../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

const { POST } = await import("./route");

function pair(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("https://board.example/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/pair body ceiling", () => {
  beforeEach(async () => {
    world = await createTestWorld();
  });
  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("refuses a body over the ceiling with 413 before touching the pairing budget", async () => {
    const big = JSON.stringify({ code: "123456", filler: "x".repeat(BODY_LIMITS.pair) });

    const response = await POST(pair(big));

    expect(response.status).toBe(413);
  });

  it("still answers a small wrong code the way it always did", async () => {
    const response = await POST(pair(JSON.stringify({ code: "000000" })));

    expect(response.status).toBe(404);
  });
});
