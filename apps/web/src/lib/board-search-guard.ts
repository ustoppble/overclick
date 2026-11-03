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
export const BOARD_SEARCH_MAX_IN_FLIGHT = 2;

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

/** Why `acquire` said no: another search holds the slots, or the minute is spent. */
export type BoardSearchRefusal = "busy" | "rate";

export type BoardSearchSlot =
  | { ok: true; release: () => void }
  | { ok: false; reason: BoardSearchRefusal };

/**
 * Two searches in flight per person (a second tab) and at most 30 a minute,
 * kept in this process. A refusal says why, so the caller can tell "try again
 * in a moment" from "enough for this minute"; call `release` when a granted
 * search is over. A refused call costs nothing against the minute. The limits
 * are per process: a restart or a second instance starts from zero, which is
 * fine for a guard against a runaway client.
 */
export function createBoardSearchLimiter(
  perMinute: number = BOARD_SEARCH_MAX_PER_MINUTE,
  maxInFlight: number = BOARD_SEARCH_MAX_IN_FLIGHT,
) {
  const inFlight = new Map<string, number>();
  const recent = new Map<string, number[]>();
  let prunedAt = 0;

  // Someone who stopped searching leaves their timestamps behind; sweep them
  // once a minute so the map follows who is active, not who ever was.
  function prune(now: number) {
    if (now - prunedAt < MINUTE_MS) return;
    prunedAt = now;
    for (const [userId, times] of recent) {
      const kept = times.filter((at) => now - at < MINUTE_MS);
      if (kept.length === 0) recent.delete(userId);
      else recent.set(userId, kept);
    }
  }

  return {
    acquire(userId: string, now: number = Date.now()): BoardSearchSlot {
      prune(now);
      if ((inFlight.get(userId) ?? 0) >= maxInFlight) {
        return { ok: false, reason: "busy" };
      }
      const kept = (recent.get(userId) ?? []).filter((at) => now - at < MINUTE_MS);
      if (kept.length >= perMinute) {
        recent.set(userId, kept);
        return { ok: false, reason: "rate" };
      }
      kept.push(now);
      recent.set(userId, kept);
      inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1);
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          const left = (inFlight.get(userId) ?? 1) - 1;
          if (left <= 0) inFlight.delete(userId);
          else inFlight.set(userId, left);
        },
      };
    },
    size() {
      return recent.size;
    },
    reset() {
      inFlight.clear();
      recent.clear();
      prunedAt = 0;
    },
  };
}

export const boardSearchLimiter = createBoardSearchLimiter();
