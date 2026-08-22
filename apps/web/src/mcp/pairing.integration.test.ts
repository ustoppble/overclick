import { mcpToken, pairingCode, workspace } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPairingCode,
  exchangePairingCode,
  MAX_PAIRING_FAILURES,
  pairingStatus,
  spendAttemptStatement,
} from "../lib/pairing";
import { authenticateBearer } from "./auth";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";

/** Two callers the endpoint can tell apart, as a proxy in front would. */
const GUESSER = "203.0.113.9";
const AGENT = "198.51.100.4";

/** Well-formed codes that are not any of the live ones. */
function wrongGuesses(count: number, real: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i++) {
    const code = String(i % 1_000_000).padStart(6, "0");
    if (!real.includes(code)) out.push(code);
  }
  return out;
}

describe("one-time token pairing", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("stops looking at codes once the budget is spent, instead of consuming them", async () => {
    world = await createTestWorld();
    const created = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "paired via code",
    });

    // Wrong guesses, all at once. Sequential attempts were never the threat:
    // the failure path costs a flat delay each, paid in parallel, so a caller
    // with connections to spare was bounded by its own concurrency and not by
    // the delay. A budget is what a hundred parallel guesses cannot outrun.
    const wrong = wrongGuesses(MAX_PAIRING_FAILURES, [created.code]);
    await Promise.all(
      wrong.map((code) => exchangePairingCode(world.db, code, GUESSER)),
    );

    // Now the right code, from the caller that spent the budget. It loses,
    // and the interesting part is how: the row is untouched. A budget read
    // after the exchange would have consumed the code before noticing, and
    // burning the live codes on the way out would have deleted it.
    const buried = await exchangePairingCode(world.db, created.code, GUESSER);
    expect(buried.ok).toBe(false);

    const [row] = await world.db
      .select()
      .from(pairingCode)
      .where(eq(pairingCode.id, created.id));
    expect(row).toBeDefined();
    expect(row?.consumedAt).toBeNull();
    expect(row?.secret).not.toBe("");

    // The same code, from the agent the human is actually pairing, works
    // right now: the budget belongs to whoever spent it.
    const honest = await exchangePairingCode(world.db, created.code, AGENT);
    expect(honest.ok).toBe(true);
  });

  it.each([50, 200, 1000])(
    "buries the real code at the end of a %i-guess burst and never evaluates it",
    async (burst) => {
      world = await createTestWorld();
      const created = await createPairingCode(world.db, {
        workspaceId: world.workspaceId,
        label: "paired via code",
      });

      // The real code goes last, which is exactly where a budget counted
      // after the exchange still lets it through: by then the guesser has
      // spent many times the budget, so the only thing that saves the code
      // is refusing to look at it.
      const codes = [
        ...wrongGuesses(burst - 1, [created.code]),
        created.code,
      ];
      const results = await Promise.all(
        codes.map((code) => exchangePairingCode(world.db, code, GUESSER)),
      );
      expect(results.some((result) => result.ok)).toBe(false);

      const [row] = await world.db
        .select()
        .from(pairingCode)
        .where(eq(pairingCode.id, created.id));
      expect(row?.consumedAt).toBeNull();

      // Nothing was minted either: no token carries the label the code
      // would have handed out.
      const minted = await world.db
        .select()
        .from(mcpToken)
        .where(eq(mcpToken.label, "paired via code"));
      expect(minted).toHaveLength(0);
    },
    60_000,
  );

  it("does not punish a human who mistypes once and then gets it right", async () => {
    world = await createTestWorld();
    const created = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "paired via code",
    });

    const typo = created.code === "000000" ? "111111" : "000000";
    const missed = await exchangePairingCode(world.db, typo, AGENT);
    expect(missed.ok).toBe(false);

    const second = await exchangePairingCode(world.db, created.code, AGENT);
    expect(second.ok).toBe(true);
  });

  it("keeps a burst against one code away from another workspace's", async () => {
    world = await createTestWorld();
    const [neighbour] = await world.db
      .insert(workspace)
      .values({ name: "Neighbour" })
      .returning({ id: workspace.id });
    if (!neighbour) throw new Error("failed to insert neighbour workspace");

    const mine = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "mine",
    });
    const theirs = await createPairingCode(world.db, {
      workspaceId: neighbour.id,
      label: "theirs",
    });

    const wrong = wrongGuesses(MAX_PAIRING_FAILURES * 20, [
      mine.code,
      theirs.code,
    ]);
    await Promise.all(
      wrong.map((code) => exchangePairingCode(world.db, code, GUESSER)),
    );

    // Both codes are still there. Burning every unconsumed code once the
    // budget ran out made ten anonymous requests enough to take out the
    // pairing of a workspace the guesser had never heard of.
    const live = await world.db.select().from(pairingCode);
    expect(live).toHaveLength(2);

    // And the neighbour pairs while the burst is still charged to the
    // caller that made it.
    const paired = await exchangePairingCode(world.db, theirs.code, AGENT);
    expect(paired.ok).toBe(true);
  });

  it("lets the human reopen pairing a guesser drained when no origin is known", async () => {
    world = await createTestWorld();
    const created = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "paired via code",
    });

    // No proxy in front, so nobody can be told apart and everyone shares
    // one bucket. A burst still drains it, and still destroys nothing.
    const wrong = wrongGuesses(MAX_PAIRING_FAILURES * 5, [created.code]);
    await Promise.all(
      wrong.map((code) => exchangePairingCode(world.db, code)),
    );
    const refused = await exchangePairingCode(world.db, created.code);
    expect(refused.ok).toBe(false);

    // The way out is the human, not the clock: generating a code is a
    // signed-in action no guesser can reach, and it clears the budget. What
    // that costs is bounded — a budget's worth of guesses against a brand
    // new number out of a million.
    const fresh = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "paired via code",
    });
    const paired = await exchangePairingCode(world.db, fresh.code);
    expect(paired.ok).toBe(true);
  });

  it("exchanges a 6-digit code for a working bearer token, once", async () => {
    world = await createTestWorld();
    const created = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "paired via code",
    });
    expect(created.code).toMatch(/^\d{6}$/);
    expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const exchanged = await exchangePairingCode(world.db, created.code);
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    expect(exchanged.label).toBe("paired via code");

    // The token from the exchange authenticates against /mcp.
    const auth = await authenticateBearer(
      world.db,
      `Bearer ${exchanged.token}`,
    );
    expect(auth.ok).toBe(true);

    // The plaintext secret is gone from the pairing row.
    const [row] = await world.db
      .select()
      .from(pairingCode)
      .where(eq(pairingCode.id, created.id));
    expect(row?.secret).toBe("");
    expect(row?.tokenId).toBeTruthy();

    // Single use: the same code never works twice.
    const again = await exchangePairingCode(world.db, created.code);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error).toMatch(/not found or expired/i);
    }

    const status = await pairingStatus(world.db, created.id);
    expect(status.paired).toBe(true);
  });

  it("rejects unknown, malformed and expired codes without leaking anything", async () => {
    world = await createTestWorld();

    const unknown = await exchangePairingCode(world.db, "000000");
    expect(unknown.ok).toBe(false);

    const malformed = await exchangePairingCode(world.db, "ocb_notacode");
    expect(malformed.ok).toBe(false);

    const created = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "expired",
    });
    await world.db
      .update(pairingCode)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pairingCode.id, created.id));
    const expired = await exchangePairingCode(world.db, created.code);
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.error).not.toMatch(/ocb_|select |failed query/i);
    }
  });

  /**
   * The regression this suite could not have caught on its own (OCL-109).
   *
   * These tests run on PGlite, which accepts a `Date` as a query parameter.
   * Production runs postgres-js, which does not: it answered every call to
   * /api/pair with a 500 while this file stayed green. A parameter that goes
   * through a column mapper is fine either way; one interpolated into `sql`
   * has no column to map it, so it arrives as whatever it was. The assertion
   * is therefore about what is sent, not about what a driver tolerates.
   */
  it("sends no Date to the driver, which is what broke every real pairing", async () => {
    world = await createTestWorld();
    const { params } = spendAttemptStatement(
      world.db,
      "origin:203.0.113.9",
      new Date("2026-08-20T12:00:00.000Z"),
    ).toSQL();

    expect(params.length).toBeGreaterThan(0);
    expect(params.filter((param) => param instanceof Date)).toEqual([]);
  });

  it("keeps a single active code per workspace", async () => {
    world = await createTestWorld();
    const first = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "first",
    });
    const second = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "second",
    });

    const staleFirst = await exchangePairingCode(world.db, first.code);
    // The second code replaced the first; only one live code can exist,
    // unless both codes randomly collided (1 in a million, ignore).
    if (first.code !== second.code) {
      expect(staleFirst.ok).toBe(false);
    }
    const live = await exchangePairingCode(world.db, second.code);
    expect(live.ok).toBe(true);
  });
  /**
   * The second pairing on a workspace used to be impossible.
   *
   * `mcp_token_workspace_label` is unique on (workspace_id, label) and the
   * default label is a constant, so the insert threw and `/api/pair` answered
   * 500 — permanently, because nothing in the UI can free a label. The path
   * there is the most ordinary one there is: pair again after a first attempt
   * died before the token reached the agent.
   */
  it("pairs a second agent when the default label is already taken", async () => {
    world = await createTestWorld();

    const first = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "paired agent",
    });
    const one = await exchangePairingCode(world.db, first.code, AGENT);
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.label).toBe("paired agent");

    const second = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "paired agent",
    });
    const two = await exchangePairingCode(world.db, second.code, AGENT);

    // Before the fix this was `{ ok: false }` via a thrown unique violation,
    // surfaced to the caller as HTTP 500.
    expect(two.ok).toBe(true);
    if (two.ok) expect(two.label).toBe("paired agent (2)");

    // Two usable tokens, and the labels still tell them apart. The world is
    // seeded with fixture tokens of its own, so look only at the ones this
    // test paired.
    const rows = await world.db
      .select({ label: mcpToken.label })
      .from(mcpToken)
      .where(eq(mcpToken.workspaceId, world.workspaceId));
    const paired = rows
      .map((r) => r.label)
      .filter((label) => label.startsWith("paired agent"))
      .sort();
    expect(paired).toEqual(["paired agent", "paired agent (2)"]);
    if (one.ok) expect(await authenticateBearer(world.db, `Bearer ${one.token}`)).toBeTruthy();
    if (two.ok) expect(await authenticateBearer(world.db, `Bearer ${two.token}`)).toBeTruthy();
  });

  /**
   * Revoking is what an operator reaches for after a pairing goes wrong, so it
   * is the one action that must not make the next attempt worse. The unique
   * constraint does not exclude revoked rows, so the label outlives the token
   * it belonged to.
   */
  it("does not let a revoked token hold its label hostage", async () => {
    world = await createTestWorld();

    const first = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "paired agent",
    });
    const one = await exchangePairingCode(world.db, first.code, AGENT);
    expect(one.ok).toBe(true);

    await world.db
      .update(mcpToken)
      .set({ revoked: true })
      .where(eq(mcpToken.workspaceId, world.workspaceId));

    const second = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label: "paired agent",
    });
    const two = await exchangePairingCode(world.db, second.code, AGENT);

    expect(two.ok).toBe(true);
    if (two.ok) {
      expect(two.label).toBe("paired agent (2)");
      expect(await authenticateBearer(world.db, `Bearer ${two.token}`)).toBeTruthy();
    }
  });
});
