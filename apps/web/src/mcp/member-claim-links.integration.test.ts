import { executionAttempt, mcpToken, task, user } from "@agent-board/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";
import type { AuthContext } from "./types";

const origem = { session_id: "sess_ocl231", cli: "test" };
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  ...extra,
});
const executor = { cli: "claude", model: "sonnet-5" };
const usage = {
  segments: [{ model: "sonnet-5", input: 1, output: 1, cache_read: 0, cache_write: 0 }],
  duration_ms: 1,
  turns: 1,
};

/**
 * OCL-231: what the re-verification of OCL-227 (OCL-230) left open. On a card
 * of their own, a member cannot end a claim the admin holds, by force or by
 * delivering, and never reads the id of an admin's mission or card through
 * its links. The admin keeps doing all of it.
 */
describe("a member cannot end the admin's claim nor read the admin's ids", () => {
  let world: TestWorld;
  let admin: AuthContext;
  let member: AuthContext;
  let memberId: string;
  let memberCard: { id: string; short_id: string };

  const call = (ctx: AuthContext, tool: string, input: Record<string, unknown>) =>
    invokeTool(world.db, ctx, tool as never, input);
  const value = <T>(r: Awaited<ReturnType<typeof call>>): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value as T;
  };
  const created = (r: Awaited<ReturnType<typeof call>>) =>
    value<{ task: { id: string; short_id: string } }>(r).task;
  const row = async (id: string) =>
    (await world.db.select().from(task).where(eq(task.id, id)))[0]!;
  const openAttempts = (id: string) =>
    world.db
      .select()
      .from(executionAttempt)
      .where(and(eq(executionAttempt.taskId, id), isNull(executionAttempt.finishedAt)));
  /** A token that really is the member's, as pairing would create it. */
  const memberToken = async (label: string): Promise<AuthContext> => {
    const [tok] = await world.db
      .insert(mcpToken)
      .values({
        workspaceId: world.workspaceId,
        ownerUserId: memberId,
        label,
        hash: `hash-${label}`,
      })
      .returning({ id: mcpToken.id });
    return { ...member, tokenId: tok!.id, tokenLabel: label };
  };

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
    // The admin's token as a plain worker: no manage flag. Forcing and
    // delivering never needed one, and still must not.
    admin = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin",
      canManage: false,
    };
    member = {
      tokenId: "",
      workspaceId: world.workspaceId,
      tokenLabel: "member",
      userId: memberId,
      role: "member",
      organizationId: world.organizationId,
      // The flag an admin can tick on any token; it must widen nothing.
      canManage: true,
    };
    member = await memberToken("member-agent");
    memberCard = created(
      await call(member, "task_create", card("do member", { project_id: world.projectId })),
    );
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("step 1: task_claim with force over the admin's claim is refused, the claim intact", async () => {
    value(await call(admin, "task_claim", { task_id: memberCard.id, executor }));

    const forced = await call(member, "task_claim", { task_id: memberCard.id, force: true, executor });
    expect(forced.ok).toBe(false);
    if (!forced.ok) expect(forced.error.code).toBe("PERMISSION_DENIED");

    const after = await row(memberCard.id);
    expect(after.status).toBe("em_execucao");
    expect(after.claimedByTokenId).toBe(world.tokenId);
    expect(await openAttempts(memberCard.id)).toHaveLength(1);
  });

  it("step 1: a stale admin claim is not taken over by the member either", async () => {
    value(await call(admin, "task_claim", { task_id: memberCard.id, executor }));
    await world.db
      .update(executionAttempt)
      .set({ lastActivityAt: new Date(Date.now() - 61 * 60_000) })
      .where(eq(executionAttempt.taskId, memberCard.id));

    const reclaim = await call(member, "task_claim", { task_id: memberCard.id, executor });
    expect(reclaim.ok).toBe(false);
    if (!reclaim.ok) expect(reclaim.error.code).toBe("ALREADY_CLAIMED");
    expect((await row(memberCard.id)).claimedByTokenId).toBe(world.tokenId);
    expect(await openAttempts(memberCard.id)).toHaveLength(1);
  });

  it("step 2: task_deliver over the admin's claim is refused, the card still the admin's", async () => {
    value(await call(admin, "task_claim", { task_id: memberCard.id, executor }));

    const delivered = await call(member, "task_deliver", { task_id: memberCard.id, summary: "s", usage });
    expect(delivered.ok).toBe(false);
    if (!delivered.ok) expect(delivered.error.code).toBe("PERMISSION_DENIED");

    const after = await row(memberCard.id);
    expect(after.status).toBe("em_execucao");
    expect(after.claimedByTokenId).toBe(world.tokenId);
    const open = await openAttempts(memberCard.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.result).toBeNull();
  });

  it("a member still forces and delivers over a claim of another token of their own", async () => {
    value(await call(member, "task_claim", { task_id: memberCard.id, executor }));
    const reinstalled = await memberToken("member-agent-2");

    value(await call(reinstalled, "task_claim", { task_id: memberCard.id, force: true, executor }));
    expect((await row(memberCard.id)).claimedByTokenId).toBe(reinstalled.tokenId);
    value(await call(member, "task_deliver", { task_id: memberCard.id, summary: "s", usage }));
    expect((await row(memberCard.id)).status).toBe("feito");
  });

  it("step 3: the admin forces and delivers on anyone's card as before", async () => {
    value(await call(member, "task_claim", { task_id: memberCard.id, executor }));
    value(await call(admin, "task_claim", { task_id: memberCard.id, force: true, executor }));
    expect((await row(memberCard.id)).claimedByTokenId).toBe(world.tokenId);
    value(await call(admin, "task_deliver", { task_id: memberCard.id, summary: "s", usage }));
    expect((await row(memberCard.id)).status).toBe("feito");

    // Delivering straight over the member's claim, too.
    const another = created(
      await call(member, "task_create", card("outro do member", { project_id: world.projectId })),
    );
    value(await call(member, "task_claim", { task_id: another.id, executor }));
    value(await call(admin, "task_deliver", { task_id: another.id, summary: "s", usage }));
    expect((await row(another.id)).status).toBe("feito");

    // And on a card of the admin's own claimed by another admin token.
    const own = created(
      await call(admin, "task_create", card("do admin", { project_id: world.projectId })),
    );
    value(await call({ ...admin, tokenId: world.secondTokenId }, "task_claim", { task_id: own.id, executor }));
    value(await call(admin, "task_claim", { task_id: own.id, force: true, executor }));
    value(await call(admin, "task_deliver", { task_id: own.id, summary: "s", usage }));
  });

  it("step 4: task_get of the member's card leaves out the admin's mission and continuation ids", async () => {
    value(await call(admin, "task_update", { task_id: memberCard.id, mission_id: world.missionId }));
    // Only a card in execution can be continued.
    value(await call(member, "task_claim", { task_id: memberCard.id, executor }));
    const continuation = created(
      await call(admin, "task_create", card("continua o do member", {
        project_id: world.projectId,
        supersedes: memberCard.id,
      })),
    );
    // The link the member must not read is really there.
    const stored = await row(memberCard.id);
    expect(stored.missionId).toBe(world.missionId);
    expect(stored.supersededById).toBe(continuation.id);

    const forMember = value<{ task: Record<string, unknown> }>(
      await call(member, "task_get", { task_id: memberCard.id, view: "full" }),
    );
    expect(forMember.task.mission_id ?? null).toBeNull();
    expect(forMember.task.superseded_by ?? null).toBeNull();
    const listed = await call(member, "task_list", { include: ["refs", "ids"] });
    for (const text of [JSON.stringify(forMember), JSON.stringify(listed)]) {
      expect(text).not.toContain(world.missionId);
      expect(text).not.toContain(continuation.id);
    }

    // The admin still reads both links.
    const forAdmin = value<{ task: Record<string, unknown> }>(
      await call(admin, "task_get", { task_id: memberCard.id }),
    );
    expect(forAdmin.task.mission_id).toBe(world.missionId);
    expect(forAdmin.task.superseded_by).toBe(continuation.id);
  });

  it("step 4: the member's own mission still shows on their card", async () => {
    const mine = value<{ mission: { id: string } }>(
      await call(member, "mission_create", { title: "missao do member", objective: "a do member" }),
    );
    value(await call(member, "task_update", { task_id: memberCard.id, mission_id: mine.mission.id }));
    const forMember = value<{ task: Record<string, unknown> }>(
      await call(member, "task_get", { task_id: memberCard.id }),
    );
    expect(forMember.task.mission_id).toBe(mine.mission.id);
  });
});
