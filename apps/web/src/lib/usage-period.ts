import {
  DEFAULT_BOARD_PERIOD,
  DEFAULT_BOARD_PERIOD_FIELD,
  periodDays,
  type BoardPeriod,
  type BoardPeriodField,
} from "./board-filter";

/**
 * The board's period, applied to what was consumed (navigation plan E4, D6).
 * A card's attempts count when the card is inside the period by the date it
 * reads, the same rule the board's window keeps its cards by
 * (`board-window.ts`, `cardsInPeriod`): the cost on top of the board and the
 * Consumo page its link opens count the same cards.
 */
type Period = { period?: BoardPeriod; periodBy?: BoardPeriodField };

function since(filter: Period, now: Date): number | null {
  const days = periodDays(filter.period ?? DEFAULT_BOARD_PERIOD);
  return days === null ? null : now.getTime() - days * 86_400_000;
}

export function attemptsInPeriod<
  T extends { taskUpdatedAt: Date | string; taskCreatedAt: Date | string },
>(rows: readonly T[], filter: Period, now: Date = new Date()): T[] {
  const start = since(filter, now);
  if (start === null) return [...rows];
  const created = (filter.periodBy ?? DEFAULT_BOARD_PERIOD_FIELD) === "created";
  return rows.filter(
    (row) => new Date(created ? row.taskCreatedAt : row.taskUpdatedAt).getTime() >= start,
  );
}

/**
 * A mission attempt has no card, so it goes by its own dates: the start for
 * the creation date, and for the last activity its finish, or its start while
 * it still runs.
 */
export function missionAttemptsInPeriod<
  T extends { startedAt: Date | string; finishedAt: Date | string | null },
>(rows: readonly T[], filter: Period, now: Date = new Date()): T[] {
  const start = since(filter, now);
  if (start === null) return [...rows];
  const created = (filter.periodBy ?? DEFAULT_BOARD_PERIOD_FIELD) === "created";
  return rows.filter(
    (row) =>
      new Date(created ? row.startedAt : (row.finishedAt ?? row.startedAt)).getTime() >= start,
  );
}
