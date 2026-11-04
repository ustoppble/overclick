import { task } from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../../mcp/test-db";

/**
 * /home?card=<old id> (E3 review): the card is looked up before the redirect,
 * so an id the card had before it moved goes straight to its current address
 * in one 308, with the query the link carried.
 */
let world: TestWorld;
let sessionUserId = "";

vi.mock("../../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

vi.mock("../../lib/cookies", () => ({
  getSession: async () =>
    sessionUserId ? { userId: sessionUserId, sessionVersion: 1, email: "who@example.test" } : null,
}));

const { default: OldHomePage } = await import("./page");

/** Where the page redirected, and how: Next throws the answer as an error. */
async function answer(query: Record<string, string>): Promise<{ to: string; status: string }> {
  try {
    await OldHomePage({ searchParams: Promise.resolve(query) });
  } catch (error) {
    const digest = String((error as { digest?: string }).digest ?? "");
    const [kind, , to, status] = digest.split(";");
    if (kind === "NEXT_REDIRECT") return { to: to!, status: status! };
    throw error;
  }
  throw new Error("the page did not redirect");
}

describe("/home?card= finds the card's current address first", () => {
  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
    await world.db.insert(task).values({
      projectId: world.projectId,
      shortId: "OC-30",
      previousShortIds: ["OLD-4"],
      title: "moved card",
      oQue: "what",
      porQue: "why",
      comoConfirmo: "[]",
      createdByUserId: world.adminUserId,
    });
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  // E4 review, item 3: the lookup reads today's data, and the card may move
  // again; a browser must not cache this hop, so it is temporary (307). The
  // static branches stay permanent.
  it("sends an old id to the new address in one temporary hop, with the query", async () => {
    expect(await answer({ card: "OLD-4", period: "30d" })).toEqual({
      to: "/cards/OC-30?period=30d",
      status: "307",
    });
  });

  it("sends the current id where it already is", async () => {
    expect(await answer({ card: "OC-30" })).toEqual({ to: "/cards/OC-30", status: "308" });
  });

  it("without a session it cannot look, so the address is the one asked for", async () => {
    sessionUserId = "";
    expect(await answer({ card: "OLD-4" })).toEqual({ to: "/cards/OLD-4", status: "308" });
  });

  it("keeps a plain /home on the board, permanently", async () => {
    expect(await answer({ projects: "all", period: "14d" })).toEqual({
      to: "/board?projects=all&period=14d",
      status: "308",
    });
  });
});
