import type { GlobalCounts } from "../../lib/global-counts";

/**
 * How the board hands the global bar its numbers. The bar lives in the
 * route's layout and the board's 20 s poll lives in the page; the poll
 * already asks the server whether anything moved, and the answer carries the
 * two counts, so the bar listens here instead of polling a second time.
 */
type Listener = (counts: GlobalCounts) => void;

const listeners = new Set<Listener>();

export function publishGlobalCounts(counts: GlobalCounts): void {
  for (const listener of listeners) listener(counts);
}

export function subscribeGlobalCounts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
