import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { McpDatabase } from "../mcp/types";

/**
 * The shape every attempt-budget table shares: a scope string as primary key,
 * a count, and the window it started counting in. First written for pairing
 * codes (`pairing_failure`); login attempts (`login_failure`) reuse the exact
 * same accounting instead of growing a second copy of it.
 */
type BudgetTable = PgTable & {
  id: PgColumn;
  count: PgColumn;
  windowStartedAt: PgColumn;
};

/** What `db.insert(table)` needs to expose for the chain below, independent of which concrete table it is. */
type UntypedInsert = {
  values(row: Record<string, unknown>): {
    onConflictDoUpdate(opts: {
      target: PgColumn;
      set: Record<string, unknown>;
    }): {
      returning(columns: Record<string, PgColumn>): UntypedInsertResult;
    };
  };
};

/** The same looseness for `db.update(table)`, for the same reason as `UntypedInsert`. */
type UntypedUpdate = {
  set(values: Record<string, unknown>): { where(condition: SQL | undefined): Promise<unknown> };
};

/** A drizzle query: awaits to rows, and `.toSQL()` inspects it unexecuted (see `pairing.integration.test.ts`). */
type UntypedInsertResult = Promise<Array<{ count: number }>> & {
  toSQL(): { sql: string; params: unknown[] };
};

/**
 * Charges one attempt to `scope` and reports the count it landed on, in a
 * single statement so a burst of concurrent callers cannot all read the same
 * count and write back the same increment — see `pairing.ts` for the full
 * argument. The window resets on its own once `windowMs` has passed since it
 * started, so a caller need not run any cleanup job.
 *
 * The two timestamps are sent as explicit `::timestamptz` casts, not as
 * `Date` values, because a value interpolated into `sql` reaches the driver
 * as whatever it already was; postgres-js refuses a bare `Date` there (see
 * OCL-109, and `pairing.integration.test.ts` for the regression this once
 * caused).
 */
/**
 * `T` varies per caller (`pairingFailure`, `loginFailure`, ...) but drizzle's
 * `onConflictDoUpdate`/`returning` generics do not narrow cleanly through a
 * type parameter that only promises the three columns above, so the chain
 * below is built loosely and the result cast back to the shape every one of
 * these tables actually returns. Each concrete table still gets full type
 * checking at its own call site (`db.insert(pairingFailure)` etc. elsewhere
 * in the codebase); this function is the one place that trades that away for
 * sharing the statement itself.
 */
export function spendBudgetStatement<T extends BudgetTable>(
  db: McpDatabase,
  table: T,
  scope: string,
  now: Date,
  windowMs: number,
) {
  const windowFloor = new Date(now.getTime() - windowMs);
  const floorParam = sql`${windowFloor.toISOString()}::timestamptz`;
  const nowParam = sql`${now.toISOString()}::timestamptz`;

  return (db.insert(table) as UntypedInsert)
    .values({ id: scope, count: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: table.id,
      set: {
        count: sql`case when ${table.windowStartedAt} < ${floorParam}
          then 1 else ${table.count} + 1 end`,
        windowStartedAt: sql`case when ${table.windowStartedAt} < ${floorParam}
          then ${nowParam} else ${table.windowStartedAt} end`,
      },
    })
    .returning({ count: table.count }) as UntypedInsertResult;
}

/** Spends one attempt and says whether `scope` is still inside its budget. */
export async function spendBudget<T extends BudgetTable>(
  db: McpDatabase,
  table: T,
  scope: string,
  maxAttempts: number,
  windowMs: number,
): Promise<boolean> {
  const [row] = await spendBudgetStatement(db, table, scope, new Date(), windowMs);
  return (row?.count ?? 1) <= maxAttempts;
}

/**
 * Gives back one attempt `spendBudget` took from `scope`, for a caller that
 * spends first and learns afterwards that the attempt was not one to count.
 * One statement, so it cannot undercount a burst either; a window that has
 * already run its course has nothing to give back, and the count never goes
 * below zero.
 */
export async function refundBudget<T extends BudgetTable>(
  db: McpDatabase,
  table: T,
  scope: string,
  windowMs: number,
  now: Date = new Date(),
): Promise<void> {
  const floor = new Date(now.getTime() - windowMs);
  await (db.update(table) as UntypedUpdate)
    .set({ count: sql`greatest(${table.count} - 1, 0)` })
    .where(
      and(
        eq(table.id, scope),
        gte(table.windowStartedAt, sql`${floor.toISOString()}::timestamptz`),
      ),
    );
  // A bucket given back down to nothing is no bucket: drop the row rather
  // than leave one per origin that only ever signed in correctly. Judged by
  // the database at delete time, so a spend that lands in between keeps it.
  await db.delete(table).where(and(eq(table.id, scope), lte(table.count, 0)));
}

/** A success clears the budget: nobody there was guessing. */
export async function clearBudget<T extends BudgetTable>(
  db: McpDatabase,
  table: T,
  scope: string,
): Promise<void> {
  await db.delete(table).where(eq(table.id, scope));
}

/**
 * Whether `scope` has already used up its budget in the window it is
 * counting in, without spending anything. A window that has run its course
 * counts as empty, the same as `spendBudgetStatement` would treat it.
 */
export async function budgetExhausted<T extends BudgetTable>(
  db: McpDatabase,
  table: T,
  scope: string,
  maxAttempts: number,
  windowMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = (await db
    .select({ count: table.count, windowStartedAt: table.windowStartedAt })
    .from(table as PgTable)
    .where(eq(table.id, scope))) as Array<{ count: number; windowStartedAt: Date }>;
  if (!row) return false;
  return (
    row.count >= maxAttempts &&
    row.windowStartedAt.getTime() >= now.getTime() - windowMs
  );
}
