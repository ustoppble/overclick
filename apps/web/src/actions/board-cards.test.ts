import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardSearchLimiter } from "../lib/board-search-guard";
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

const { boardColumnCountsAction, loadOlderBoardCardsAction, searchBoardCardsAction } =
  await import("./board-cards");

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

  it("holds a second search while the first is still running", async () => {
    let release = () => {};
    holdSearch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = searchBoardCardsAction("first words");
    await vi.waitFor(() => expect(searched).toHaveLength(1));
    const second = await searchBoardCardsAction("second words");
    expect(second.cards).toEqual([]);
    expect(searched).toEqual(["first words"]);
    release();
    await first;
    await searchBoardCardsAction("third words");
    expect(searched).toEqual(["first words", "third words"]);
  });

  it("answers empty from the 31st search in a minute", async () => {
    for (let i = 0; i < 30; i += 1) await searchBoardCardsAction(`words ${i}`);
    expect(searched).toHaveLength(30);
    const refused = await searchBoardCardsAction("one more");
    expect(refused.cards).toEqual([]);
    expect(searched).toHaveLength(30);
  });
});

describe("board actions, malformed input", () => {
  const ID = "6f1c1c1e-9a53-4c52-8d4e-3f2f5a1b7c10";
  const base = {
    organizationIds: [],
    projectIds: [],
    missionId: null,
    types: [],
    priorities: [],
  };
  const none = { cards: [], hasMore: false };

  beforeEach(async () => {
    world = await createTestWorld();
    sessionUserId = world.adminUserId;
    boardSearchLimiter.reset();
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  const older = (input: Record<string, unknown>) =>
    loadOlderBoardCardsAction({
      status: "validado",
      filter: base,
      before: null,
      ...input,
    } as Parameters<typeof loadOlderBoardCardsAction>[0]);

  it("answers a valid page request", async () => {
    expect(
      await older({
        filter: { ...base, projectIds: [world.projectId], missionId: world.missionId },
        before: { updatedAt: "2026-10-04T00:00:00.000Z", id: ID },
      }),
    ).toEqual(none);
  });

  it("answers empty, not an error, to what is not a uuid", async () => {
    expect(await older({ filter: { ...base, missionId: "not-a-uuid" } })).toEqual(none);
    expect(await older({ filter: { ...base, projectIds: ["nope"] } })).toEqual(none);
    expect(await older({ filter: { ...base, organizationIds: [7] } })).toEqual(none);
    expect(await older({ before: { updatedAt: "2026-10-04T00:00:00.000Z", id: "x" } })).toEqual(none);
  });

  it("answers empty to a cursor, status, type or priority out of shape", async () => {
    expect(await older({ before: { updatedAt: "yesterday", id: ID } })).toEqual(none);
    expect(await older({ before: { id: ID } })).toEqual(none);
    expect(await older({ status: "aberto" })).toEqual(none);
    expect(await older({ status: { $ne: 1 } })).toEqual(none);
    expect(await older({ filter: { ...base, types: ["epic"] } })).toEqual(none);
    expect(await older({ filter: { ...base, priorities: ["asap"] } })).toEqual(none);
    expect(await older({ filter: null })).toEqual(none);
    expect(await older({ filter: { ...base, types: "bug" } })).toEqual(none);
  });

  it("answers null to bad filters for the column counts", async () => {
    expect(await boardColumnCountsAction({ ...base, missionId: "zzz" })).toBeNull();
    expect(await boardColumnCountsAction({ ...base, projectIds: ["zzz"] })).toBeNull();
    expect(
      await boardColumnCountsAction({ ...base, types: ["epic"] } as never),
    ).toBeNull();
    expect(await boardColumnCountsAction(base)).not.toBeNull();
    expect(await boardColumnCountsAction({ ...base, missionId: "none" })).not.toBeNull();
  });

  it("answers empty to a search that is not text", async () => {
    expect(await searchBoardCardsAction({ $ne: 1 } as never)).toMatchObject({ cards: [] });
  });
});
