import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Failed pairing exchanges, counted for the whole instance.
 *
 * A wrong guess matches no row, because the lookup is by hash, so there is
 * no code to attribute the attempt to and the counter has to live outside
 * the codes. One row is enough: only one code is live per workspace, and
 * the question being asked is whether somebody is guessing at all.
 */
export const pairingFailure = pgTable("pairing_failure", {
  /** Fixed key. This table holds exactly one row. */
  id: text("id").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
