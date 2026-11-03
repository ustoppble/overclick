import type { TaskPriority, TaskType } from "@agent-board/db";
import { z } from "zod";
import {
  isTaskPriority,
  isTaskType,
  NO_MISSION,
  type BoardFilter,
} from "./board-filter";
import { isArchivedStatus, type ArchivedStatus, type OlderCursor } from "./board-tasks";

/**
 * The shape the board's server actions accept. A server action is a public
 * endpoint: the types on the client say nothing about what arrives, and a
 * value that is not a uuid or not a known type would reach Postgres and come
 * back as a 500. Anything off the shape is refused here, and the action
 * answers empty, the same as for something the reader may not see.
 */

const uuid = z.string().uuid();
const uuids = z.array(uuid).max(200);

const boardFilterShape: z.ZodType<BoardFilter, z.ZodTypeDef, unknown> = z.object({
  organizationIds: uuids,
  projectIds: uuids,
  missionId: z.union([z.literal(NO_MISSION), uuid]).nullable(),
  resolvedIn: z.string().max(200).nullable().optional(),
  types: z
    .array(z.custom<TaskType>((value) => typeof value === "string" && isTaskType(value)))
    .max(20),
  priorities: z
    .array(
      z.custom<TaskPriority>((value) => typeof value === "string" && isTaskPriority(value)),
    )
    .max(20),
});

const olderCursorShape: z.ZodType<OlderCursor, z.ZodTypeDef, unknown> = z.object({
  // What Date#toISOString writes, which is how the cards carry updatedAt.
  updatedAt: z.string().datetime(),
  id: uuid,
});

/** The filter as the board holds it, or null when it is not one. */
export function parseBoardFilter(input: unknown): BoardFilter | null {
  const parsed = boardFilterShape.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** One "show older" request, or null when any part of it is off the shape. */
export function parseOlderRequest(input: unknown): {
  status: ArchivedStatus;
  filter: BoardFilter;
  before: OlderCursor | null;
} | null {
  const parsed = z
    .object({
      status: z.string().refine(isArchivedStatus),
      filter: boardFilterShape,
      before: olderCursorShape.nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return null;
  return {
    status: parsed.data.status as ArchivedStatus,
    filter: parsed.data.filter,
    before: parsed.data.before,
  };
}
