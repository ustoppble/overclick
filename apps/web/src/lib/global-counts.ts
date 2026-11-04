import type { Database } from "@agent-board/db";
import { countCardsByStatus, readReviewScope } from "./review-queue";
import type { MaybePrincipal } from "./scope";

/** The two numbers the global bar carries: what runs and what waits for review. */
export type GlobalCounts = { running: number; review: number };

/**
 * Read for the reader's remembered scope, by role, ignoring the board's
 * period and filters (the F1 contract, `review-queue.ts`). One place, so the
 * page, the board's 20 s poll and the 60 s poll elsewhere cannot disagree.
 */
export async function loadGlobalCounts(
  database: Database,
  workspaceId: string,
  principal: MaybePrincipal,
): Promise<GlobalCounts> {
  const scope = await readReviewScope(database, workspaceId, principal);
  const counts = await countCardsByStatus(database, principal, scope);
  return { running: counts.em_execucao, review: counts.feito };
}
