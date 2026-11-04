import { executionAttempt, mcpToken, mission, projectMember, task, taskComment, user, workspace } from "@agent-board/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateBearer } from "./auth";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";
import { generateTokenSecret, hashToken } from "./token";
import type { AuthContext } from "./types";

const origem = { session_id: "sess_member_guards", cli: "test" };
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  ...extra,
});
const executor = (session_id: string) => ({ cli: "claude", model: "opus-5", effort: "high", session_id });
const usage = { estimated: true, reason: "test", tokens_in: 1, tokens_out: 1 };

/**
 * What a member's own token may do to a claim or a mission that someone else
 * holds. The member sees the admin's cards and missions that touch a project
 * linked to them; seeing is all they get: no taking over the admin's claim
 * (force, stale or deliver) and no changing or deleting the admin's mission.
 */
describe("MCP as a member: another person's claim and mission stay theirs", () => {
  let world: TestWorld;
  let admin: AuthContext;
  let memberId: string;
  let memberSecret: string;
  let adminCard: string;
  let adminMissionCard: string;

  const asMember = async (): Promise<AuthContext> => {
    const auth = await authenticateBearer(world.db, `Bearer ${memberSecret}`);
    if (!auth.ok) throw new Error("member token should authenticate");
    return auth.ctx;
  };
  const shortOf = (value: unknown) => (value as { task: { short_id: string } }).task.short_id;
  const statusOf = async (shortId: string) =>
    (await world.db.select().from(task).where(eq(task.shortId, shortId)))[0]!;

  beforeEach(async () => {
    world = await createTestWorld();
    const [m] = await world.db
      .insert(user)
      .values({ email: "member@example.test", role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    memberId = m!.id;
    memberSecret = generateTokenSecret();
    await world.db.insert(mcpToken).values({
      workspaceId: world.workspaceId,
      ownerUserId: memberId,
      label: "member-agent",
      hash: hashToken(memberSecret),
      tokenPrefix: memberSecret.slice(0, 12),
    });
    await world.db.insert(projectMember).values({ projectId: world.projectId, userId: memberId });
    admin = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin",
      canManage: false,
    };
    const a = await invokeTool(world.db, admin, "task_create", card("do admin", { project_id: world.projectId, mission: world.missionId }));
    const b = await invokeTool(world.db, admin, "task_create", card("do admin, na missão", { project_id: world.projectId, mission: world.missionId }));
    if (!a.ok || !b.ok) throw new Error("fixture cards failed");
    adminCard = shortOf(a.value);
    adminMissionCard = shortOf(b.value);
  });

  afterEach(async () => {
    await closeTestWorld(world);
  });

  /** The admin's agent holds the card; optionally the claim is already stale. */
  async function adminHolds(shortId: string, stale = false) {
    const claimed = await invokeTool(world.db, admin, "task_claim", { task_id: shortId, executor: executor("admin-s") });
    if (!claimed.ok) throw new Error(JSON.stringify(claimed));
    if (stale) {
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const row = await statusOf(shortId);
      await world.db.update(task).set({ claimedAt: old }).where(eq(task.id, row.id));
      await world.db.update(executionAttempt).set({ lastActivityAt: old, startedAt: old }).where(eq(executionAttempt.taskId, row.id));
      await world.db.update(workspace).set({ claimTimeoutMinutes: 5 }).where(eq(workspace.id, world.workspaceId));
    }
  }

  describe("claims", () => {
    it("refuses a force claim over the admin's claim, and the admin keeps the card", async () => {
      await adminHolds(adminCard);
      const member = await asMember();
      const taken = await invokeTool(world.db, member, "task_claim", { task_id: adminCard, force: true, executor: executor("m-s") });
      expect(!taken.ok && taken.error.code).toBe("PERMISSION_DENIED");
      expect((await statusOf(adminCard)).claimedByTokenId).toBe(world.tokenId);
    });

    it("refuses to reclaim the admin's stale claim", async () => {
      await adminHolds(adminCard, true);
      const member = await asMember();
      const taken = await invokeTool(world.db, member, "task_claim", { task_id: adminCard, executor: executor("m-s") });
      expect(!taken.ok && taken.error.code).toBe("PERMISSION_DENIED");
      const row = await statusOf(adminCard);
      expect(row.status).toBe("em_execucao");
      expect(row.claimedByTokenId).toBe(world.tokenId);
    });

    it("refuses to deliver a card the admin's token holds", async () => {
      await adminHolds(adminCard);
      const member = await asMember();
      const delivered = await invokeTool(world.db, member, "task_deliver", { task_id: adminCard, summary: "feito", usage });
      expect(!delivered.ok && delivered.error.code).toBe("PERMISSION_DENIED");
      expect((await statusOf(adminCard)).status).toBe("em_execucao");
    });

    it("still claims a free card, takes back its own claim by force, and delivers it", async () => {
      const member = await asMember();
      const first = await invokeTool(world.db, member, "task_claim", { task_id: adminCard, executor: executor("m1") });
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const again = await invokeTool(world.db, member, "task_claim", { task_id: adminCard, force: true, executor: executor("m2") });
      expect(again.ok, JSON.stringify(again)).toBe(true);
      const delivered = await invokeTool(world.db, member, "task_deliver", { task_id: adminCard, summary: "feito", usage });
      expect(delivered.ok, JSON.stringify(delivered)).toBe(true);
    });

    it("a second token of the same member counts as the same holder", async () => {
      const member = await asMember();
      await invokeTool(world.db, member, "task_claim", { task_id: adminCard, executor: executor("m1") });
      const secret = generateTokenSecret();
      await world.db.insert(mcpToken).values({
        workspaceId: world.workspaceId,
        ownerUserId: memberId,
        label: "member-agent-2",
        hash: hashToken(secret),
        tokenPrefix: secret.slice(0, 12),
      });
      const auth = await authenticateBearer(world.db, `Bearer ${secret}`);
      if (!auth.ok) throw new Error("second member token should authenticate");
      const forced = await invokeTool(world.db, auth.ctx, "task_claim", { task_id: adminCard, force: true, executor: executor("m3") });
      expect(forced.ok, JSON.stringify(forced)).toBe(true);
    });

    it("the admin still takes over a member's claim, by force and when stale, and delivers it", async () => {
      const member = await asMember();
      await invokeTool(world.db, member, "task_claim", { task_id: adminCard, executor: executor("m1") });
      const forced = await invokeTool(world.db, admin, "task_claim", { task_id: adminCard, force: true, executor: executor("a1") });
      expect(forced.ok, JSON.stringify(forced)).toBe(true);

      const delivered = await invokeTool(world.db, admin, "task_deliver", { task_id: adminCard, summary: "feito", usage });
      expect(delivered.ok, JSON.stringify(delivered)).toBe(true);
    });
  });

  it("the admin reclaims a member's stale claim without force", async () => {
    const member = await asMember();
    await invokeTool(world.db, member, "task_claim", { task_id: adminCard, executor: executor("m1") });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const row = await statusOf(adminCard);
    await world.db.update(task).set({ claimedAt: old }).where(eq(task.id, row.id));
    await world.db.update(executionAttempt).set({ lastActivityAt: old, startedAt: old }).where(eq(executionAttempt.taskId, row.id));
    await world.db.update(workspace).set({ claimTimeoutMinutes: 5 }).where(eq(workspace.id, world.workspaceId));
    const taken = await invokeTool(world.db, admin, "task_claim", { task_id: adminCard, executor: executor("a1") });
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
  });

  describe("missions", () => {
    it("sees the admin's mission but cannot update it", async () => {
      const member = await asMember();
      expect((await invokeTool(world.db, member, "mission_get", { mission_id: world.missionId })).ok).toBe(true);
      const updated = await invokeTool(world.db, member, "mission_update", { mission_id: world.missionId, title: "Mudado", status: "pausada" });
      expect(!updated.ok && updated.error.code).toBe("PERMISSION_DENIED");
      const [row] = await world.db.select().from(mission).where(eq(mission.id, world.missionId));
      expect(row?.title).toBe("Norte do board");
      expect(row?.status).toBe("ativa");
    });

    it("cannot delete the admin's mission, with or without force", async () => {
      const member = await asMember();
      for (const force of [false, true]) {
        const deleted = await invokeTool(world.db, member, "mission_delete", { mission_id: world.missionId, force });
        expect(!deleted.ok && deleted.error.code, `force=${force}`).toBe("PERMISSION_DENIED");
      }
      const [row] = await world.db.select().from(mission).where(eq(mission.id, world.missionId));
      expect(row).toBeDefined();
      expect((await statusOf(adminMissionCard)).missionId).toBe(world.missionId);
    });

    it("updates and deletes the mission it wrote", async () => {
      const member = await asMember();
      const made = await invokeTool(world.db, member, "mission_create", { title: "Minha" });
      if (!made.ok) throw new Error(JSON.stringify(made));
      const id = (made.value as { mission: { id: string } }).mission.id;
      const updated = await invokeTool(world.db, member, "mission_update", { mission_id: id, title: "Minha 2" });
      expect(updated.ok, JSON.stringify(updated)).toBe(true);
      const deleted = await invokeTool(world.db, member, "mission_delete", { mission_id: id });
      expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    });

    it("does not file a card in the admin's mission, new or existing; its own mission, yes", async () => {
      const member = await asMember();
      const created = await invokeTool(world.db, member, "task_create", card("meu", { project_id: world.projectId, mission: world.missionId }));
      expect(!created.ok && created.error.code).toBe("PERMISSION_DENIED");

      const loose = await invokeTool(world.db, member, "task_create", card("solto", { project_id: world.projectId }));
      if (!loose.ok) throw new Error(JSON.stringify(loose));
      const looseId = shortOf(loose.value);
      const moved = await invokeTool(world.db, member, "task_update", { task_id: looseId, mission_id: world.missionId });
      expect(!moved.ok && moved.error.code).toBe("PERMISSION_DENIED");
      expect((await statusOf(looseId)).missionId).toBeNull();

      const own = await invokeTool(world.db, member, "mission_create", { title: "Minha" });
      if (!own.ok) throw new Error(JSON.stringify(own));
      const ownId = (own.value as { mission: { id: string } }).mission.id;
      const ok = await invokeTool(world.db, member, "task_update", { task_id: looseId, mission_id: ownId });
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
    });

    it("the admin still edits, moves cards in and deletes a member's mission", async () => {
      const member = await asMember();
      const own = await invokeTool(world.db, member, "mission_create", { title: "Do member" });
      if (!own.ok) throw new Error(JSON.stringify(own));
      const ownId = (own.value as { mission: { id: string } }).mission.id;
      expect((await invokeTool(world.db, admin, "mission_update", { mission_id: ownId, title: "Do member 2" })).ok).toBe(true);
      expect((await invokeTool(world.db, admin, "mission_delete", { mission_id: ownId })).ok).toBe(true);
      expect((await invokeTool(world.db, admin, "mission_update", { mission_id: world.missionId, title: "Norte 2" })).ok).toBe(true);
    });
  });

  describe("the run another person's token holds", () => {
    const attemptOf = async (shortId: string) => {
      const row = await statusOf(shortId);
      return (await world.db.select().from(executionAttempt).where(eq(executionAttempt.taskId, row.id)))[0]!;
    };

    it("refuses usage, spawn_failure and resolved_in on the admin's claim, and writes none of them", async () => {
      await adminHolds(adminCard);
      const before = await attemptOf(adminCard);
      const member = await asMember();
      const writes: Record<string, unknown>[] = [
        { usage: { tokens_in: 999999, tokens_out: 1, estimated: true, reason: "x" } },
        { spawn_failure: "boot falhou" },
        { resolved_in: "v9.9.9" },
      ];
      for (const write of writes) {
        const done = await invokeTool(world.db, member, "task_update", { task_id: adminCard, ...write });
        expect(!done.ok && done.error.code, JSON.stringify(write)).toBe("PERMISSION_DENIED");
      }
      const after = await attemptOf(adminCard);
      expect(after.tokensIn).toBe(before.tokensIn);
      expect((await statusOf(adminCard)).resolvedIn).toBeNull();
      const traces = await world.db.select().from(taskComment)
        .where(and(eq(taskComment.taskId, after.taskId), eq(taskComment.kind, "spawn_failure")));
      expect(traces).toHaveLength(0);
    });

    it("refuses usage and revisado on a card the admin's token delivered", async () => {
      await adminHolds(adminCard);
      const delivered = await invokeTool(world.db, admin, "task_deliver", { task_id: adminCard, summary: "feito", usage });
      expect(delivered.ok, JSON.stringify(delivered)).toBe(true);
      const member = await asMember();
      const marked = await invokeTool(world.db, member, "task_update", { task_id: adminCard, revisado: true });
      expect(!marked.ok && marked.error.code).toBe("PERMISSION_DENIED");
      expect((await statusOf(adminCard)).revisado).toBe(false);
      const fixed = await invokeTool(world.db, member, "task_update", { task_id: adminCard, usage: { tokens_in: 999999, tokens_out: 1, estimated: true, reason: "x" } });
      expect(!fixed.ok && fixed.error.code).toBe("PERMISSION_DENIED");
      expect((await attemptOf(adminCard)).tokensIn).toBe(1);
    });

    it("refuses branch_register on the admin's claim", async () => {
      await adminHolds(adminCard);
      const member = await asMember();
      const branch = await invokeTool(world.db, member, "branch_register", { task_id: adminCard, branch: "evil" });
      expect(!branch.ok && branch.error.code).toBe("PERMISSION_DENIED");
      expect((await statusOf(adminCard)).branch).not.toBe("evil");
    });

    it("still comments on the admin's card: commenting is collaboration", async () => {
      await adminHolds(adminCard);
      const member = await asMember();
      const said = await invokeTool(world.db, member, "task_update", { task_id: adminCard, comment: "vi um detalhe" });
      expect(said.ok, JSON.stringify(said)).toBe(true);
    });

    it("on its own claim the member writes usage, spawn_failure, resolved_in and the branch", async () => {
      const member = await asMember();
      await invokeTool(world.db, member, "task_claim", { task_id: adminCard, executor: executor("m1") });
      for (const write of [
        { usage: { tokens_in: 5, tokens_out: 1, estimated: true, reason: "x" } },
        { spawn_failure: "boot falhou" },
        { resolved_in: "v1.0.0" },
      ]) {
        const done = await invokeTool(world.db, member, "task_update", { task_id: adminCard, ...write });
        expect(done.ok, JSON.stringify(done)).toBe(true);
      }
      const branch = await invokeTool(world.db, member, "branch_register", { task_id: adminCard, branch: "ocl-meu" });
      expect(branch.ok, JSON.stringify(branch)).toBe(true);
    });

    it("the admin still corrects usage and the branch on a member's claim", async () => {
      const member = await asMember();
      await invokeTool(world.db, member, "task_claim", { task_id: adminCard, executor: executor("m1") });
      const fixed = await invokeTool(world.db, admin, "task_update", { task_id: adminCard, usage: { tokens_in: 7, tokens_out: 1, estimated: true, reason: "x" } });
      expect(fixed.ok, JSON.stringify(fixed)).toBe(true);
      const branch = await invokeTool(world.db, admin, "branch_register", { task_id: adminCard, branch: "ocl-admin" });
      expect(branch.ok, JSON.stringify(branch)).toBe(true);
    });
  });

  describe("moving a card out of a mission", () => {
    const ownMission = async (member: AuthContext) => {
      const own = await invokeTool(world.db, member, "mission_create", { title: "Minha" });
      if (!own.ok) throw new Error(JSON.stringify(own));
      return (own.value as { mission: { id: string } }).mission.id;
    };

    it("does not take the admin's card out of the admin's mission, to none or to its own", async () => {
      const member = await asMember();
      const mine = await ownMission(member);
      for (const target of [null, mine]) {
        const moved = await invokeTool(world.db, member, "task_update", { task_id: adminMissionCard, mission_id: target });
        expect(!moved.ok && moved.error.code, String(target)).toBe("PERMISSION_DENIED");
        expect((await statusOf(adminMissionCard)).missionId).toBe(world.missionId);
      }
    });

    it("does not move a card the admin's token is running, even a loose one into its own mission", async () => {
      const loose = await invokeTool(world.db, admin, "task_create", card("solto do admin", { project_id: world.projectId }));
      if (!loose.ok) throw new Error(JSON.stringify(loose));
      const looseId = shortOf(loose.value);
      await adminHolds(looseId);
      const member = await asMember();
      const mine = await ownMission(member);
      const moved = await invokeTool(world.db, member, "task_update", { task_id: looseId, mission_id: mine });
      expect(!moved.ok && moved.error.code).toBe("PERMISSION_DENIED");
      expect((await statusOf(looseId)).missionId).toBeNull();
    });

    it("moves its own card from its own mission to none", async () => {
      const member = await asMember();
      const mine = await ownMission(member);
      const made = await invokeTool(world.db, member, "task_create", card("meu", { project_id: world.projectId, mission: mine }));
      if (!made.ok) throw new Error(JSON.stringify(made));
      const id = shortOf(made.value);
      const moved = await invokeTool(world.db, member, "task_update", { task_id: id, mission_id: null });
      expect(moved.ok, JSON.stringify(moved)).toBe(true);
      expect((await statusOf(id)).missionId).toBeNull();
    });

    it("the admin still takes a member's card out of the member's mission", async () => {
      const member = await asMember();
      const mine = await ownMission(member);
      const made = await invokeTool(world.db, member, "task_create", card("meu", { project_id: world.projectId, mission: mine }));
      if (!made.ok) throw new Error(JSON.stringify(made));
      const id = shortOf(made.value);
      const moved = await invokeTool(world.db, admin, "task_update", { task_id: id, mission_id: world.missionId });
      expect(moved.ok, JSON.stringify(moved)).toBe(true);
    });
  });

  describe("what a member reads of an admin's card", () => {
    it("task_get does not show the admin token's label as the card's agent", async () => {
      // No origem on the card: the board fills it with the creating token's label.
      const made = await invokeTool(world.db, admin, "task_create", {
        title: "sem origem",
        type: "feature",
        o_que: "o que",
        por_que: "por que",
        como_confirmo: [{ step: "faz", expected: "funciona" }],
        project_id: world.projectId,
      });
      if (!made.ok) throw new Error(JSON.stringify(made));
      const id = shortOf(made.value);
      const adminSees = await invokeTool(world.db, admin, "task_get", { task_id: id });
      expect(JSON.stringify(adminSees)).toContain('"agent":"admin"');
      const member = await asMember();
      const seen = await invokeTool(world.db, member, "task_get", { task_id: id });
      expect(seen.ok, JSON.stringify(seen)).toBe(true);
      expect(JSON.stringify(seen)).not.toContain('"agent":"admin"');
    });

    it("task_get comments do not show the admin token's label as the author; its own comments read as written", async () => {
      await invokeTool(world.db, admin, "task_update", { task_id: adminCard, comment: "nota do admin" });
      const member = await asMember();
      await invokeTool(world.db, member, "task_update", { task_id: adminCard, comment: "nota do member" });
      const authors = async (who: AuthContext) => {
        const got = await invokeTool(world.db, who, "task_get", { task_id: adminCard, include: ["comments"] });
        if (!got.ok) throw new Error(JSON.stringify(got));
        const comments = (got.value as { comments?: { author: string; body: string }[] }).comments ?? [];
        return Object.fromEntries(comments.map((c) => [c.body, c.author]));
      };
      expect(await authors(admin)).toMatchObject({ "nota do admin": "admin", "nota do member": "member-agent" });
      const seen = await authors(member);
      expect(seen["nota do member"]).toBe("member-agent");
      expect(seen["nota do admin"]).toBeDefined();
      expect(seen["nota do admin"]).not.toBe("admin");
    });
  });
});
