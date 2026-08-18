import {
  type AnyPgColumn,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Harness, TaskOrigin, ValidationTick } from "../types";
import {
  executionModeEnum,
  reviewerKindEnum,
  taskPriorityEnum,
  taskStatusEnum,
  taskTypeEnum,
} from "./enums";
import { mcpToken } from "./mcp-token";
import { mission } from "./mission";
import { project } from "./project";
import { user } from "./user";

export const task = pgTable(
  "task",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id").references(() => mission.id, {
    onDelete: "set null",
  }),
  parentId: uuid("parent_id").references((): AnyPgColumn => task.id, {
    onDelete: "cascade",
  }),
  /** Card this one continues after an executor was abandoned. */
  supersedesId: uuid("supersedes_id").references((): AnyPgColumn => task.id, {
    onDelete: "set null",
  }),
  /** Replacement card that made this card obsolete. */
  supersededById: uuid("superseded_by_id").references(
    (): AnyPgColumn => task.id,
    { onDelete: "set null" },
  ),
  shortId: text("short_id").notNull().unique(),
  /**
   * Short ids this card carried before, oldest first. Moving a card to another
   * project restamps `shortId` with the destination prefix, and the id that
   * external references (branches, commits, PRs) already point at is kept here
   * instead of disappearing.
   */
  previousShortIds: jsonb("previous_short_ids")
    .$type<string[]>()
    .notNull()
    .default([]),
  title: text("title").notNull(),
  oQue: text("o_que").notNull().default(""),
  porQue: text("por_que").notNull().default(""),
  comoConfirmo: text("como_confirmo").notNull().default(""),
  tipo: taskTypeEnum("tipo").notNull().default("feature"),
  status: taskStatusEnum("status").notNull().default("aberto"),
  revisado: boolean("revisado").notNull().default(false),
  priority: taskPriorityEnum("priority").notNull().default("media"),
  devolveParaKind: reviewerKindEnum("devolve_para_kind")
    .notNull()
    .default("workspace_queue"),
  devolveParaUserId: uuid("devolve_para_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  devolveParaAgentRef: text("devolve_para_agent_ref"),
  harness: jsonb("harness").$type<Harness>(),
  branch: text("branch"),
  prUrl: text("pr_url"),
  /**
   * Version, tag or release in which this card was resolved, as free text
   * ("1.4.0", "v2026.08", a release name). Null until someone says so:
   * task_deliver sets it on the way out, task_update fills or corrects it
   * later, and it can be cleared with null.
   */
  resolvedIn: text("resolved_in"),
  origin: jsonb("origin").$type<TaskOrigin>(),
  mode: executionModeEnum("mode").notNull().default("solo"),
  telemetryIncomplete: boolean("telemetry_incomplete").notNull().default(false),
  validationTicks: jsonb("validation_ticks")
    .$type<ValidationTick[]>()
    .notNull()
    .default([]),
  isExample: boolean("is_example").notNull().default(false),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedByExecutor: text("claimed_by_executor"),
  claimedByTokenId: uuid("claimed_by_token_id").references(() => mcpToken.id, {
    onDelete: "set null",
  }),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  },
  (table) => [
    index("task_project_idx").on(table.projectId),
    index("task_status_idx").on(table.status),
    index("task_parent_idx").on(table.parentId),
    index("task_supersedes_idx").on(table.supersedesId),
    index("task_superseded_by_idx").on(table.supersededById),
  ],
);
