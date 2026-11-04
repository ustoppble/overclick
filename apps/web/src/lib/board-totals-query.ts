import type { ModelPrice } from "@agent-board/db";
import { filterBoardCards, type BoardFilter } from "./board-filter";
import { toBoardTotals, type BoardTotals } from "./board-totals";
import {
  computeInsights,
  filterMissionAttempts,
  loadInsightAttemptRows,
  loadMissionAttemptRows,
  type InsightsDb,
} from "./insights";
import type { MaybePrincipal } from "./scope";
import { attemptsInPeriod, missionAttemptsInPeriod } from "./usage-period";

/**
 * The totals for one board filter. It reads the same attempt rows the Consumo
 * page reads, narrows them with the same filter and period the board applies
 * to its cards, and runs the same aggregation, so the topbar total and Consumo
 * cannot report different numbers for the same selection.
 */
export async function loadBoardTotals(
  db: InsightsDb,
  workspaceId: string,
  pricingEnabled: boolean,
  prices: readonly ModelPrice[],
  filter: BoardFilter,
  /** Whose cards count; null (nobody identifiable) counts nothing. */
  principal: MaybePrincipal,
  /** Where the period is counted back from. */
  now: Date = new Date(),
): Promise<BoardTotals> {
  const [rows, missionAttemptRows] = await Promise.all([
    loadInsightAttemptRows(db, workspaceId, principal),
    loadMissionAttemptRows(db, workspaceId, principal),
  ]);
  const narrowed = narrowUsageRows(rows, missionAttemptRows, filter, now);
  const insights = computeInsights(narrowed.attempts, [], prices, narrowed.missionAttempts);
  return toBoardTotals(insights.totals, pricingEnabled);
}

/**
 * The one narrowing the board's total and the Consumo page both run (E4):
 * the board's filter, scope included, and its period. Attempt rows carry the
 * project, mission and dates of their card, which is what the board filters
 * on, so the board's own filter narrows them unchanged.
 */
export function narrowUsageRows<
  A extends Parameters<typeof filterBoardCards>[0][number] & Parameters<typeof attemptsInPeriod>[0][number],
  M extends Parameters<typeof filterMissionAttempts>[0][number] &
    Parameters<typeof missionAttemptsInPeriod>[0][number],
>(
  attempts: A[],
  missionAttempts: M[],
  filter: BoardFilter,
  now: Date = new Date(),
): { attempts: A[]; missionAttempts: M[] } {
  return {
    attempts: attemptsInPeriod(filterBoardCards(attempts, filter), filter, now),
    missionAttempts: missionAttemptsInPeriod(filterMissionAttempts(missionAttempts, filter), filter, now),
  };
}
