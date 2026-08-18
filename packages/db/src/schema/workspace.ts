import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { DEFAULT_CARDAPIO, KNOWN_EXECUTORS } from "../defaults";
import type {
  AutoUpdateRecord,
  Cardapio,
  ExecutorConfig,
  SeenExecutor,
  UpdateMode,
} from "../types";

export const workspace = pgTable("workspace", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** UI language for this workspace. English default, pt-BR first translation. */
  language: text("language").notNull().default("en"),
  /**
   * What this instance may do about new releases: nothing, check and tell, or
   * update itself. OFF by default, because the zero phone-home promise means no
   * outbound request unless the owner asked for one.
   */
  updateMode: text("update_mode").$type<UpdateMode>().notNull().default("off"),
  /**
   * What the last automatic update did and when. Null until one runs: the panel
   * shows it so an update nobody watched still leaves a record.
   */
  updateLog: jsonb("update_log").$type<AutoUpdateRecord>(),
  /**
   * Opt-in money layer. OFF by default: tokens and time are facts on every
   * plan, while a dollar figure is fiction on a flat subscription and a price
   * table goes stale and lies with confidence. Turn it on and the board adds a
   * clearly labeled approximate cost next to the numbers it measured.
   */
  pricingEnabled: boolean("pricing_enabled").notNull().default(false),
  /**
   * How long a claim may go without task_update/task_heartbeat before another
   * executor may reclaim it. Kept per workspace so a long-running team can
   * widen the lease without weakening every installation.
   */
  claimTimeoutMinutes: integer("claim_timeout_minutes")
    .notNull()
    .default(60),
  executors: jsonb("executors")
    .$type<ExecutorConfig[]>()
    .notNull()
    .default(KNOWN_EXECUTORS),
  seenExecutors: jsonb("seen_executors")
    .$type<SeenExecutor[]>()
    .notNull()
    .default([]),
  cardapio: jsonb("cardapio")
    .$type<Cardapio>()
    .notNull()
    .default(DEFAULT_CARDAPIO),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
