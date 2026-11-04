import { mcpToken, project, projectMember, task, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateBearer } from "../mcp/auth";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { invokeToolForTests as invokeTool } from "../mcp/test-tools";
import { generateTokenSecret, hashToken } from "../mcp/token";
import type { AuthContext } from "../mcp/types";
import { loadBoardTasks } from "./board-tasks";
import { readBoardPerson, loadVisiblePeople, PERSON_ME } from "./person-filter";
import { countCardsByStatus, loadReviewQueue, readReviewScope } from "./review-queue";
import type { Principal } from "./scope";

const origem = { session_id: "sess_person_filter", cli: "test" };
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  ...extra,
});
const usage = {
  segments: [{ model: "sonnet-5", input: 1, output: 1, cache_read: 0, cache_write: 0 }],
  duration_ms: 1,
  turns: 1,
};

/**
 * The board's person filter (OCL person filter). A card is linked to a person
 * when they wrote it, or when the claim on it is theirs: the agent working it
 * now, or the one that delivered it (task_deliver keeps the claim's token on
 * the card). The filter narrows inside the reader's scope and nowhere else.
 */
describe("person filter: the cards linked to one person, inside the reader's scope", () => {
  let world: TestWorld;
  let admin: AuthContext;
  let alice: Principal;
  let aliceSecret: string;
  let bobId: string;
  let bobSecret: string;
  let outsiderId: string;
  let sideProjectId: string;
  const ids: Record<string, string> = {};

  const bearer = async (secret: string): Promise<AuthContext> => {
    const auth = await authenticateBearer(world.db, `Bearer ${secret}`);
    if (!auth.ok) throw new Error("token should authenticate");
    return auth.ctx;
  };
  const value = <T>(result: { ok: boolean; value?: unknown }) => {
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value as T;
  };
  const created = async (ctx: AuthContext, title: string, projectId: string) =>
    value<{ task: { id: string; short_id: string } }>(
      await invokeTool(world.db, ctx, "task_create", card(title, { project_id: projectId })),
    ).task;
  const titles = (rows: { title: string }[]) => rows.map((row) => row.title).sort();

  async function member(email: string, projects: string[]) {
    const [row] = await world.db
      .insert(user)
      .values({ email, role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    const secret = generateTokenSecret();
    await world.db.insert(mcpToken).values({
      workspaceId: world.workspaceId,
      ownerUserId: row!.id,
      label: `${email}-agent`,
      hash: hashToken(secret),
      tokenPrefix: secret.slice(0, 12),
    });
    for (const projectId of projects) {
      await world.db.insert(projectMember).values({ projectId, userId: row!.id });
    }
    return { id: row!.id, secret };
  }

  beforeEach(async () => {
    world = await createTestWorld();
    admin = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin",
      canManage: true,
    };
    const [side] = await world.db
      .insert(project)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        name: "Lateral",
        idPrefix: "LT",
        nextNumber: 1,
      })
      .returning({ id: project.id });
    sideProjectId = side!.id;

    const a = await member("alice@example.test", [world.projectId]);
    alice = { userId: a.id, role: "member", organizationId: world.organizationId };
    aliceSecret = a.secret;
    const b = await member("bob@example.test", [world.projectId]);
    bobId = b.id;
    bobSecret = b.secret;
    // Works only in the project Alice is not linked to.
    const o = await member("outsider@example.test", [sideProjectId]);
    outsiderId = o.id;

    const aliceCtx = await bearer(aliceSecret);
    const bobCtx = await bearer(bobSecret);
    const outsiderCtx = await bearer(o.secret);

    // Written by the admin, nobody else touched it.
    ids.adminOnly = (await created(admin, "admin escreveu", world.projectId)).id;
    // Written by Alice.
    ids.aliceWrote = (await created(aliceCtx, "alice escreveu", world.projectId)).id;
    // Written by the admin, claimed now by Bob's agent.
    const claimedByBob = await created(admin, "bob pegou", world.projectId);
    ids.bobClaimed = claimedByBob.id;
    value(await invokeTool(world.db, bobCtx, "task_claim", {
      task_id: claimedByBob.id,
      executor: { cli: "claude", model: "sonnet-5" },
    }));
    // Written by the admin, claimed and delivered by Alice's agent.
    const deliveredByAlice = await created(admin, "alice entregou", world.projectId);
    ids.aliceDelivered = deliveredByAlice.id;
    value(await invokeTool(world.db, aliceCtx, "task_claim", {
      task_id: deliveredByAlice.id,
      executor: { cli: "claude", model: "sonnet-5" },
    }));
    value(await invokeTool(world.db, aliceCtx, "task_deliver", {
      task_id: deliveredByAlice.id,
      summary: "s",
      usage,
    }));
    // The outsider's card, in the project Alice cannot see.
    ids.outsiderWrote = (await created(outsiderCtx, "outsider escreveu", sideProjectId)).id;
  });

  afterEach(async () => {
    await closeTestWorld(world);
  });

  it("delivering keeps the claim's owner on the card: that is how 'delivered by' is read", async () => {
    const [row] = await world.db
      .select({ status: task.status, claimedByTokenId: task.claimedByTokenId })
      .from(task)
      .where(eq(task.id, ids.aliceDelivered!));
    expect(row?.status).toBe("feito");
    expect(row?.claimedByTokenId).not.toBeNull();
  });

  it("'me' is what the reader wrote, holds or delivered", async () => {
    const person = await readBoardPerson(world.db, world.workspaceId, alice, { person: PERSON_ME });
    expect(person.userId).toBe(alice.userId);
    const rows = await loadBoardTasks(world.db, [world.projectId], alice, {
      period: "all",
      personUserId: person.userId,
    });
    expect(titles(rows)).toEqual(["alice entregou", "alice escreveu"]);
  });

  it("another person is what they wrote, hold or delivered, and nothing else", async () => {
    const person = await readBoardPerson(world.db, world.workspaceId, alice, { person: bobId });
    expect(person.userId).toBe(bobId);
    const rows = await loadBoardTasks(world.db, [world.projectId], alice, {
      period: "all",
      personUserId: person.userId,
    });
    expect(titles(rows)).toEqual(["bob pegou"]);
  });

  it("the people on offer are only the ones on a card the reader can see", async () => {
    const forAlice = await loadVisiblePeople(world.db, world.workspaceId, alice);
    expect(forAlice.map((p) => p.email).sort()).toEqual([
      "admin@example.test",
      "alice@example.test",
      "bob@example.test",
    ]);
    const forNobody = await loadVisiblePeople(world.db, world.workspaceId, null);
    expect(forNobody).toEqual([]);
    const everyone = await loadVisiblePeople(world.db, world.workspaceId, {
      userId: world.adminUserId,
      role: "admin",
      organizationId: null,
    });
    expect(everyone.map((p) => p.email)).toContain("outsider@example.test");
  });

  it("a member asking for someone outside their scope gets every person, never their cards", async () => {
    const person = await readBoardPerson(world.db, world.workspaceId, alice, { person: outsiderId });
    expect(person.userId).toBeNull();
    expect(person.choice).toBe("all");
    // Even forced past the resolver, the filter stays inside the member's scope.
    const forced = await loadBoardTasks(world.db, [world.projectId, sideProjectId], alice, {
      period: "all",
      personUserId: outsiderId,
    });
    expect(forced).toEqual([]);
  });

  it("garbage and unknown ids read as everyone", async () => {
    for (const asked of ["x' or 1=1 --", "00000000-0000-0000-0000-000000000000", ""]) {
      const person = await readBoardPerson(world.db, world.workspaceId, alice, { person: asked });
      expect(person.userId).toBeNull();
    }
  });

  it("is remembered on the user, and the address wins over the memory", async () => {
    await world.db.update(user).set({ boardPerson: bobId }).where(eq(user.id, alice.userId));
    expect((await readBoardPerson(world.db, world.workspaceId, alice)).userId).toBe(bobId);
    expect(
      (await readBoardPerson(world.db, world.workspaceId, alice, { person: PERSON_ME })).userId,
    ).toBe(alice.userId);
    expect(
      (await readBoardPerson(world.db, world.workspaceId, alice, { person: "all" })).userId,
    ).toBeNull();
  });

  it("the running and to-review counts and the review list follow the person", async () => {
    const all = await readReviewScope(world.db, world.workspaceId, alice, undefined, {
      projects: "all",
    });
    const everyone = await countCardsByStatus(world.db, alice, all, ["em_execucao", "feito"]);
    expect(everyone.em_execucao).toBe(1);
    expect(everyone.feito).toBe(1);

    const mine = await readReviewScope(world.db, world.workspaceId, alice, undefined, {
      projects: "all",
      person: PERSON_ME,
    });
    expect(mine.personUserId).toBe(alice.userId);
    const counted = await countCardsByStatus(world.db, alice, mine, ["em_execucao", "feito"]);
    expect(counted.em_execucao).toBe(0);
    expect(counted.feito).toBe(1);
    expect((await loadReviewQueue(world.db, alice, mine)).map((e) => e.id)).toEqual([
      ids.aliceDelivered,
    ]);

    const bobs = await readReviewScope(world.db, world.workspaceId, alice, undefined, {
      projects: "all",
      person: bobId,
    });
    const bobCounts = await countCardsByStatus(world.db, alice, bobs, ["em_execucao", "feito"]);
    expect(bobCounts.em_execucao).toBe(1);
    expect(bobCounts.feito).toBe(0);
  });

  describe("task_list person, as a member with their own token", () => {
    const listed = async (ctx: AuthContext, input: Record<string, unknown>) =>
      value<{ tasks: Array<{ title: string }> }>(
        await invokeTool(world.db, ctx, "task_list", input),
      ).tasks;

    it("person: me lists the member's linked cards", async () => {
      const aliceCtx = await bearer(aliceSecret);
      expect(titles(await listed(aliceCtx, { person: "me" }))).toEqual([
        "alice entregou",
        "alice escreveu",
      ]);
    });

    it("person: <id> lists that person's cards in the member's scope only", async () => {
      const aliceCtx = await bearer(aliceSecret);
      expect(titles(await listed(aliceCtx, { person: bobId }))).toEqual(["bob pegou"]);
      expect(await listed(aliceCtx, { person: outsiderId })).toEqual([]);
    });

    it("refuses a person that is neither me nor an id", async () => {
      const aliceCtx = await bearer(aliceSecret);
      const result = await invokeTool(world.db, aliceCtx, "task_list", { person: "bob" });
      expect(result.ok).toBe(false);
    });
  });
});
