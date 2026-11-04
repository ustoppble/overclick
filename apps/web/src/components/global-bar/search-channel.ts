/**
 * The board's search words, shared by the field in the global bar and the
 * board under it (navigation plan E4). The bar lives in the route's layout and
 * the board in the page, so the words live here: the bar writes them as they
 * are typed, the board filters by them, and the board's own Clear empties the
 * field above it. Off the board nothing listens: the field submits to
 * `/board?q=` instead.
 */
type Listener = (query: string) => void;

let current = "";
const listeners = new Set<Listener>();

export function getBoardSearch(): string {
  return current;
}

export function setBoardSearch(query: string): void {
  if (query === current) return;
  current = query;
  for (const listener of listeners) listener(query);
}

export function subscribeBoardSearch(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
