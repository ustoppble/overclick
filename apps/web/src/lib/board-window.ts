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

/** Where an older page starts: right below this card's change. */
export type OlderCursor = { updatedAt: string; id: string };

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
 * Where the first "show older" page of a column starts: the oldest change among
 * the cards the window itself handed over. A card the page added for a link
 * (?card=) rides with the window but is older than it, and a search hit lives
 * in the extras; neither says what the window holds, so neither counts.
 */
export function windowCursor(
  windowCards: readonly WindowCard[],
  status: ColumnStatus,
  since: string,
): OlderCursor | null {
  return oldestChange(
    windowCards.filter((card) => card.status === status && card.updatedAt >= since),
  );
}

/**
 * Where the next page starts once the server answered one: the oldest change
 * of the page it returned. This is the only thing that moves the cursor past
 * the window.
 */
export function pageCursor(page: readonly WindowCard[]): OlderCursor | null {
  return oldestChange(page);
}

function oldestChange(cards: readonly WindowCard[]): OlderCursor | null {
  let oldest: WindowCard | null = null;
  for (const card of cards) {
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
 * The card a link (?card=OCL-12) points at among the cards held. A short id
 * can be recycled: the card that owns it now wins over one that only had it
 * once (previousShortIds), which is how an old link still finds a card that
 * moved projects.
 */
export function findLinkedCard<
  T extends { shortId: string; previousShortIds: readonly string[] },
>(cards: readonly T[], linked: string): T | null {
  const wanted = linked.trim().toUpperCase();
  if (!wanted) return null;
  return (
    cards.find((card) => card.shortId.toUpperCase() === wanted) ??
    cards.find((card) => card.previousShortIds.includes(wanted)) ??
    null
  );
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
