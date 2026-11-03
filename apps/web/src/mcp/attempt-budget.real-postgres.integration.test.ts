import { loginFailure } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chargeBudget, refundBudget } from "../lib/attempt-budget";
import { createRealPostgresWorld } from "./test-db-postgres";

const SCOPE = "login-origin:203.0.113.9";
const MAX = 8;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * PGlite runs one process and serializes every query, so the in-process
 * suites can show that the origin is charged before the guess is checked but
 * not that the charge itself holds up across connections. This one runs the
 * single-statement accounting through postgres-js, which opens several
 * connections: the charges really do reach Postgres at the same time.
 *
 * Skipped without DATABASE_URL (no real Postgres to talk to) — the CI job
 * sets it against the postgres service; nothing local changes.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "the attempt budget against real postgres-js",
  () => {
    it("lets exactly the limit through when 30 charges arrive at once, and none stays charged but those", async () => {
      const world = await createRealPostgresWorld();
      try {
        const charges = await Promise.all(
          Array.from({ length: 30 }, () =>
            chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS),
          ),
        );

        const accepted = charges.filter((charge) => charge.ok);
        expect(accepted).toHaveLength(MAX);
        const [stored] = await world.db
          .select()
          .from(loginFailure)
          .where(eq(loginFailure.id, SCOPE));
        // The ones turned away left nothing behind.
        expect(stored?.count).toBe(MAX);

        // Giving back what was accepted, all at once too, empties the bucket
        // and drops the row; the floor at zero holds under the race.
        await Promise.all(
          accepted.map((charge) =>
            refundBudget(world.db, loginFailure, SCOPE, charge.windowStartedAt!),
          ),
        );
        const left = await world.db
          .select()
          .from(loginFailure)
          .where(eq(loginFailure.id, SCOPE));
        expect(left.length === 0 || left[0]!.count === 0).toBe(true);
      } finally {
        await world.close();
      }
    }, 60_000);

    it("does not let a charge taken in an old window give back one from the new window", async () => {
      const world = await createRealPostgresWorld();
      try {
        const t0 = new Date("2026-11-03T12:00:00.000Z");
        const first = await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, t0);
        const later = new Date(t0.getTime() + WINDOW_MS + 1);
        await chargeBudget(world.db, loginFailure, SCOPE, MAX, WINDOW_MS, later);

        await refundBudget(world.db, loginFailure, SCOPE, first.windowStartedAt!);

        const [stored] = await world.db
          .select()
          .from(loginFailure)
          .where(eq(loginFailure.id, SCOPE));
        expect(stored?.count).toBe(1);
      } finally {
        await world.close();
      }
    }, 60_000);
  },
);
