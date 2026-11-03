import { searchBoardCards, type SearchableBoardCard } from "./board-filter";
import type { ColumnStatus } from "./board-columns";

/**
 * The client half of the board's window. The page hands over the window
 * (live cards, plus the finished ones that changed this week); everything the
 * reader pulled in past it — a page of older cards, a search hit, a linked
 * card — is kept here, so the next refresh does not take it away again.
 */

/** One "show older" click. */
export const BOARD_PAGE_SIZE = 50;

type WindowCard = {
  id: string;
  status: ColumnStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * The window and the extras as one list, in the board's column order (oldest
 * first). A card in both is the window's copy: the window is the fresher read.
 */
export function mergeBoardCards<T extends WindowCard>(
  windowCards: readonly T[],
  extra: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const card of extra) byId.set(card.id, card);
  for (const card of windowCards) byId.set(card.id, card);
  return [...byId.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** Extras kept by id, so a second page or a repeated search adds nothing twice. */
export function addExtraCards<T extends WindowCard>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  if (incoming.length === 0) return current as T[];
  const byId = new Map<string, T>();
  for (const card of current) byId.set(card.id, card);
  for (const card of incoming) byId.set(card.id, card);
  return [...byId.values()];
}

/**
 * Where the next page of a column starts: its oldest change on the board.
 * Everything newer than it is already held — the window up to this week, the
 * pages before this one below it.
 */
export function olderCursor(
  cards: readonly WindowCard[],
  status: ColumnStatus,
): { updatedAt: string; id: string } | null {
  let oldest: WindowCard | null = null;
  for (const card of cards) {
    if (card.status !== status) continue;
    if (
      !oldest ||
      card.updatedAt < oldest.updatedAt ||
      (card.updatedAt === oldest.updatedAt && card.id < oldest.id)
    ) {
      oldest = card;
    }
  }
  return oldest ? { updatedAt: oldest.updatedAt, id: oldest.id } : null;
}

/**
 * The board search over what the board holds, widened by what the server
 * search found for the same words: its full-text match reads comments too,
 * which the cards on the client do not carry.
 */
export function searchWithServerHits<T extends SearchableBoardCard & { id: string }>(
  cards: T[],
  query: string,
  serverHits: ReadonlySet<string>,
): T[] {
  if (!query.trim()) return cards;
  const local = new Set(searchBoardCards(cards, query).map((card) => card.id));
  return cards.filter((card) => local.has(card.id) || serverHits.has(card.id));
}

/** A column's number: the server's count, never less than what is on screen. */
export function columnTotal(
  loaded: number,
  serverCount: number | undefined,
): number {
  return serverCount === undefined ? loaded : Math.max(loaded, serverCount);
}
