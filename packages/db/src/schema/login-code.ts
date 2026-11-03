import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./user";

/**
 * One-time sign-in codes sent by email: the six digits a person types instead
 * of a password. Only a keyed hash of the code is stored, never the code, and
 * a row stops working at whichever comes first: `expiresAt`, its first use
 * (`consumedAt`), or `attempts` reaching the cap. Issuing a new code deletes
 * the account's previous ones, and a partial unique index holds the line the
 * code alone cannot: two asks racing past it still leave one live code.
 */
export const loginCode = pgTable(
  "login_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    /** Verifications spent on this code, right or wrong. */
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("login_code_user_idx").on(table.userId),
    uniqueIndex("login_code_one_live_per_user_idx")
      .on(table.userId)
      .where(sql`${table.consumedAt} is null`),
  ],
);
