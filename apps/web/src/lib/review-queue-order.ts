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
