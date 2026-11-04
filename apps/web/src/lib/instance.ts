import {
  FIRST_ADMIN_LOCK_KEY,
  KNOWN_EXECUTORS,
  canCreateFirstAdmin,
  user,
  workspace,
} from "@agent-board/db";
import { count, sql, type SQL } from "drizzle-orm";
import type { McpDatabase } from "../mcp/types";
import { db } from "./db";
import { redeemSignupCode, setupScope } from "./signup-code";

export async function countUsers(): Promise<number> {
  const [row] = await db().select({ n: count() }).from(user);
  return Number(row?.n ?? 0);
}

export type FirstAdminResult =
  | { ok: true; id: string; sessionVersion: number }
  | { ok: false; reason: "exists" | "code" };

/**
 * Spends the setup code sent to `email` and creates the first admin, in one
 * transaction that takes an advisory lock first. Counting accounts, spending
 * the code and inserting the admin used to be separate statements: two setups
 * finishing together, each with a code right for its own address, both counted
 * an empty instance and both made an admin. Under the lock the second one
 * waits for the first to commit, counts one account and is told an admin
 * exists, and its code is left unspent (nothing is written for it).
 *
 * A wrong code is a normal return, not a throw, so the failure it counted
 * (`redeemSignupCode`) is committed with the rest. Anything that does throw
 * rolls the code back with it, so a crash between the two does not burn it.
 * The lock is held to the end of the transaction, so setup is serialised
 * instance-wide; it runs once per instance. The default isolation level
 * cannot raise a serialization failure here; the unique email is the net for
 * a path that ever skips the lock, and counts as "an admin exists".
 */
export async function createFirstAdminWithCode(
  database: McpDatabase,
  email: string,
  code: string,
): Promise<FirstAdminResult> {
  try {
    return await database.transaction(async (tx) => {
      await (tx as unknown as { execute(query: SQL): Promise<unknown> }).execute(
        sql`select pg_advisory_xact_lock(${FIRST_ADMIN_LOCK_KEY}::bigint)`,
      );
      const [row] = await tx.select({ n: count() }).from(user);
      if (!canCreateFirstAdmin(Number(row?.n ?? 0))) {
        return { ok: false, reason: "exists" } as const;
      }
      if (!(await redeemSignupCode(tx as McpDatabase, setupScope(email), email, code))) {
        return { ok: false, reason: "code" } as const;
      }
      const [created] = await tx
        .insert(user)
        .values({ email, role: "admin" })
        .returning({ id: user.id, sessionVersion: user.sessionVersion });
      if (!created) throw new Error("failed to create the first admin");
      return { ok: true, id: created.id, sessionVersion: created.sessionVersion } as const;
    });
  } catch (error) {
    // 23505: the unique email, hit by an admin made outside the lock.
    const { code, cause } = error as { code?: string; cause?: { code?: string } };
    if (code === "23505" || cause?.code === "23505") return { ok: false, reason: "exists" };
    throw error;
  }
}

export async function ensureWorkspace(): Promise<{ id: string }> {
  const [existing] = await db()
    .select({ id: workspace.id })
    .from(workspace)
    .limit(1);
  if (existing) return existing;

  const [created] = await db()
    .insert(workspace)
    .values({
      name: "Agent Board",
      executors: KNOWN_EXECUTORS,
    })
    .returning({ id: workspace.id });

  // No harness policy is seeded (OCL-202): the board records which harness
  // ran a card, the Overclock app decides which one runs.
  if (!created) throw new Error("failed to create workspace");

  return created;
}
