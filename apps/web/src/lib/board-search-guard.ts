/**
 * What the server accepts of a board search. The action is callable by any
 * signed-in session, the UI's debounce included or not, and each search runs
 * task_search: an OR of ILIKEs per term over titles, bodies and a comment
 * aggregate per row, about a second apiece. Without a cap on the words and on
 * how often one person may ask, a script could keep the pool busy for everyone.
 */

export const BOARD_SEARCH_MIN_CHARS = 2;
export const BOARD_SEARCH_MAX_CHARS = 100;
export const BOARD_SEARCH_MAX_TERMS = 6;
export const BOARD_SEARCH_MAX_PER_MINUTE = 30;

const MINUTE_MS = 60_000;

/** The query the server will run, or null when there is nothing worth asking. */
export function normalizeBoardSearch(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const terms = raw
    .trim()
    .slice(0, BOARD_SEARCH_MAX_CHARS)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, BOARD_SEARCH_MAX_TERMS);
  const query = terms.join(" ");
  return query.length >= BOARD_SEARCH_MIN_CHARS ? query : null;
}

/**
 * One search in flight per person and at most 30 a minute, kept in this
 * process. Null from `acquire` means refuse; otherwise call the returned
 * function when the search is over. A refused call costs nothing against the
 * minute. The limits are per process: a restart or a second instance starts
 * from zero, which is fine for a guard against a runaway client.
 */
export function createBoardSearchLimiter(
  perMinute: number = BOARD_SEARCH_MAX_PER_MINUTE,
) {
  const inFlight = new Set<string>();
  const recent = new Map<string, number[]>();

  return {
    acquire(userId: string, now: number = Date.now()): (() => void) | null {
      if (inFlight.has(userId)) return null;
      const kept = (recent.get(userId) ?? []).filter((at) => now - at < MINUTE_MS);
      if (kept.length >= perMinute) {
        recent.set(userId, kept);
        return null;
      }
      kept.push(now);
      recent.set(userId, kept);
      inFlight.add(userId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight.delete(userId);
      };
    },
    reset() {
      inFlight.clear();
      recent.clear();
    },
  };
}

export const boardSearchLimiter = createBoardSearchLimiter();
