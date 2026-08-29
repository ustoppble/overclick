import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Local auth only. Email is an identifier, not a channel. */
export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  active: boolean("active").notNull().default(true),
  sessionVersion: integer("session_version").notNull().default(1),
  /**
   * `all` or organization uuids joined. Null = every organization, which is
   * what an instance that never split into more than one business sees.
   */
  boardOrganizationId: text("board_organization_id"),
  /** `all` or a project uuid. Null = first project (single-project default). */
  boardProjectId: text("board_project_id"),
  /**
   * `none` or a mission uuid. Null = every mission. `none` is what makes the
   * cards nobody put in a mission a place you can actually go to.
   */
  boardMissionId: text("board_mission_id"),
  /** Comma-separated task types. Null means every type. */
  boardTaskTypes: text("board_task_types"),
  /** Comma-separated task priorities. Null means every priority. */
  boardPriorities: text("board_priorities"),
  /** Exact release tag, or the board filter's no-release sentinel. Null = all. */
  boardResolvedIn: text("board_resolved_in"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
