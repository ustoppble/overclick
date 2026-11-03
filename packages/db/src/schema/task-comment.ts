import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { task } from "./task";
import { user } from "./user";

export const taskComment = pgTable(
  "task_comment",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => task.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  authorAgentRef: text("author_agent_ref"),
  // Timeline entry type: "comment" is prose; "executor_swap" and
  // "spawn_failure" are typed events the board renders with their own label.
  kind: text("kind").notNull().default("comment"),
  /** Distinguishes a rejection report from ordinary review/progress reports. */
  reopens: boolean("reopens").notNull().default(false),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  },
  // The board reads every card's comments; without this each card is a scan.
  (table) => [index("task_comment_task_idx").on(table.taskId)],
);
