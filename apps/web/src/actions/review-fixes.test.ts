import { invitation, mission, pairingCode, task, user, type Database } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBoardTasks } from "../lib/board-tasks";
import { loadInsightAttemptRows, loadMissionAttemptRows, loadReopenRows } from "../lib/insights";
import {
  createInvitation,
  decodeInvitationSecret,
  inspectInvitation,
} from "../lib/invitations";
import { loadOrganizationOverviews } from "../lib/organizations-query";
import {
  createPairingCode,
  exchangePairingCode,
  MAX_PAIRING_CODES_PER_USER,
  MAX_PAIRING_FAILURES,
} from "../lib/pairing";
import { principalFromUserId } from "../lib/scope";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";
import { invokeToolForTests as invokeTool } from "../mcp/test-tools";
import type { AuthContext } from "../mcp/types";

let world: TestWorld;
let sessionUserId = "";
/** The address the proxy in front says the signed-in browser is at. */
let requestIp = "";

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

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(requestIp ? { "x-forwarded-for": requestIp } : {}),
}));

const { createPairingCodeAction, pollPairingAction } = await import("./tokens");
const { releaseClaimAction } = await import("./claims");
const { discardTaskAction } = await import("./discard");
const { deleteEmptyMissionAction } = await import("./missions");
const {
  answerOpenTaskAction,
  reopenTaskAction,
  tickValidationStepAction,
  validateTaskAction,
  unvalidateTaskAction,
} = await import("./review");

const ADMIN_IP = "198.51.100.4";
const GUESSER_IP = "203.0.113.9";
const MEMBER_IP = "192.0.2.77";

const origem = { session_id: "sess_ocl227_web", cli: "test" };
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: "feature",
  o_que: "o que",
  por_que: "por que",
  como_confirmo: [{ step: "faz", expected: "funciona" }],
  origem,
  ...extra,
});

/** Well-formed codes that are not the live one. */
function wrongGuesses(count: number, real: string): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i++) {
    const code = String(i).padStart(6, "0");
    if (code !== real) out.push(code);
  }
  return out;
}

/**
 * OCL-227: the paths the adversarial review of the web (OCL-224: A1–A4, R1,
 * R2, R5–R7) found from a member's session to the admin's data, each one
 * closed, and the admin still able to do everything.
 */
describe("web review fixes: a member session reaches nothing of the admin's", () => {
  let admin: AuthContext;
  let member: AuthContext;
  let memberId: string;
  let adminCardId: string;
  let memberCardId: string;
  let memberMissionId: string;

  const idOf = (r: Awaited<ReturnType<typeof invokeTool>>) => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.value as { task: { id: string } }).task.id;
  };

  beforeEach(async () => {
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
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
    adminCardId = idOf(await invokeTool(world.db, admin, "task_create", card("do admin", { project_id: world.projectId })));
    memberCardId = idOf(await invokeTool(world.db, member, "task_create", card("do member", { project_id: world.projectId })));
    await world.db
      .update(mission)
      .set({ title: "ADMIN-TITULO-SECRETO" })
      .where(eq(mission.id, world.missionId));
    const [mm] = await world.db
      .insert(mission)
      .values({
        workspaceId: world.workspaceId,
        organizationId: world.organizationId,
        title: "missao do member",
        status: "ativa",
        createdByUserId: memberId,
      })
      .returning({ id: mission.id });
    memberMissionId = mm!.id;
    sessionUserId = memberId;
    requestIp = MEMBER_IP;
  });

  afterEach(async () => {
    sessionUserId = "";
    requestIp = "";
    delete process.env.OVERCLICK_TRUSTED_PROXY;
    if (world) await closeTestWorld(world);
  });

  it("A1: generating codes neither reopens another origin's budget nor goes on forever", async () => {
    // The admin is reading a live code out to their agent.
    const adminCode = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "admin agent",
      userId: world.adminUserId,
      origin: ADMIN_IP,
    });
    // Someone guesses at it until their origin's budget is spent.
    for (const guess of wrongGuesses(MAX_PAIRING_FAILURES, adminCode.code)) {
      expect((await exchangePairingCode(world.db, guess, GUESSER_IP)).ok).toBe(false);
    }

    // The member generates codes, from their own origin and from the
    // guesser's: neither reopens the guesser's budget beyond the cap.
    for (let i = 0; i < MAX_PAIRING_CODES_PER_USER; i++) {
      requestIp = i === 0 ? MEMBER_IP : GUESSER_IP;
      expect(await createPairingCodeAction("member agent")).toMatchObject({ ok: true });
      if (i === 0) {
        // From another origin: the guesser's bucket stays drained, so even
        // the right code is refused unread.
        expect((await exchangePairingCode(world.db, adminCode.code, GUESSER_IP)).ok).toBe(false);
      }
    }
    // Past the cap the action refuses and reopens nothing.
    requestIp = GUESSER_IP;
    for (const guess of wrongGuesses(MAX_PAIRING_FAILURES, adminCode.code)) {
      await exchangePairingCode(world.db, guess, GUESSER_IP);
    }
    const refused = await createPairingCodeAction("member agent");
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/too many pairing codes/i) });
    expect((await exchangePairingCode(world.db, adminCode.code, GUESSER_IP)).ok).toBe(false);

    // The admin's code is untouched, and their own agent still pairs with it.
    const [row] = await world.db.select().from(pairingCode).where(eq(pairingCode.id, adminCode.id));
    expect(row?.consumedAt).toBeNull();
    expect((await exchangePairingCode(world.db, adminCode.code, ADMIN_IP)).ok).toBe(true);

    // The cap is per person: the admin is not held by the member's count.
    sessionUserId = world.adminUserId;
    requestIp = ADMIN_IP;
    expect(await createPairingCodeAction("admin again")).toMatchObject({ ok: true });
  });

  it("R2: pollPairingAction answers only for the member's own pairing", async () => {
    const adminCode = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "admin agent",
      userId: world.adminUserId,
    });
    expect((await exchangePairingCode(world.db, adminCode.code)).ok).toBe(true);
    expect(await pollPairingAction(adminCode.id)).toEqual({ paired: false });
    expect(await pollPairingAction("not-a-uuid")).toEqual({ paired: false });

    const mine = await createPairingCodeAction("member agent");
    if (!mine.ok) throw new Error(mine.error);
    expect((await exchangePairingCode(world.db, mine.code)).ok).toBe(true);
    expect(await pollPairingAction(mine.id)).toEqual({ paired: true });

    sessionUserId = world.adminUserId;
    expect(await pollPairingAction(adminCode.id)).toEqual({ paired: true });
  });

  it("A2: release and discard answer the same for the admin's card, an unknown uuid and a non-uuid", async () => {
    const claim = await invokeTool(world.db, admin, "task_claim", {
      task_id: adminCardId,
      executor: { cli: "claude", model: "sonnet-5" },
    });
    expect(claim.ok).toBe(true);
    const ids = [adminCardId, "00000000-0000-4000-8000-000000000000", "OC-1"];
    const notFound = { ok: false, error: "Card not found." };
    for (const id of ids) {
      expect(await releaseClaimAction(id)).toEqual(notFound);
      expect(await discardTaskAction(id, "no")).toEqual(notFound);
    }
    const [row] = await world.db.select().from(task).where(eq(task.id, adminCardId));
    expect(row?.status).toBe("em_execucao");

    // The admin still releases and discards.
    sessionUserId = world.adminUserId;
    expect(await releaseClaimAction(adminCardId)).toEqual({ ok: true });
    expect(await discardTaskAction(adminCardId, "fora")).toEqual({ ok: true });
  });

  it("OCL-231: the review actions answer a non-uuid id as not found, not with a 500", async () => {
    const notFound = { ok: false, error: "Card not found." };
    for (const who of [memberId, world.adminUserId]) {
      sessionUserId = who;
      for (const id of ["OC-1", "not-a-uuid", "", "' or 1=1 --"]) {
        expect(await answerOpenTaskAction(id, "resposta")).toEqual(notFound);
        expect(await reopenTaskAction(id, "falta")).toEqual(notFound);
        expect(await tickValidationStepAction(id, 0, true)).toEqual(notFound);
        expect(await validateTaskAction(id)).toEqual(notFound);
        expect(await unvalidateTaskAction(id)).toEqual(notFound);
      }
    }
  });

  it("R1: deleteEmptyMissionAction neither counts nor refuses over a card of the admin's", async () => {
    await invokeTool(world.db, admin, "task_update", { task_id: adminCardId, mission_id: memberMissionId });
    expect(await deleteEmptyMissionAction(memberMissionId)).toEqual({ ok: true });
    const [row] = await world.db.select().from(task).where(eq(task.id, adminCardId));
    expect(row).toBeDefined();
    expect(row?.missionId).toBeNull();
  });

  it("R1: with a card of their own in it, the member reads only their count", async () => {
    await invokeTool(world.db, member, "task_update", { task_id: memberCardId, mission_id: memberMissionId });
    await invokeTool(world.db, admin, "task_update", { task_id: adminCardId, mission_id: memberMissionId });
    expect(await deleteEmptyMissionAction(memberMissionId)).toEqual({
      ok: false,
      error: "This mission still holds 1 card. Move them before deleting it.",
    });
  });

  it("R3: only the admin validates or desvalidates a card on the web", async () => {
    await invokeTool(world.db, member, "task_claim", { task_id: memberCardId, executor: { cli: "claude", model: "sonnet-5" } });
    const del = await invokeTool(world.db, member, "task_deliver", {
      task_id: memberCardId,
      summary: "s",
      usage: { segments: [{ model: "sonnet-5", input: 1, output: 1, cache_read: 0, cache_write: 0 }], duration_ms: 1, turns: 1 },
    });
    expect(del.ok).toBe(true);
    const refused = { ok: false, error: "Only an admin can validate a card." };
    expect(await validateTaskAction(memberCardId, { override: true })).toEqual(refused);
    const statusOf = async () =>
      (await world.db.select({ s: task.status }).from(task).where(eq(task.id, memberCardId)))[0]?.s;
    expect(await statusOf()).toBe("feito");

    sessionUserId = world.adminUserId;
    expect(await validateTaskAction(memberCardId, { override: true })).toEqual({ ok: true });
    expect(await statusOf()).toBe("validado");

    sessionUserId = memberId;
    expect(await unvalidateTaskAction(memberCardId)).toEqual(refused);
    expect(await statusOf()).toBe("validado");
  });

  it("A3/A4: the member's board card carries no mission or continuation of the admin's", async () => {
    await invokeTool(world.db, admin, "task_update", { task_id: memberCardId, mission_id: world.missionId });
    // Only a card in execution is continued this way.
    await invokeTool(world.db, member, "task_claim", { task_id: memberCardId, executor: { cli: "claude", model: "sonnet-5" } });
    const continuation = await invokeTool(world.db, admin, "task_create", card("continuacao do admin", {
      project_id: world.projectId,
      supersedes: memberCardId,
    }));
    const continuationId = idOf(continuation);
    const [cont] = await world.db.select().from(task).where(eq(task.id, continuationId));

    const memberP = await principalFromUserId(world.db, memberId);
    const rows = await loadBoardTasks(world.db as unknown as Database, [world.projectId], memberP);
    expect(rows.map((r) => r.id)).toEqual([memberCardId]);
    const mine = rows[0]!;
    expect(mine.mission).toBeNull();
    expect(mine.missionId).toBeNull();
    expect(mine.supersededBy).toBeNull();
    expect(mine.supersededById).toBeNull();
    const text = JSON.stringify(rows);
    expect(text).not.toContain("ADMIN-TITULO-SECRETO");
    expect(text).not.toContain(continuationId);
    expect(text).not.toContain(cont!.shortId);

    // The admin sees both references.
    const adminP = await principalFromUserId(world.db, world.adminUserId);
    const forAdmin = (await loadBoardTasks(world.db as unknown as Database, [world.projectId], adminP)).find(
      (r) => r.id === memberCardId,
    );
    expect(forAdmin?.mission?.title).toBe("ADMIN-TITULO-SECRETO");
    expect(forAdmin?.supersededBy?.id).toBe(continuationId);
  });

  it("A3: insights rows of the member's card carry no mission of the admin's", async () => {
    await invokeTool(world.db, admin, "task_update", { task_id: memberCardId, mission_id: world.missionId });
    await invokeTool(world.db, member, "task_claim", { task_id: memberCardId, executor: { cli: "claude", model: "sonnet-5" } });
    await invokeTool(world.db, member, "task_deliver", {
      task_id: memberCardId,
      summary: "s",
      usage: { segments: [{ model: "sonnet-5", input: 1, output: 1, cache_read: 0, cache_write: 0 }], duration_ms: 1, turns: 1 },
    });
    const memberP = await principalFromUserId(world.db, memberId);
    const rows = await loadInsightAttemptRows(world.db, world.workspaceId, memberP);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.missionId).toBeNull();
    expect(rows[0]!.missionTitle).toBeNull();
    const adminP = await principalFromUserId(world.db, world.adminUserId);
    const forAdmin = await loadInsightAttemptRows(world.db, world.workspaceId, adminP);
    expect(forAdmin.find((r) => r.taskId === memberCardId)?.missionTitle).toBe("ADMIN-TITULO-SECRETO");
  });

  it("R7: insights and the organizations overview hand nothing to a missing principal", async () => {
    await invokeTool(world.db, admin, "task_claim", { task_id: adminCardId, executor: { cli: "claude", model: "sonnet-5" } });
    await invokeTool(world.db, admin, "task_deliver", {
      task_id: adminCardId,
      summary: "s",
      usage: { segments: [{ model: "sonnet-5", input: 1, output: 1, cache_read: 0, cache_write: 0 }], duration_ms: 1, turns: 1 },
    });
    expect(await loadInsightAttemptRows(world.db, world.workspaceId, null)).toEqual([]);
    expect(await loadMissionAttemptRows(world.db, world.workspaceId, null)).toEqual([]);
    expect(await loadReopenRows(world.db, world.workspaceId, null)).toEqual([]);
    expect(await loadOrganizationOverviews(world.db, world.workspaceId, false, [], null)).toEqual([]);
    const adminP = await principalFromUserId(world.db, world.adminUserId);
    expect(await loadInsightAttemptRows(world.db, world.workspaceId, adminP)).toHaveLength(1);
  });

  it("R6: an invite link with a malformed escape reads as invalid, not as an error", async () => {
    expect(decodeInvitationSecret("abc%")).toBe("");
    expect(decodeInvitationSecret("%E0%A4%A")).toBe("");
    expect(await inspectInvitation(world.db, decodeInvitationSecret("abc%zz"))).toEqual({
      ok: false,
      reason: "invalid",
    });
    // A good link still decodes to its secret.
    const created = await createInvitation(world.db, {
      workspaceId: world.workspaceId,
      email: "novo@example.test",
      organizationId: world.organizationId,
      createdByUserId: world.adminUserId,
    });
    if (!created.ok) throw new Error(created.error);
    const found = await inspectInvitation(world.db, decodeInvitationSecret(encodeURIComponent(created.secret)));
    expect(found).toMatchObject({ ok: true, email: "novo@example.test" });
    expect(await world.db.select().from(invitation)).toHaveLength(1);
  });
});
