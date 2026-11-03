import {
  executionAttempt,
  handoff,
  mission,
  task,
  taskComment,
  user,
  type Database,
} from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  adminPrincipal,
  closeTestWorld,
  createTestWorld,
  type TestWorld,
} from "../mcp/test-db";
import { loadBoardSignature } from "./board-signature";
import type { Principal } from "./scope";

describe("board signature", () => {
  let world: TestWorld;
  let seq = 0;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  const database = () => world.db as unknown as Database;
  const signature = (principal: Principal = adminPrincipal(world)) =>
    loadBoardSignature(database(), world.workspaceId, [world.projectId], principal);

  async function card(createdByUserId: string | null = world.adminUserId) {
    seq += 1;
    const [row] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        shortId: `SG-${seq}`,
        title: `card ${seq}`,
        status: "aberto",
        createdByUserId,
      })
      .returning({ id: task.id });
    return row!.id;
  }

  async function member(): Promise<Principal> {
    const [row] = await world.db
      .insert(user)
      .values({
        email: "member@example.test",
        passwordHash: "x",
        role: "member",
        organizationId: world.organizationId,
      })
      .returning({ id: user.id });
    return { userId: row!.id, role: "member", organizationId: world.organizationId };
  }

  it("stays the same while nothing changes", async () => {
    world = await createTestWorld();
    await card();
    expect(await signature()).toBe(await signature());
  });

  it("changes when a card is created, edited, moved or deleted", async () => {
    world = await createTestWorld();
    const seen = new Set<string>([await signature()]);
    const id = await card();
    seen.add(await signature());
    await world.db
      .update(task)
      .set({ status: "em_execucao", updatedAt: new Date(Date.now() + 5_000) })
      .where(eq(task.id, id));
    seen.add(await signature());
    await world.db.delete(task).where(eq(task.id, id));
    seen.add(await signature());
    // Four steps, but the delete lands on the numbers of the very start.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it("changes when a comment or a handoff arrives without the card itself changing", async () => {
    world = await createTestWorld();
    const id = await card();
    const before = await signature();

    await world.db.insert(taskComment).values({
      taskId: id,
      authorUserId: world.adminUserId,
      body: "looks good",
      createdAt: new Date(Date.now() + 10_000),
    });
    const afterComment = await signature();
    expect(afterComment).not.toBe(before);

    await world.db.insert(handoff).values({
      taskId: id,
      summary: "done",
      createdAt: new Date(Date.now() + 20_000),
    });
    expect(await signature()).not.toBe(afterComment);
  });

  it("changes when an attempt reports activity or closes", async () => {
    world = await createTestWorld();
    const id = await card();
    const [attempt] = await world.db
      .insert(executionAttempt)
      .values({ taskId: id })
      .returning({ id: executionAttempt.id });
    const before = await signature();

    await world.db
      .update(executionAttempt)
      .set({ lastActivityAt: new Date(Date.now() + 30_000) })
      .where(eq(executionAttempt.id, attempt!.id));
    const beat = await signature();
    expect(beat).not.toBe(before);

    await world.db
      .update(executionAttempt)
      .set({ finishedAt: new Date(Date.now() + 60_000) })
      .where(eq(executionAttempt.id, attempt!.id));
    expect(await signature()).not.toBe(beat);
  });

  it("changes when a mission is created or retitled", async () => {
    world = await createTestWorld();
    const before = await signature();
    await world.db
      .update(mission)
      .set({ title: "renamed", updatedAt: new Date(Date.now() + 5_000) })
      .where(eq(mission.id, world.missionId));
    expect(await signature()).not.toBe(before);
  });

  it("does not move for what a member may not see", async () => {
    world = await createTestWorld();
    const reader = await member();
    await card(reader.userId);
    const before = await signature(reader);

    const adminCard = await card(world.adminUserId);
    await world.db.insert(taskComment).values({
      taskId: adminCard,
      authorUserId: world.adminUserId,
      body: "admin only",
      createdAt: new Date(Date.now() + 10_000),
    });
    expect(await signature(reader)).toBe(before);

    // And the admin's own view does move.
    expect(await signature()).not.toBe(before);
  });
});
