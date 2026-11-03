import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";

/** Local auth only. Email is an identifier, not a channel. */
export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  /**
   * `admin` sees and changes everything; `member` only what they authored,
   * inside `organizationId`. The column default is the restrictive one: a
   * user row nobody labelled is a member, never an admin.
   */
  role: text("role").$type<"admin" | "member">().notNull().default("member"),
  /** The one organization a member belongs to. Null for admins. */
  organizationId: uuid("organization_id").references(() => organization.id, {
    onDelete: "set null",
  }),
  active: boolean("active").notNull().default(true),
  sessionVersion: integer("session_version").notNull().default(1),
  /**
   * When this admin last dismissed the "a member finished installing" notice
   * on the home (OCL-222). Installs after it are the ones still announced.
   */
  teamNoticeSeenAt: timestamp("team_notice_seen_at", { withTimezone: true }),
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
  /** How far back the board reaches by last activity: "7d", "14d", "30d" or "all". Null = the default, 7 days. */
  boardPeriod: text("board_period"),
  /** Which date the period reads: "updated" (last activity) or "created". Null = the default, "updated". */
  boardPeriodBy: text("board_period_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
