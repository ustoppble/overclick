import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Sign-in codes asked for, counted per scope — the same shape as
 * `login_failure` and accounted by the same `attempt-budget` statement. The
 * scope is the email as submitted (twice: a per-minute and a per-hour window)
 * and, behind a trusted proxy, the caller's origin, so the limit is charged
 * before anything looks at whether the account exists.
 */
export const loginCodeRequest = pgTable("login_code_request", {
  /** The scope the request is charged to, e.g. `code-hour-email:x@y.test`. */
  id: text("id").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
