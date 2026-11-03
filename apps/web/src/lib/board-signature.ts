import {
  executionAttempt,
  handoff,
  mission,
  task,
  taskComment,
  type Database,
} from "@agent-board/db";
import { and, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import { missionScope, taskScope, type MaybePrincipal } from "./scope";

/**
 * A short fingerprint of everything the board page is made of, for the reader
 * it is made for: how many cards, comments, handoffs, attempts and missions
 * the reader sees, and the newest change in each. The page asks for it every
 * few seconds instead of rebuilding itself (an 11 MB read and render on the
 * server) and only reloads when it differs from the one the page was built
 * with.
 *
 * It is the reader's whole scope, not the board filter: the cards the page
 * hands over, the mission counts and the filter menus do not depend on the
 * filter, so a signature that did could miss a change the page would show as
 * soon as the filter moves.
 *
 * Comments, handoffs and attempts are read on their own because writing one
 * does not touch the card's updated_at. Counts catch a deletion, which no
 * maximum can.
 */
export async function loadBoardSignature(
  database: Database,
  workspaceId: string,
  projectIds: string[],
  principal: MaybePrincipal,
): Promise<string> {
  const inScope =
    projectIds.length === 0
      ? sql`false`
      : and(inArray(task.projectId, projectIds), taskScope(principal));
  // Newest change as epoch milliseconds, made into text by the database: the
  // two drivers hand a timestamp over differently, a number string is the same.
  const newest = (value: SQL) =>
    sql<string | null>`(extract(epoch from ${value}) * 1000)::bigint::text`;

  const [cards, comments, handoffs, attempts, missions] = await Promise.all([
    database
      .select({ n: count(), at: newest(sql`max(${task.updatedAt})`) })
      .from(task)
      .where(inScope),
    database
      .select({ n: count(), at: newest(sql`max(${taskComment.createdAt})`) })
      .from(taskComment)
      .innerJoin(task, eq(taskComment.taskId, task.id))
      .where(inScope),
    database
      .select({ n: count(), at: newest(sql`max(${handoff.createdAt})`) })
      .from(handoff)
      .innerJoin(task, eq(handoff.taskId, task.id))
      .where(inScope),
    database
      .select({
        n: count(),
        at: newest(
          sql`max(greatest(${executionAttempt.lastActivityAt}, coalesce(${executionAttempt.finishedAt}, ${executionAttempt.lastActivityAt})))`,
        ),
      })
      .from(executionAttempt)
      .innerJoin(task, eq(executionAttempt.taskId, task.id))
      .where(inScope),
    database
      .select({ n: count(), at: newest(sql`max(${mission.updatedAt})`) })
      .from(mission)
      .where(and(eq(mission.workspaceId, workspaceId), missionScope(principal))),
  ]);

  return [cards, comments, handoffs, attempts, missions]
    .map((rows) => `${Number(rows[0]?.n ?? 0).toString(36)}.${rows[0]?.at ?? "-"}`)
    .join("/");
}
