import { mcpToken, missionAttempt, projectMember, user } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateBearer } from "./auth";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";
import { generateTokenSecret, hashToken } from "./token";
import type { AuthContext } from "./types";

const origem = { session_id: "sess_attempt_member", cli: "test" };
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  ...extra,
});
const report = (missionId: string, attemptId: string, sequence: number, extra: Record<string, unknown> = {}) => ({
  mission_id: missionId,
  attempt_id: attemptId,
  sequence,
  checkpoint: "rodada",
  usage: { segments: [{ model: "fable-5", input: 100, output: 10 }], duration_ms: 1_000, turns: 1 },
  ...extra,
});

/**
 * A member sees the admin's mission (a card of it sits in a project linked to
 * them) but seeing is all they get: they cannot open an orchestration attempt
 * in it, nor forge usage on or close an attempt somebody else opened.
 */
describe("MCP as a member: mission attempts stay with their author", () => {
  let world: TestWorld;
  let admin: AuthContext;
  let memberId: string;
  const secrets: string[] = [];

  async function memberToken(label: string): Promise<AuthContext> {
    const secret = generateTokenSecret();
    secrets.push(secret);
    await world.db.insert(mcpToken).values({
      workspaceId: world.workspaceId,
      ownerUserId: memberId,
      label,
      hash: hashToken(secret),
      tokenPrefix: secret.slice(0, 12),
    });
    const auth = await authenticateBearer(world.db, `Bearer ${secret}`);
    if (!auth.ok) throw new Error("member token should authenticate");
    return auth.ctx;
  }
  const attemptRow = async (id: string) =>
    (await world.db.select().from(missionAttempt).where(eq(missionAttempt.id, id)))[0]!;
  const startAs = (ctx: AuthContext, missionId: string, session: string) =>
    invokeTool(world.db, ctx, "mission_attempt_start", {
      mission_id: missionId,
      executor: { cli: "claude-code", model: "fable-5", session_id: session },
    });
  const attemptIdOf = (value: unknown) => (value as { attempt_id: string }).attempt_id;

  beforeEach(async () => {
    world = await createTestWorld();
    const [m] = await world.db
      .insert(user)
      .values({ email: "member@example.test", role: "member", organizationId: world.organizationId })
      .returning({ id: user.id });
    memberId = m!.id;
    await world.db.insert(projectMember).values({ projectId: world.projectId, userId: memberId });
    admin = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "admin",
      userId: world.adminUserId,
      role: "admin",
      canManage: false,
    };
    // The card is what makes the admin's mission visible to the member.
    const made = await invokeTool(world.db, admin, "task_create", card("do admin", { project_id: world.projectId, mission: world.missionId }));
    if (!made.ok) throw new Error("fixture card failed");
  });

  afterEach(async () => {
    await closeTestWorld(world);
  });

  describe("mission_attempt_start", () => {
    it("answers as if the admin's mission did not exist, and opens nothing", async () => {
      const member = await memberToken("member-a");
      const seen = await invokeTool(world.db, member, "mission_get", { mission_id: world.missionId });
      expect(seen.ok).toBe(true);

      const started = await startAs(member, world.missionId, "m-1");
      const unknown = await startAs(member, "00000000-0000-4000-8000-000000000000", "m-2");
      expect(!started.ok && started.error.code).toBe("NOT_FOUND");
      expect(!unknown.ok && unknown.error.code).toBe("NOT_FOUND");
      // Same wording as a mission that is not there: nothing tells them it exists.
      expect(!started.ok && started.error.message).toBe(
        (!unknown.ok && unknown.error.message.replace("00000000-0000-4000-8000-000000000000", world.missionId)),
      );
      expect(await world.db.select().from(missionAttempt)).toHaveLength(0);
    });

    it("lets the member orchestrate the mission they wrote, recording the token that opened it", async () => {
      const member = await memberToken("member-a");
      const made = await invokeTool(world.db, member, "mission_create", { title: "Minha" });
      if (!made.ok) throw new Error("mission_create failed");
      const missionId = (made.value as { mission: { id: string } }).mission.id;
      const started = await startAs(member, missionId, "m-own");
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect((await attemptRow(attemptIdOf(started.value))).openedByTokenId).toBe(member.tokenId);
    });
  });

  describe("mission_report_usage", () => {
    it("refuses a member on the admin's attempt: no forged usage, no closing it", async () => {
      const started = await startAs(admin, world.missionId, "admin-s");
      if (!started.ok) throw new Error(JSON.stringify(started));
      const attemptId = attemptIdOf(started.value);
      const member = await memberToken("member-a");

      const forged = await invokeTool(world.db, member, "mission_report_usage", report(world.missionId, attemptId, 1));
      expect(!forged.ok && forged.error.code).toBe("MISSION_ATTEMPT_NOT_FOUND");
      const closed = await invokeTool(
        world.db,
        member,
        "mission_report_usage",
        report(world.missionId, attemptId, 1, { checkpoint: "final", result: "abandoned", result_note: "forjado" }),
      );
      expect(!closed.ok && closed.error.code).toBe("MISSION_ATTEMPT_NOT_FOUND");
      // Without an id the "open attempt" lookup must not reach it either.
      const byOpen = await invokeTool(world.db, member, "mission_report_usage", {
        mission_id: world.missionId,
        sequence: 1,
        checkpoint: "final",
        result: "success",
        usage: { segments: [{ model: "fable-5", input: 1, output: 1 }] },
      });
      expect(!byOpen.ok && byOpen.error.code).toBe("MISSION_ATTEMPT_NOT_FOUND");

      const row = await attemptRow(attemptId);
      expect(row.status).toBe("aberto");
      expect(row.lastReportSequence).toBe(0);
      expect(row.tokensIn).toBeNull();
    });

    it("refuses another token of the same member; only the token that opened it reports, and an admin may", async () => {
      const mine = await memberToken("member-a");
      const other = await memberToken("member-b");
      const made = await invokeTool(world.db, mine, "mission_create", { title: "Minha" });
      if (!made.ok) throw new Error("mission_create failed");
      const missionId = (made.value as { mission: { id: string } }).mission.id;
      const started = await startAs(mine, missionId, "m-own");
      if (!started.ok) throw new Error(JSON.stringify(started));
      const attemptId = attemptIdOf(started.value);

      const foreign = await invokeTool(world.db, other, "mission_report_usage", report(missionId, attemptId, 1));
      expect(!foreign.ok && foreign.error.code).toBe("MISSION_ATTEMPT_NOT_FOUND");
      expect((await attemptRow(attemptId)).lastReportSequence).toBe(0);

      const own = await invokeTool(world.db, mine, "mission_report_usage", report(missionId, attemptId, 1));
      expect(own.ok).toBe(true);
      const byAdmin = await invokeTool(world.db, admin, "mission_report_usage", report(missionId, attemptId, 2));
      expect(byAdmin.ok).toBe(true);
      expect((await attemptRow(attemptId)).lastReportSequence).toBe(2);
    });

    it("treats an attempt with no recorded opener as the admins' only", async () => {
      const mine = await memberToken("member-a");
      const made = await invokeTool(world.db, mine, "mission_create", { title: "Minha" });
      if (!made.ok) throw new Error("mission_create failed");
      const missionId = (made.value as { mission: { id: string } }).mission.id;
      const started = await startAs(mine, missionId, "m-own");
      if (!started.ok) throw new Error(JSON.stringify(started));
      const attemptId = attemptIdOf(started.value);
      await world.db.update(missionAttempt).set({ openedByTokenId: null }).where(eq(missionAttempt.id, attemptId));

      const refused = await invokeTool(world.db, mine, "mission_report_usage", report(missionId, attemptId, 1));
      expect(!refused.ok && refused.error.code).toBe("MISSION_ATTEMPT_NOT_FOUND");
      const byAdmin = await invokeTool(world.db, admin, "mission_report_usage", report(missionId, attemptId, 1));
      expect(byAdmin.ok).toBe(true);
    });
  });
});
