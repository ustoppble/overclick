import { boardFilterToQuery, type BoardFilter } from "./board-filter";

/** The parameters the board's filter and search own in its address. */
export const BOARD_ADDRESS_PARAMS = [
  "organizations",
  "projects",
  "mission",
  "types",
  "priorities",
  "release",
  "period",
  "periodBy",
  "q",
] as const;

/**
 * The board's query for a filter and the search words (navigation plan E4):
 * the URL is the state of the board, so a link copied from the address bar
 * shows the same board to whoever opens it. What the board does not own
 * (a card being asked for, the review list) is kept as it was.
 */
export function boardAddressQuery(filter: BoardFilter, words: string, current: string): string {
  const params = new URLSearchParams(current);
  for (const key of BOARD_ADDRESS_PARAMS) params.delete(key);
  for (const [key, value] of new URLSearchParams(boardFilterToQuery(filter))) params.set(key, value);
  const q = words.trim();
  if (q) params.set("q", q);
  return params.toString();
}
