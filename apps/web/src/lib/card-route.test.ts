import { project, task, user, type Database } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminPrincipal,
  closeTestWorld,
  createTestWorld,
  type TestWorld,
} from "../mcp/test-db";
import { loadBoardTasks } from "./board-tasks";
import { cardIdFromPath, cardPath, resolveCardRoute } from "./card-route";
import type { Principal } from "./scope";

let world: TestWorld;
const DAY = 86_400_000;

function database(): Database {
  return world.db as unknown as Database;
}

async function card(values: {
  shortId: string;
  previousShortIds?: string[];
  createdByUserId?: string;
  updatedAt?: Date;
}) {
  const [row] = await world.db
    .insert(task)
    .values({
      projectId: world.projectId,
      shortId: values.shortId,
      previousShortIds: values.previousShortIds ?? [],
      title: `card ${values.shortId}`,
      oQue: "what",
      porQue: "why",
      comoConfirmo: JSON.stringify([{ step: "s", expected: "e" }]),
      createdByUserId: values.createdByUserId ?? world.adminUserId,
      ...(values.updatedAt
        ? { createdAt: values.updatedAt, updatedAt: values.updatedAt }
        : {}),
    })
    .returning({ id: task.id });
  return row!.id;
}

/**
 * /cards/OCL-12 (navigation plan E3, F4): the card's own address. An old id
 * hops once to the current one, a card the reader may not see reads exactly
 * like one that does not exist, and the period never hides a linked card.
 */
describe("the card's address", () => {
  let projectIds: string[] = [];
  let admin: Principal;

  beforeEach(async () => {
    world = await createTestWorld();
    projectIds = [world.projectId];
    admin = adminPrincipal(world);
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("opens the card that owns the id", async () => {
    const id = await card({ shortId: "OC-12" });
    const route = await resolveCardRoute(database(), projectIds, admin, "OC-12");
    expect(route.kind).toBe("open");
    expect(route.kind === "open" && route.row.id).toBe(id);
  });

  it("sends an old id to the current one, in one hop", async () => {
    await card({ shortId: "OC-30", previousShortIds: ["OLD-4"] });
    expect(await resolveCardRoute(database(), projectIds, admin, "OLD-4")).toEqual({
      kind: "moved",
      to: "/cards/OC-30",
    });
    // The id typed in another case is the same card, spelled the way it is.
    expect(await resolveCardRoute(database(), projectIds, admin, "oc-30")).toEqual({
      kind: "moved",
      to: "/cards/OC-30",
    });
  });

  it("answers a card out of the reader's scope exactly like an id that matches none", async () => {
    const [member] = await world.db
      .insert(user)
      .values({
        email: "member@example.test",
        passwordHash: "x",
        role: "member",
        organizationId: world.organizationId,
      })
      .returning({ id: user.id });
    const memberPrincipal: Principal = {
      userId: member!.id,
      role: "member",
      organizationId: world.organizationId,
    };
    await card({ shortId: "OC-7" });

    const hidden = await resolveCardRoute(database(), projectIds, memberPrincipal, "OC-7");
    const missing = await resolveCardRoute(database(), projectIds, memberPrincipal, "OC-999");
    expect(hidden).toEqual({ kind: "not-found" });
    expect(hidden).toEqual(missing);
    // A project outside the reader's list is out of scope too.
    expect(await resolveCardRoute(database(), [], admin, "OC-7")).toEqual({ kind: "not-found" });
    expect(await resolveCardRoute(database(), projectIds, admin, "   ")).toEqual({
      kind: "not-found",
    });
  });

  it("opens a card from 60 days ago while the board's period is 7 days", async () => {
    const old = new Date(Date.now() - 60 * DAY);
    const id = await card({ shortId: "OC-60", updatedAt: old });
    await world.db.update(task).set({ updatedAt: old }).where(eq(task.id, id));

    const window = await loadBoardTasks(database(), projectIds, admin, { period: "7d" });
    expect(window.some((row) => row.id === id)).toBe(false);

    const route = await resolveCardRoute(database(), projectIds, admin, "OC-60");
    expect(route.kind === "open" && route.row.id).toBe(id);
  });

  it("finds a card in any of the reader's projects", async () => {
    const [other] = await world.db
      .insert(project)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        name: "Site",
        idPrefix: "OVW",
        nextNumber: 1,
      })
      .returning({ id: project.id });
    const [row] = await world.db
      .insert(task)
      .values({
        projectId: other!.id,
        shortId: "OVW-9",
        title: "site card",
        oQue: "what",
        porQue: "why",
        comoConfirmo: "[]",
        createdByUserId: world.adminUserId,
      })
      .returning({ id: task.id });
    const route = await resolveCardRoute(
      database(),
      [world.projectId, other!.id],
      admin,
      "OVW-9",
    );
    expect(route.kind === "open" && route.row.id).toBe(row!.id);
  });
});

describe("the card's address on the client", () => {
  it("is /cards/<short id>, escaped", () => {
    expect(cardPath("OCL-12")).toBe("/cards/OCL-12");
    expect(cardPath("a b")).toBe("/cards/a%20b");
  });

  it("reads the short id back from the path, and nothing else", () => {
    expect(cardIdFromPath("/cards/OCL-12")).toBe("OCL-12");
    expect(cardIdFromPath("/cards/a%20b")).toBe("a b");
    expect(cardIdFromPath("/board")).toBeNull();
    expect(cardIdFromPath("/cards/")).toBeNull();
    expect(cardIdFromPath("/cards/OCL-12/x")).toBeNull();
    expect(cardIdFromPath("/cards/%E0%A4")).toBeNull();
  });
});
