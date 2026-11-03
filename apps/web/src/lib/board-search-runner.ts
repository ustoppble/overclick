/**
 * The client side of the board search. The server may turn a search away
 * instead of answering it ("busy": its slots are taken, "rate": the minute is
 * spent). A refusal says nothing about the cards, so it must never reach the
 * screen as "found nothing": on "busy" the runner asks again for the latest
 * query once an earlier call ends or a short backoff passes; on "rate", or
 * after a few tries, it stops and lets the board show what it already has.
 */

export type BoardSearchReply<C> = {
  query: string;
  cards: C[];
  limited?: "busy" | "rate";
};

export type BoardSearchState = "searching" | "done" | "limited";

export type BoardSearchHandlers<C> = {
  onResult: (query: string, cards: C[]) => void;
  onState: (state: BoardSearchState) => void;
};

export const BOARD_SEARCH_BACKOFF_MS = 300;
export const BOARD_SEARCH_MAX_RETRIES = 3;

export function createBoardSearchRunner<C>(options: {
  search: (query: string) => Promise<BoardSearchReply<C>>;
  backoffMs?: number;
  maxRetries?: number;
}) {
  const backoffMs = options.backoffMs ?? BOARD_SEARCH_BACKOFF_MS;
  const maxRetries = options.maxRetries ?? BOARD_SEARCH_MAX_RETRIES;
  // Every call still open, cancelled searches included: the server counts
  // them against the person, so their end is what frees a slot.
  const open = new Set<Promise<unknown>>();

  function call(query: string): Promise<BoardSearchReply<C> | null> {
    const pending = options.search(query).then(
      (reply) => reply,
      () => null,
    );
    open.add(pending);
    void pending.finally(() => open.delete(pending));
    return pending;
  }

  function untilSlotOrBackoff(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, backoffMs);
      const settled = [...open];
      if (settled.length === 0) return;
      void Promise.race(settled).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    /** Starts a search; the returned function drops it (the query changed). */
    start(query: string, handlers: BoardSearchHandlers<C>): () => void {
      let cancelled = false;
      handlers.onState("searching");
      void (async () => {
        for (let attempt = 0; ; attempt += 1) {
          const reply = await call(query);
          if (cancelled) return;
          if (!reply) return handlers.onState("done");
          if (!reply.limited) {
            handlers.onResult(query, reply.cards);
            return handlers.onState("done");
          }
          if (reply.limited === "rate" || attempt >= maxRetries) {
            return handlers.onState("limited");
          }
          await untilSlotOrBackoff();
          if (cancelled) return;
        }
      })();
      return () => {
        cancelled = true;
      };
    },
  };
}
