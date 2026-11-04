import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { user } from "./user";
import { workspace } from "./workspace";

/**
 * An admin's invitation for one person to join one organization as a member
 * (OCL-222). The link carries a random secret; only its hash is stored, so the
 * table alone cannot be turned back into a working link. Single use: accepting
 * stamps `usedAt` in the same statement that checks it is still empty.
 */
export const invitation = pgTable(
  "invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * The projects the member will work on, linked when the link is accepted.
     * Only projects of `organizationId`; an empty list makes a member who sees
     * no project until an admin links one.
     */
    projectIds: uuid("project_ids").array().notNull().default([]),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** Set when an admin withdraws the link before anyone used it. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    usedByUserId: uuid("used_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("invitation_workspace_idx").on(table.workspaceId)],
);
