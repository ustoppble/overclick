import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { missionStatusEnum } from "./enums";
import { organization } from "./organization";
import { workspace } from "./workspace";

export const mission = pgTable("mission", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" }),
  /** The business this mission runs for. Restrict, like project. */
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  objective: text("objective").notNull().default(""),
  context: text("context").notNull().default(""),
  status: missionStatusEnum("status").notNull().default("ativa"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
