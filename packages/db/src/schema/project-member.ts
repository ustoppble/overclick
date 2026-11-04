import { index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { project } from "./project";
import { user } from "./user";

/**
 * Which projects a member works on. A member sees the projects linked here,
 * inside their own organization, and every card in them; a member with no row
 * sees no project at all. Admins have no rows and no fence. A new project is
 * linked to nobody: the admin ticks who works on it.
 */
export const projectMember = pgTable(
  "project_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The admin who made the link; null for the links the migration made. */
    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    unique("project_member_project_user").on(table.projectId, table.userId),
    index("project_member_user_idx").on(table.userId),
  ],
);
