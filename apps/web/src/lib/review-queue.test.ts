import { handoff, project, task, user, type Database } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { invokeToolForTests as invokeTool } from "../mcp/test-tools";
import type { AuthContext } from "../mcp/types";
import { loadBoardTasks } from "./board-tasks";
import { loadGlobalCounts } from "./global-counts";
import {
  countCardsByStatus,
  loadReviewQueue,
  nextInQueue,
  readReviewScope,
} from "./review-queue";
import { principalFromUserId, type Principal } from "./scope";

/**
 * The F1 contract (navigation plan, E1): the "N to review" number and the
 * review list are counted by scope and role only. The board's period, type,
 * priority and search narrow what the columns show, never what is waiting
 * for a person.
 */

let world: TestWorld;
let admin: AuthContext;
let member: AuthContext;
let memberId: string;
let adminP: Principal;
let memberP: Principal;

const DAY = 86_400_000;
const origem = { session_id: "sess_review_queue", cli: "test" };

function card(title: string, extra: Record<string, unknown> = {}) {
  return {
    title,
    type: "feature",
    o_que: "what",
    por_que: "why",
    como_confirmo: [{ step: "run it", expected: "it works" }],
    origem,
    project_id: world.projectId,
    ...extra,
  };
}

function idOf(result: Awaited<ReturnType<typeof invokeTool>>): string {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return (result.value as { task: { id: string } }).task.id;
}

async function create(ctx: AuthContext, title: string, extra: Record<string, unknown> = {}) {
  return idOf(await invokeTool(world.db, ctx, "task_create", card(title, extra)));
}

async function deliver(ctx: AuthContext, taskId: string) {
  const claim = await invokeTool(world.db, ctx, "task_claim", {
    task_id: taskId,
    executor: { cli: "claude", model: "sonnet-5" },
  });
  if (!claim.ok) throw new Error(JSON.stringify(claim.error));
  const done = await invokeTool(world.db, ctx, "task_deliver", {
    task_id: taskId,
    summary: "delivered",
    usage: {
      segments: [{ model: "sonnet-5", input: 1, output: 1, cache_read: 0, cache_write: 0 }],
      duration_ms: 1,
      turns: 1,
    },
  });
  if (!done.ok) throw new Error(JSON.stringify(done.error));
}

/** Moves a card's last delivery (and its activity) back in time. */
async function deliveredDaysAgo(taskId: string, days: number) {
  const at = new Date(Date.now() - days * DAY);
  await world.db.update(handoff).set({ createdAt: at }).where(eq(handoff.taskId, taskId));
  await world.db.update(task).set({ updatedAt: at, createdAt: at }).where(eq(task.id, taskId));
}

const scope = () => ({
  workspaceId: world.workspaceId,
  organizationIds: [] as string[],
  projectIds: [] as string[],
});

beforeEach(async () => {
  world = await createTestWorld();
  const [m] = await world.db
    .insert(user)
    .values({
      email: "member@example.test",
      passwordHash: "x",
      role: "member",
      organizationId: world.organizationId,
    })
    .returning({ id: user.id });
  memberId = m!.id;
  admin = {
    tokenId: world.tokenId,
    workspaceId: world.workspaceId,
    tokenLabel: "admin",
    userId: world.adminUserId,
    role: "admin",
    canManage: true,
  };
  member = {
    tokenId: world.secondTokenId,
    workspaceId: world.workspaceId,
    tokenLabel: "member",
    userId: memberId,
    role: "member",
    organizationId: world.organizationId,
    canManage: false,
  };
  adminP = (await principalFromUserId(world.db, world.adminUserId))!;
  memberP = (await principalFromUserId(world.db, memberId))!;
});

afterEach(async () => {
  await closeTestWorld(world);
});

describe("countCardsByStatus: by scope and role, never by period or filters", () => {
  it("counts a delivery from 30 days ago while the board's 7-day window leaves it out", async () => {
    const old = await create(admin, "delivered a month ago");
    await deliver(admin, old);
    await deliveredDaysAgo(old, 30);
    const fresh = await create(admin, "delivered today");
    await deliver(admin, fresh);

    const counts = await countCardsByStatus(world.db as unknown as Database, adminP, scope());
    expect(counts.feito).toBe(2);

    // The board's own window, for contrast: the period hides the old one.
    const board = await loadBoardTasks(world.db as unknown as Database, [world.projectId], adminP, {
      period: "7d",
    });
    expect(board.map((row) => row.id)).not.toContain(old);
  });

  it("is not moved by the type, priority, mission, search or period the reader left on the board", async () => {
    const bug = await create(admin, "a bug", { type: "bug", priority: "alta" });
    const feature = await create(admin, "a feature", { priority: "baixa" });
    await deliver(admin, bug);
    await deliver(admin, feature);
    const running = await create(admin, "still running");
    await invokeTool(world.db, admin, "task_claim", {
      task_id: running,
      executor: { cli: "claude", model: "sonnet-5" },
    });

    await world.db
      .update(user)
      .set({
        boardTaskTypes: "rfc",
        boardPriorities: "urgente",
        boardMissionId: "none",
        boardPeriod: "7d",
      })
      .where(eq(user.id, world.adminUserId));
    const remembered = await readReviewScope(world.db as unknown as Database, world.workspaceId, adminP);
    // Only the organization/project pair is read: a single project is the
    // board's default selection, the facets are not part of the scope.
    expect(remembered).toEqual({
      ...scope(),
      projectIds: [world.projectId],
      label: { organization: null, project: "OverClick" },
    });

    const counts = await countCardsByStatus(world.db as unknown as Database, adminP, remembered);
    expect(counts.feito).toBe(2);
    expect(counts.em_execucao).toBe(1);
  });

  it("follows the remembered project: a card in another project is not counted", async () => {
    const [other] = await world.db
      .insert(project)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        name: "Elsewhere",
        idPrefix: "EL",
        nextNumber: 1,
      })
      .returning({ id: project.id });
    const here = await create(admin, "here");
    const there = await create(admin, "there", { project_id: other!.id });
    await deliver(admin, here);
    await deliver(admin, there);
    await world.db.update(user).set({ boardProjectId: world.projectId }).where(eq(user.id, world.adminUserId));

    const remembered = await readReviewScope(world.db as unknown as Database, world.workspaceId, adminP);
    expect(remembered.projectIds).toEqual([world.projectId]);
    const counts = await countCardsByStatus(world.db as unknown as Database, adminP, remembered);
    expect(counts.feito).toBe(1);
  });

  it("gives a member only the cards they authored", async () => {
    const mine = await create(member, "the member's");
    const theirs = await create(admin, "the admin's");
    await deliver(member, mine);
    await deliver(admin, theirs);

    const asMember = await countCardsByStatus(world.db as unknown as Database, memberP, scope());
    expect(asMember.feito).toBe(1);
    const asAdmin = await countCardsByStatus(world.db as unknown as Database, adminP, scope());
    expect(asAdmin.feito).toBe(2);
    expect(await countCardsByStatus(world.db as unknown as Database, null, scope())).toEqual({
      aberto: 0,
      em_execucao: 0,
      feito: 0,
      validado: 0,
      descartado: 0,
    });
  });
});

describe("loadReviewQueue: the oldest delivery first", () => {
  it("orders by the latest delivery of each card, oldest first, whatever the period", async () => {
    const a = await create(admin, "A");
    const b = await create(admin, "B");
    const c = await create(admin, "C");
    for (const id of [a, b, c]) await deliver(admin, id);
    await deliveredDaysAgo(a, 2);
    await deliveredDaysAgo(b, 30);
    await deliveredDaysAgo(c, 10);

    const queue = await loadReviewQueue(world.db as unknown as Database, adminP, scope());
    expect(queue.map((entry) => entry.id)).toEqual([b, c, a]);
    expect(queue[0]!.shortId).toMatch(/^OC-\d+$/);
    expect(queue[0]!.checks).toEqual({ done: 0, total: 1 });
  });

  it("sends a card that was returned and delivered again to the end", async () => {
    const a = await create(admin, "A");
    const b = await create(admin, "B");
    await deliver(admin, a);
    await deliver(admin, b);
    await deliveredDaysAgo(a, 5);
    await deliveredDaysAgo(b, 3);
    expect((await loadReviewQueue(world.db as unknown as Database, adminP, scope())).map((e) => e.id)).toEqual([a, b]);

    const reopened = await invokeTool(world.db, admin, "task_reopen", { task_id: a, reason: "missing a test" });
    expect(reopened.ok).toBe(true);
    await deliver(admin, a);

    expect((await loadReviewQueue(world.db as unknown as Database, adminP, scope())).map((e) => e.id)).toEqual([b, a]);
  });

  it("lists only the member's own deliveries to the member", async () => {
    const mine = await create(member, "mine");
    const theirs = await create(admin, "theirs");
    await deliver(member, mine);
    await deliver(admin, theirs);
    const queue = await loadReviewQueue(world.db as unknown as Database, memberP, scope());
    expect(queue.map((entry) => entry.id)).toEqual([mine]);
  });
});

describe("nextInQueue: after validating, the next card of the same list", () => {
  const ids = ["a", "b", "c"];

  it("is the one after the card just validated", () => {
    expect(nextInQueue(ids, "a")).toBe("b");
    expect(nextInQueue(ids, "b")).toBe("c");
  });

  it("wraps to the first one still waiting when the last one goes", () => {
    expect(nextInQueue(ids, "c")).toBe("a");
  });

  it("is nothing when the list held only that card, or nothing at all", () => {
    expect(nextInQueue(["a"], "a")).toBeNull();
    expect(nextInQueue([], "a")).toBeNull();
  });

  it("starts from the top when the card is not in the list any more", () => {
    expect(nextInQueue(ids, "z")).toBe("a");
  });
});

describe("the bar's two numbers read only the two statuses they show (E1 review, M1)", () => {
  it("counts only the statuses it is asked for, and leaves the others at zero", async () => {
    await create(admin, "still in the queue");
    const done = await create(admin, "delivered");
    await deliver(admin, done);
    const all = await countCardsByStatus(world.db as unknown as Database, adminP, scope());
    expect(all.aberto).toBe(1);
    const two = await countCardsByStatus(world.db as unknown as Database, adminP, scope(), [
      "em_execucao",
      "feito",
    ]);
    expect(two).toEqual({ aberto: 0, em_execucao: 0, feito: 1, validado: 0, descartado: 0 });
  });

  it("gives the same numbers when the caller hands over the projects it already read", async () => {
    const done = await create(admin, "delivered");
    await deliver(admin, done);
    const running = await create(admin, "running");
    await invokeTool(world.db, admin, "task_claim", {
      task_id: running,
      executor: { cli: "claude", model: "sonnet-5" },
    });
    const projects = await world.db
      .select({ id: project.id, name: project.name, organizationId: project.organizationId })
      .from(project)
      .where(eq(project.workspaceId, world.workspaceId));
    const read = await loadGlobalCounts(world.db as unknown as Database, world.workspaceId, adminP);
    const reused = await loadGlobalCounts(world.db as unknown as Database, world.workspaceId, adminP, {
      projects,
    });
    expect(read).toEqual({ running: 1, review: 1 });
    expect(reused).toEqual(read);
  });
});
