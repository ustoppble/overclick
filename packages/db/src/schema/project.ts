import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProjectContextSource } from "../types";
import { organization } from "./organization";
import { workspace } from "./workspace";

export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /**
     * The business this project belongs to. Restrict, not cascade: deleting a
     * business must never silently destroy the repos under it.
     */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    repoUrl: text("repo_url"),
    /** Markdown handed to every agent that works on this project. */
    context: text("context"),
    /** Free-form release/tag currently running for this project. */
    currentVersion: text("current_version"),
    /** Optional GitHub release/context sources and their refresh policy. */
    contextSource: jsonb("context_source").$type<ProjectContextSource>(),
    /** Newest prerelease seen without replacing the stable version. */
    latestPrerelease: text("latest_prerelease"),
    /** Last time a source or a human changed the project context. */
    contextUpdatedAt: timestamp("context_updated_at", { withTimezone: true }),
    idPrefix: text("id_prefix").notNull(),
    nextNumber: integer("next_number").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique("project_workspace_prefix").on(table.workspaceId, table.idPrefix)],
);
