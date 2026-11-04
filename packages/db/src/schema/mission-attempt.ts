import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  CostBreakdownSegment,
  CostSource,
  CostStatus,
} from "../domain/pricing";
import type { TranscriptRef } from "../domain/transcript";
import type { UsageSegment } from "../domain/usage";
import type { AttemptModelSource } from "../types";
import { missionAttemptStatusEnum } from "./enums";
import { mission } from "./mission";
import { project } from "./project";

/** One orchestration run for a mission, independent of any task card. */
export const missionAttempt = pgTable(
  "mission_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => mission.id, { onDelete: "cascade" }),
    /** Null means the mission crossed projects; never duplicate its cost. */
    projectId: uuid("project_id").references(() => project.id, {
      onDelete: "set null",
    }),
    executor: text("executor"),
    /**
     * The MCP token that opened the attempt; only it (or an admin) may report
     * on it. No foreign key: a web session is not a token row, and null (an
     * attempt from before this column, or a revoked opener) is admin-only.
     */
    openedByTokenId: uuid("opened_by_token_id"),
    model: text("model"),
    /** Declared exactly, inferred from the harness, or corrected by usage. */
    modelSource: text("model_source").$type<AttemptModelSource>(),
    /** Required stable identity used by the reused-session guard. */
    sessionId: text("session_id").notNull(),
    /** Reference only; the transcript content never enters the board. */
    transcript: jsonb("transcript").$type<TranscriptRef>(),
    status: missionAttemptStatusEnum("status").notNull().default("aberto"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Cumulative segments; one entry per model that actually ran. */
    usageSegments: jsonb("usage_segments").$type<UsageSegment[]>(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    tokensCache: integer("tokens_cache"),
    /** Raw executor figure, used only when the board cannot price segments. */
    reportedCostUsd: numeric("reported_cost_usd", {
      precision: 12,
      scale: 6,
    }),
    /** Frozen price snapshot, shared with execution_attempt. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    costSource: text("cost_source").$type<CostSource>(),
    costStatus: text("cost_status").$type<CostStatus>(),
    costUnpricedModels: jsonb("cost_unpriced_models").$type<string[]>(),
    costBreakdown: jsonb("cost_breakdown").$type<CostBreakdownSegment[]>(),
    durationMs: integer("duration_ms"),
    serverDurationMs: integer("server_duration_ms"),
    turns: integer("turns"),
    usageEstimated: boolean("usage_estimated").notNull().default(false),
    usageSuspect: boolean("usage_suspect").notNull().default(false),
    usageSuspectReason: text("usage_suspect_reason"),
    result: text("result"),
    resultNote: text("result_note"),
    lastReportSequence: integer("last_report_sequence").notNull().default(0),
  },
  (table) => [
    index("mission_attempt_mission_idx").on(table.missionId),
    index("mission_attempt_project_idx").on(table.projectId),
    index("mission_attempt_session_idx").on(table.sessionId),
    uniqueIndex("mission_attempt_open_mission_uidx")
      .on(table.missionId)
      .where(sql`${table.status} = 'aberto'`),
    check(
      "mission_attempt_status_finished_ck",
      sql`(${table.status} = 'aberto' AND ${table.finishedAt} IS NULL) OR (${table.status} <> 'aberto' AND ${table.finishedAt} IS NOT NULL)`,
    ),
    check(
      "mission_attempt_suspect_reason_ck",
      sql`${table.usageSuspect} = false OR ${table.usageSuspectReason} IS NOT NULL`,
    ),
    check(
      "mission_attempt_last_report_sequence_ck",
      sql`${table.lastReportSequence} >= 0`,
    ),
  ],
);
