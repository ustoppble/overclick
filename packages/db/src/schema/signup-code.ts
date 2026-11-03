import { sql } from "drizzle-orm";
import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Codes that prove an address before any account exists for it: the first
 * admin's at setup (`scope` = `setup:<email>`) and an invited member's at the
 * invite link (`invite:<invitation id>`). Same rules as `login_code` — only a
 * keyed hash is stored, and a row stops working at `expiresAt`, its first use
 * or `attempts` reaching the cap — but keyed by what the code was sent for,
 * since there is no user to hang it on yet. One live code per scope.
 */
export const signupCode = pgTable(
  "signup_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    /** The address the code went to; the hash is bound to it as well. */
    email: text("email").notNull(),
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
    uniqueIndex("signup_code_one_live_per_scope_idx")
      .on(table.scope)
      .where(sql`${table.consumedAt} is null`),
  ],
);
