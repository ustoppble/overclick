/**
 * The four columns of the board, and the counting a layout needs to name one
 * of them. The desktop board renders all four side by side, so it only ever
 * needs the order. The phone shows one column at a time, so it also needs to
 * know how many cards each one holds and which one is worth opening on.
 */

export const COLUMN_STATUSES = [
  "aberto",
  "em_execucao",
  "feito",
  "validado",
  "descartado",
] as const;

export type ColumnStatus = (typeof COLUMN_STATUSES)[number];

export type ColumnCounts = Record<ColumnStatus, number>;

/** Counts per column over the cards already through the board filters. */
export function countByStatus(cards: { status: ColumnStatus }[]): ColumnCounts {
  const counts: ColumnCounts = {
    aberto: 0,
    em_execucao: 0,
    feito: 0,
    validado: 0,
    descartado: 0,
  };
  for (const card of cards) counts[card.status] += 1;
  return counts;
}

/**
 * Which column the phone opens on: the first one holding cards, in board
 * order. Opening on an empty Open column while every card sits in Validated
 * would read as an empty board, which is the one thing this list must never
 * do. With nothing anywhere the answer is Open, where a new card lands.
 */
export function firstStatusWithCards(counts: ColumnCounts): ColumnStatus {
  return COLUMN_STATUSES.find((status) => counts[status] > 0) ?? "aberto";
}
