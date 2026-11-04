import {
  searchBoardCards,
  type BoardPeriodField,
  type SearchableBoardCard,
} from "./board-filter";
import { COLUMN_STATUSES, type ColumnStatus } from "./board-columns";

/**
 * The client half of the board's window. The page hands over the window (the
 * cards inside the period); what the search pulled in past it is kept here,
 * so the next refresh does not take it away while the words are still typed.
 */

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

/**
 * The columns' own order (OCL board lazy): newest first by the date the
 * period reads, the id breaking ties, as the server hands the pages over. The
 * search's answer is laid out the same way, so a card does not jump when the
 * words are cleared.
 */
export function newestFirst<T extends WindowCard>(
  cards: readonly T[],
  periodBy: BoardPeriodField,
): T[] {
  const at = (card: T) => (periodBy === "created" ? card.createdAt : card.updatedAt);
  return [...cards].sort(
    (a, b) => at(b).localeCompare(at(a)) || b.id.localeCompare(a.id),
  );
}

/** Extras kept by id, so a repeated search adds nothing twice. */
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
 * The cards inside the period, by the date it reads: what every column shows
 * while no search is on. `since` is where the page's window starts, null for
 * all time. A search hit or a linked card held from outside the window stays
 * held, and shows again when the search asks for it.
 */
export function cardsInPeriod<T extends WindowCard>(
  cards: readonly T[],
  since: string | null,
  periodBy: BoardPeriodField,
): T[] {
  if (since === null) return [...cards];
  return cards.filter(
    (card) => (periodBy === "created" ? card.createdAt : card.updatedAt) >= since,
  );
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
 * search found for the same words: its full-text match reads the contract
 * and the comments too, which the cards on the client do not carry.
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

/** The columns as the browser holds them: what board-page hands over, by any card shape. */
export type HeldColumns<T extends { id: string }> = {
  key: string;
  columns: Record<ColumnStatus, { cards: T[]; next: string | null }>;
};

/**
 * A column's next page, added to the columns it was asked from (OCL board
 * lazy). Dropped when the columns moved on in the meantime (another filter,
 * or a refresh that already went past that cursor); a card already held
 * somewhere (it changed columns since) is not drawn twice.
 */
export function appendColumnPage<T extends { id: string }, C extends HeldColumns<T>>(
  held: C,
  status: ColumnStatus,
  cursor: string,
  page: { key: string; cards: T[]; next: string | null },
): C {
  if (held.key !== page.key || held.columns[status].next !== cursor) return held;
  const ids = new Set(COLUMN_STATUSES.flatMap((each) => held.columns[each].cards.map((card) => card.id)));
  return {
    ...held,
    columns: {
      ...held.columns,
      [status]: {
        cards: [...held.columns[status].cards, ...page.cards.filter((card) => !ids.has(card.id))],
        next: page.next,
      },
    },
  };
}

/**
 * What a refresh does with the first pages it brings: take them, when they
 * answer the filter on screen and no column was scrolled past its first page;
 * otherwise re-read the columns as deep as they are held, so the poll never
 * takes away what the reader scrolled in, nor the place they scrolled to.
 */
export function columnsAfterRefresh<T extends { id: string }>(
  held: HeldColumns<T>,
  incoming: HeldColumns<T>,
  pageSize: number,
): { adopt: true } | { adopt: false; depth: Record<ColumnStatus, number> } {
  const scrolled = COLUMN_STATUSES.some((status) => held.columns[status].cards.length > pageSize);
  if (incoming.key === held.key && !scrolled) return { adopt: true };
  return {
    adopt: false,
    depth: Object.fromEntries(
      COLUMN_STATUSES.map((status) => [status, held.columns[status].cards.length]),
    ) as Record<ColumnStatus, number>,
  };
}
