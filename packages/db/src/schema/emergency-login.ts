import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./user";

/**
 * Single-use sign-in links the server owner makes from inside the container
 * (`pnpm emergency-login <email>`), for when the board cannot send mail or the
 * admin is locked out of code sign-in. Only a hash of the token is stored; a
 * row stops working at `expiresAt` or at its first use. Only an active admin
 * gets one.
 */
export const emergencyLogin = pgTable(
  "emergency_login",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("emergency_login_user_idx").on(table.userId)],
);
