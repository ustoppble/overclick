import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CostBreakdownSegment,
  CostSource,
  CostStatus,
} from "../domain/pricing";
import type { TranscriptRef } from "../domain/transcript";
import type { UsageSegment } from "../domain/usage";
import { task } from "./task";

export const executionAttempt = pgTable(
  "execution_attempt",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => task.id, { onDelete: "cascade" }),
  executor: text("executor"),
  model: text("model"),
  /** Stable executor session used to spot one transcript reused across cards. */
  sessionId: text("session_id"),
  /**
   * Pointer to the agent's own session transcript: cli, session id, the path
   * on the machine that ran the card and the command that reopens it. The
   * reference only, never the content: the file lives on the agent machine
   * and the board has no business holding a stale copy of it.
   */
  transcript: jsonb("transcript").$type<TranscriptRef>(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Lease heartbeat for an open claim. Starts with the claim and is advanced
   * by task_update/task_heartbeat; deliver advances it once more while closing.
   */
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /**
   * Tokens by model, one segment per model that ran. The three flat counters
   * below stay filled with the sum, so a reader that predates segments still
   * gets the same totals; the segments are the truth about who spent what.
   * Null on an attempt that reported no token counter at all.
   */
  usageSegments: jsonb("usage_segments").$type<UsageSegment[]>(),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  tokensCache: integer("tokens_cache"),
  /** Raw figure the executor volunteered; never confused with board math. */
  reportedCostUsd: numeric("reported_cost_usd", { precision: 12, scale: 6 }),
  /** Frozen cost derived when deliver/task_update processed this attempt. */
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  costSource: text("cost_source").$type<CostSource>(),
  costStatus: text("cost_status").$type<CostStatus>(),
  /** Canonical model keys that had tokens but no price at calculation time. */
  costUnpricedModels: jsonb("cost_unpriced_models").$type<string[]>(),
  /** Per-model snapshot used by Insights without consulting today's prices. */
  costBreakdown: jsonb("cost_breakdown").$type<CostBreakdownSegment[]>(),
  durationMs: integer("duration_ms"),
  /**
   * Duration the SERVER measured from claim to deliver. Telemetry that does
   * not depend on agent goodwill: it exists even when the agent reports no
   * usage at all.
   */
  serverDurationMs: integer("server_duration_ms"),
  turns: integer("turns"),
  /** True when the reported usage numbers are the executor's estimate. */
  usageEstimated: boolean("usage_estimated").notNull().default(false),
  /**
   * True when the report could not fit inside claim -> delivery, or when the
   * same executor session had already delivered another card. Delivery still
   * succeeds; Insights keeps these counters outside trusted totals.
   */
  usageSuspect: boolean("usage_suspect").notNull().default(false),
  usageSuspectReason: text("usage_suspect_reason"),
  result: text("result"),
  resultNote: text("result_note"),
  },
  (table) => [index("execution_attempt_task_idx").on(table.taskId)],
);
