import { task } from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardSearchLimiter } from "../lib/board-search-guard";
import {
  BOARD_SIGNATURE_MAX_PER_MINUTE,
  boardSignatureLimiter,
} from "../lib/board-signature-guard";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

let world: TestWorld;
let sessionUserId = "";

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

vi.mock("../lib/cookies", () => ({
  getSession: async () =>
    sessionUserId
      ? { userId: sessionUserId, sessionVersion: 1, email: "who@example.test" }
      : null,
}));

const searched: string[] = [];
let holdSearch: Promise<void> | null = null;

vi.mock("../lib/board-tasks", async (original) => {
  const real = await original<typeof import("../lib/board-tasks")>();
  return {
    ...real,
    searchBoardTaskIds: async (
      ...args: Parameters<typeof real.searchBoardTaskIds>
    ) => {
      searched.push(args[3]);
      if (holdSearch) await holdSearch;
      return real.searchBoardTaskIds(...args);
    },
  };
});

const { boardSignatureAction, searchBoardCardsAction } = await import("./board-cards");

describe("board search action", () => {
  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
    searched.length = 0;
    holdSearch = null;
    boardSearchLimiter.reset();
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  it("does not search for a query under two characters", async () => {
    expect(await searchBoardCardsAction("a")).toEqual({ query: "a", cards: [] });
    expect(searched).toEqual([]);
  });

  it("searches with the trimmed query, cut at 100 characters and six terms", async () => {
    await searchBoardCardsAction(`   ${"abc ".repeat(300)}`);
    await searchBoardCardsAction("x".repeat(4000));
    expect(searched).toEqual(["abc abc abc abc abc abc", "x".repeat(100)]);
  });

  it("runs two searches at once and tells the third to come back", async () => {
    let release = () => {};
    holdSearch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = searchBoardCardsAction("first words");
    const second = searchBoardCardsAction("second words");
    await vi.waitFor(() => expect(searched).toHaveLength(2));
    const third = await searchBoardCardsAction("third words");
    expect(third).toEqual({ query: "third words", cards: [], limited: "busy" });
    expect(searched).toEqual(["first words", "second words"]);
    release();
    await Promise.all([first, second]);
    const retried = await searchBoardCardsAction("third words");
    expect(retried.limited).toBeUndefined();
    expect(searched).toEqual(["first words", "second words", "third words"]);
  });

  it("flags the 31st search in a minute as rate limited", async () => {
    for (let i = 0; i < 30; i += 1) await searchBoardCardsAction(`words ${i}`);
    expect(searched).toHaveLength(30);
    const refused = await searchBoardCardsAction("one more");
    expect(refused).toEqual({ query: "one more", cards: [], limited: "rate" });
    expect(searched).toHaveLength(30);
  });
});

describe("board actions, malformed input", () => {
  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
    boardSearchLimiter.reset();
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  it("answers empty to a search that is not text", async () => {
    expect(await searchBoardCardsAction({ $ne: 1 } as never)).toMatchObject({ cards: [] });
  });
});

describe("board signature action", () => {
  beforeEach(async () => {
    world = await createTestWorld();
    boardSignatureLimiter.reset();
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  it("answers null without a session, so the poll refreshes into the login", async () => {
    sessionUserId = "";
    expect(await boardSignatureAction()).toBeNull();
  });

  it("answers the same text twice for a board that did not move, and a new one when it did", async () => {
    sessionUserId = world.adminUserId;
    const first = await boardSignatureAction();
    expect(first).toEqual(expect.any(String));
    expect(await boardSignatureAction()).toBe(first);

    await world.db.insert(task).values({
      projectId: world.projectId,
      shortId: "OC-901",
      title: "a new card",
      status: "aberto",
      createdByUserId: world.adminUserId,
    });
    expect(await boardSignatureAction()).not.toBe(first);
  });

  it("answers a limited sign once a person has polled twelve times in a minute, and does not touch the board", async () => {
    sessionUserId = world.adminUserId;
    for (let i = 0; i < BOARD_SIGNATURE_MAX_PER_MINUTE; i += 1) {
      expect(await boardSignatureAction()).toEqual(expect.any(String));
    }
    expect(await boardSignatureAction()).toEqual({ limited: true });
    expect(await boardSignatureAction()).toEqual({ limited: true });
  });

  it("does not spend the limit of someone without a session", async () => {
    sessionUserId = "";
    for (let i = 0; i < 40; i += 1) expect(await boardSignatureAction()).toBeNull();
  });
});
