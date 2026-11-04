/**
 * How often one person may ask the board for its signature. The action is
 * callable by any signed-in session, and each call is a session read, the
 * reader's scope and five aggregate queries over cards, comments, handoffs,
 * attempts and missions: half the connection pool at once. The page asks
 * three times a minute; a script that asks in a loop would keep the pool busy
 * for everyone.
 */

export const BOARD_SIGNATURE_MAX_PER_MINUTE = 12;
export const BOARD_SIGNATURE_MAX_IN_FLIGHT = 1;

const MINUTE_MS = 60_000;

/** Why `acquire` said no: another poll holds the slot, or the minute is spent. */
export type BoardSignatureRefusal = "busy" | "rate";

export type BoardSignatureSlot =
  | { ok: true; release: () => void }
  | { ok: false; reason: BoardSignatureRefusal };

/**
 * One poll in flight per person and at most 12 a minute, kept in this
 * process. A refused call costs nothing against the minute. The limits are
 * per process: a restart or a second instance starts from zero, which is fine
 * for a guard against a runaway client. Call `release` when a granted poll is
 * over.
 */
export function createBoardSignatureLimiter(
  perMinute: number = BOARD_SIGNATURE_MAX_PER_MINUTE,
  maxInFlight: number = BOARD_SIGNATURE_MAX_IN_FLIGHT,
) {
  const inFlight = new Map<string, number>();
  const recent = new Map<string, number[]>();
  let prunedAt = 0;

  // Someone who closed the board leaves their timestamps behind; sweep them
  // once a minute so the map follows who is polling, not who ever did.
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
    acquire(userId: string, now: number = Date.now()): BoardSignatureSlot {
      prune(now);
      if ((inFlight.get(userId) ?? 0) >= maxInFlight) {
        return { ok: false, reason: "busy" };
      }
      const kept = (recent.get(userId) ?? []).filter((at) => now - at < MINUTE_MS);
      if (kept.length >= perMinute) {
        if (kept.length === 0) recent.delete(userId);
        else recent.set(userId, kept);
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

export const boardSignatureLimiter = createBoardSignatureLimiter();

/**
 * The global bar's own 60 s poll (`globalBarCountsAction`), away from the
 * board: callable by any signed-in session like the signature, so it gets the
 * same allowance, counted apart (E1 review, M2).
 */
export const globalBarCountsLimiter = createBoardSignatureLimiter();
