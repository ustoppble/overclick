import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspace } from "./workspace";

/**
 * A business inside the instance. One workspace holds many of them, and every
 * project and mission belongs to exactly one, so a board that carries the repos
 * of several unrelated businesses can still be read one business at a time.
 */
export const organization = pgTable(
  "organization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Markdown handed to every agent that works anywhere in this business. */
    context: text("context"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique("organization_workspace_name").on(table.workspaceId, table.name)],
);
