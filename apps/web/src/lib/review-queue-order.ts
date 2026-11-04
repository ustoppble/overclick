/**
 * The order of the To review list, without the database: the client moves
 * along the list with it, and `review-queue.ts` re-exports it next to the
 * query that builds the list.
 */

/**
 * The card to open after `currentId` leaves the list: the one after it, or
 * the first one still waiting when it was the last. Null when nothing else
 * waits.
 */
export function nextInQueue(ids: string[], currentId: string): string | null {
  const rest = ids.filter((id) => id !== currentId);
  if (rest.length === 0) return null;
  const at = ids.indexOf(currentId);
  if (at < 0) return rest[0]!;
  return ids[at + 1] ?? rest[0]!;
}

/**
 * The To review list's lines, in the queue's order, and its number. The
 * number is the queue's length, the count the chip carries, and not however
 * many lines happened to load (E1 review, B2): a card the line query could not
 * read is named in `missing` instead of quietly lowering the count.
 */
export function joinReviewQueue<
  Entry extends { id: string },
  Card extends { id: string },
>(
  queue: readonly Entry[],
  cards: readonly Card[],
): { rows: (Omit<Entry, "id"> & { card: Card })[]; count: number; missing: string[] } {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const rows: (Omit<Entry, "id"> & { card: Card })[] = [];
  const missing: string[] = [];
  for (const { id, ...rest } of queue) {
    const card = byId.get(id);
    if (card) rows.push({ ...rest, card });
    else missing.push(id);
  }
  return { rows, count: queue.length, missing };
}
