import { createHash, randomInt } from "node:crypto";
import { mcpToken, pairingCode, pairingFailure } from "@agent-board/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { generateTokenSecret, hashToken } from "../mcp/token";
import type { McpDatabase } from "../mcp/types";

/**
 * One-time pairing: the human reads a 6-digit code to the agent, the agent
 * exchanges it on the public endpoint and receives the real bearer token.
 * The token value never travels through a chat. The code is consumed on
 * first use and expires quickly; only one code is active per workspace.
 */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses tolerated before the live codes are burned.
 *
 * Six digits is a million combinations, which sounds like plenty until you
 * notice nothing serialises the attempts: a flat delay on the failure path
 * is paid by each request on its own, so concurrent requests wait in
 * parallel and the ceiling is the caller's connection count, not the delay.
 * Inside a ten minute TTL that is reachable, and the prize is a real bearer
 * token for the workspace.
 *
 * Counting instead of slowing removes the concurrency advantage: guesses
 * cost a budget that a hundred parallel connections drain a hundred times
 * faster, and draining it is what burns the code.
 */
export const MAX_PAIRING_FAILURES = 10;

/** This table holds one row for the whole instance. */
const FAILURE_KEY = "global";

export function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(`ovk-pair:${code}`, "utf8").digest("hex");
}

export function isValidPairingCodeFormat(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export async function createPairingCode(
  db: McpDatabase,
  input: { workspaceId: string; label: string; userId?: string },
): Promise<{ id: string; code: string; expiresAt: Date }> {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);

  // One active code per workspace: a new code replaces any unconsumed one,
  // which also keeps the guessing space at a single live code.
  await db
    .delete(pairingCode)
    .where(
      and(
        eq(pairingCode.workspaceId, input.workspaceId),
        isNull(pairingCode.consumedAt),
      ),
    );

  const [row] = await db
    .insert(pairingCode)
    .values({
      workspaceId: input.workspaceId,
      codeHash: hashPairingCode(code),
      secret: generateTokenSecret(),
      label: input.label.trim() || "paired agent",
      createdByUserId: input.userId ?? null,
      expiresAt,
    })
    .returning({ id: pairingCode.id });
  if (!row) throw new Error("failed to insert pairing code");

  return { id: row.id, code, expiresAt };
}

/**
 * Counts one wrong guess and, once the budget for the window is gone,
 * burns every unconsumed code. The human is told to generate another one,
 * which costs them a sentence; the guesser goes back to a fresh million.
 *
 * The window is the code TTL: outside it there is no live code to protect,
 * so the count starts over.
 */
async function recordFailure(db: McpDatabase): Promise<void> {
  const now = new Date();
  const windowFloor = new Date(now.getTime() - PAIRING_CODE_TTL_MS);

  // One statement, so parallel guesses cannot read the same count and each
  // write back the same increment.
  const [row] = await db
    .insert(pairingFailure)
    .values({ id: FAILURE_KEY, count: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: pairingFailure.id,
      set: {
        count: sql`case when ${pairingFailure.windowStartedAt} < ${windowFloor}
          then 1 else ${pairingFailure.count} + 1 end`,
        windowStartedAt: sql`case when ${pairingFailure.windowStartedAt} < ${windowFloor}
          then ${now} else ${pairingFailure.windowStartedAt} end`,
      },
    })
    .returning({ count: pairingFailure.count });

  if ((row?.count ?? 0) < MAX_PAIRING_FAILURES) return;

  await db.delete(pairingCode).where(isNull(pairingCode.consumedAt));
  await db
    .update(pairingFailure)
    .set({ count: 0, windowStartedAt: now })
    .where(eq(pairingFailure.id, FAILURE_KEY));
}

/** A successful pairing clears the budget: nobody was guessing. */
async function clearFailures(db: McpDatabase): Promise<void> {
  await db
    .update(pairingFailure)
    .set({ count: 0 })
    .where(eq(pairingFailure.id, FAILURE_KEY));
}

export type ExchangeResult =
  | { ok: true; token: string; label: string }
  | { ok: false; error: string };

export async function exchangePairingCode(
  db: McpDatabase,
  rawCode: string,
): Promise<ExchangeResult> {
  const notFound: ExchangeResult = {
    ok: false,
    error:
      "Pairing code not found or expired. Ask the human to generate a fresh code in the board Settings or onboarding wizard.",
  };
  if (!isValidPairingCodeFormat(rawCode.trim())) {
    await recordFailure(db);
    return notFound;
  }

  const result: ExchangeResult = await db.transaction(async (tx) => {
    // Consume atomically: the update only wins while consumed_at is null,
    // so a second exchange with the same code loses even in a race.
    const [consumed] = await tx
      .update(pairingCode)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(pairingCode.codeHash, hashPairingCode(rawCode.trim())),
          isNull(pairingCode.consumedAt),
        ),
      )
      .returning();
    if (!consumed) return notFound;
    if (consumed.expiresAt.getTime() < Date.now()) return notFound;

    const secret = consumed.secret;
    const [token] = await tx
      .insert(mcpToken)
      .values({
        workspaceId: consumed.workspaceId,
        label: consumed.label,
        hash: hashToken(secret),
        tokenPrefix: secret.slice(0, 12),
        createdByUserId: consumed.createdByUserId,
      })
      .returning({ id: mcpToken.id });
    if (!token) throw new Error("failed to create token from pairing code");

    // Blank the plaintext secret: from here on only the token hash exists.
    await tx
      .update(pairingCode)
      .set({ secret: "", tokenId: token.id })
      .where(eq(pairingCode.id, consumed.id));

    return { ok: true, token: secret, label: consumed.label };
  });

  if (result.ok) await clearFailures(db);
  else await recordFailure(db);
  return result;
}

/** Wizard polling: paired once the code was exchanged. */
export async function pairingStatus(
  db: McpDatabase,
  id: string,
): Promise<{ paired: boolean }> {
  const [row] = await db
    .select({ consumedAt: pairingCode.consumedAt })
    .from(pairingCode)
    .where(eq(pairingCode.id, id))
    .limit(1);
  return { paired: row?.consumedAt != null };
}
