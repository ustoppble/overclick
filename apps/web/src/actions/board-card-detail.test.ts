import {
  executionAttempt,
  handoff,
  task,
  taskComment,
  user,
  type Database,
} from "@agent-board/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBoardCards } from "../lib/board-card";
import { loadBoardTasks } from "../lib/board-tasks";
import { dict } from "../lib/i18n";
import type { Principal } from "../lib/scope";
import {
  adminPrincipal,
  closeTestWorld,
  createTestWorld,
  type TestWorld,
} from "../mcp/test-db";

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

const { loadBoardCardDetailAction } = await import("./board-cards");

const NOT_FOUND = { ok: false, error: "Card not found." };

/**
 * The board's list carries only what a card's line shows; handoffs, comments
 * and attempts come when the card is opened, through the reader's own scope.
 */
describe("board card line and detail", () => {
  let memberId = "";

  beforeEach(async () => {
    world = await createTestWorld();
    const [member] = await world.db
      .insert(user)
      .values({
        email: "member@example.test",
        passwordHash: "x",
        role: "member",
        organizationId: world.organizationId,
      })
      .returning({ id: user.id });
    memberId = member!.id;
    sessionUserId = "";
  });

  afterEach(async () => {
    sessionUserId = "";
    if (world) await closeTestWorld(world);
  });

  function database(): Database {
    return world.db as unknown as Database;
  }

  /** A delivered card with two runs, a handoff with evidences and comments. */
  async function deliveredCard(shortId: string, createdByUserId: string) {
    const [row] = await world.db
      .insert(task)
      .values({
        projectId: world.projectId,
        shortId,
        title: `delivered ${shortId}`,
        oQue: "WHAT-BODY",
        porQue: "WHY-BODY",
        comoConfirmo: JSON.stringify([{ step: "STEP-ONE", expected: "EXPECTED-ONE" }]),
        status: "feito",
        createdByUserId,
      })
      .returning({ id: task.id });
    const id = row!.id;
    const now = Date.now();
    await world.db.insert(executionAttempt).values([
      {
        taskId: id,
        executor: JSON.stringify({ cli: "codex" }),
        model: "gpt-5",
        startedAt: new Date(now - 3 * 3_600_000),
        lastActivityAt: new Date(now - 3 * 3_600_000),
        tokensIn: 1,
        tokensOut: 1,
        durationMs: 1000,
      },
      {
        taskId: id,
        executor: JSON.stringify({ cli: "claude", effort: "high" }),
        model: "sonnet-5",
        startedAt: new Date(now - 3_600_000),
        lastActivityAt: new Date(now - 3_600_000),
        tokensIn: 1200,
        tokensOut: 800,
        durationMs: 300_000,
        transcript: {
          cli: "claude",
          sessionId: "SESSION-XYZ",
          path: "/tmp/TRANSCRIPT-PATH.jsonl",
          resume: "claude --resume SESSION-XYZ",
        },
      },
    ]);
    await world.db.insert(handoff).values({
      taskId: id,
      summary: "HANDOFF-SUMMARY",
      howToVerify: "HOW-TO-VERIFY",
      evidences: [{ kind: "text", value: "EVIDENCE-VALUE" }],
      branch: "ocl-branch",
      commitHash: "abc1234",
    });
    await world.db.insert(taskComment).values([
      { taskId: id, body: "COMMENT-BODY", kind: "comment" },
      { taskId: id, body: "REPORT-BODY", kind: "report" },
    ]);
    return id;
  }

  const heavy = [
    "HANDOFF-SUMMARY",
    "HOW-TO-VERIFY",
    "EVIDENCE-VALUE",
    "COMMENT-BODY",
    "REPORT-BODY",
    "TRANSCRIPT-PATH",
    "SESSION-XYZ",
    "WHAT-BODY",
    "WHY-BODY",
    "STEP-ONE",
  ];

  it("the line carries none of the heavy arrays, and still the numbers its line shows", async () => {
    const id = await deliveredCard("OC-1", world.adminUserId);
    const rows = await loadBoardTasks(database(), [world.projectId], adminPrincipal(world), {
      period: "all",
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]! as Record<string, unknown>;
    expect(row).not.toHaveProperty("comments");
    expect(row).not.toHaveProperty("handoffs");
    expect(row).not.toHaveProperty("attempts");
    const rowText = JSON.stringify(rows);
    for (const word of heavy) expect(rowText).not.toContain(word);

    const [card] = toBoardCards(rows, {
      tr: dict("en"),
      pricingEnabled: false,
      viewerId: world.adminUserId,
      claimTimeoutMinutes: 30,
    });
    const cardText = JSON.stringify(card);
    for (const word of heavy) expect(cardText).not.toContain(word);
    for (const key of ["timeline", "handoff", "howToVerify", "transcript", "telemetry", "oQue"]) {
      expect(card).not.toHaveProperty(key);
    }
    // What the line draws comes summarised from the query.
    expect(card!.id).toBe(id);
    expect(card!.ranCli).toBe("claude");
    expect(card!.harnessChain).toBe("sonnet-5");
    expect(card!.executors).toEqual(["claude", "codex"]);
    expect(card!.telemetryLine.map((segment) => segment.kind)).toEqual(["duration", "tokens"]);
    expect(card!.telemetryLine[1]!.text).toBe("2k");
  });

  it("loads the detail on demand: contract, handoff, timeline and transcript", async () => {
    const id = await deliveredCard("OC-2", world.adminUserId);
    sessionUserId = world.adminUserId;
    const result = await loadBoardCardDetailAction(id);
    if (!result.ok) throw new Error(result.error);
    const { detail } = result;
    expect(detail.id).toBe(id);
    expect(detail.oQue).toBe("WHAT-BODY");
    expect(detail.porQue).toBe("WHY-BODY");
    expect(detail.comoConfirmo).toEqual([{ step: "STEP-ONE", expected: "EXPECTED-ONE" }]);
    expect(detail.handoff).toBe("HANDOFF-SUMMARY");
    expect(detail.howToVerify).toBe("HOW-TO-VERIFY");
    expect(detail.branch).toBe("ocl-branch");
    expect(detail.commit).toBe("abc1234");
    expect(detail.timeline.map((entry) => entry.body)).toEqual(["COMMENT-BODY", "REPORT-BODY"]);
    expect(detail.reportsCount).toBe(1);
    expect(detail.transcript?.sessionId).toBe("SESSION-XYZ");
    expect(detail.harness).toBe("sonnet-5 · high");
    expect(detail.telemetry).toContain("2k tok");
    // The evidences stay where the board never reads them.
    expect(JSON.stringify(detail)).not.toContain("EVIDENCE-VALUE");
  });

  it("a member opens their own card and gets 'Card not found.' for anyone else's", async () => {
    const adminCard = await deliveredCard("OC-3", world.adminUserId);
    const memberCard = await deliveredCard("OC-4", memberId);
    sessionUserId = memberId;

    const own = await loadBoardCardDetailAction(memberCard);
    expect(own.ok).toBe(true);
    const other = await loadBoardCardDetailAction(adminCard);
    expect(other).toEqual(NOT_FOUND);
    expect(JSON.stringify(other)).not.toContain("HANDOFF-SUMMARY");

    // The admin reads both.
    sessionUserId = world.adminUserId;
    expect((await loadBoardCardDetailAction(memberCard)).ok).toBe(true);
    expect((await loadBoardCardDetailAction(adminCard)).ok).toBe(true);
  });

  it("answers 'Card not found.' without a session, for an unknown id and for input that is not an id", async () => {
    const id = await deliveredCard("OC-5", world.adminUserId);
    sessionUserId = "";
    expect(await loadBoardCardDetailAction(id)).toEqual(NOT_FOUND);
    sessionUserId = world.adminUserId;
    expect(await loadBoardCardDetailAction("00000000-0000-4000-8000-000000000000")).toEqual(
      NOT_FOUND,
    );
    expect(await loadBoardCardDetailAction("OC-5")).toEqual(NOT_FOUND);
    expect(await loadBoardCardDetailAction({ $ne: 1 } as never)).toEqual(NOT_FOUND);
  });

  it("a member's detail is scoped by the same rule as their board", async () => {
    const memberCard = await deliveredCard("OC-6", memberId);
    const member: Principal = {
      userId: memberId,
      role: "member",
      organizationId: world.organizationId,
    };
    const rows = await loadBoardTasks(database(), [world.projectId], member, { period: "all" });
    expect(rows.map((row) => row.id)).toEqual([memberCard]);
  });
});
