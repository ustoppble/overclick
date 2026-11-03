/**
 * How often the board looks for writes made outside the browser. A refresh
 * rebuilds the whole page on the server, and on a small machine one takes
 * seconds; at 5 s they started faster than they finished and piled up.
 */
export const BOARD_REFRESH_INTERVAL_MS = 20_000;

type RefreshDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

type RefreshClock = {
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
};

export type BoardRefreshSource = {
  /** Ask the server for a fresh page. */
  refresh: () => void;
  /** A refresh asked earlier has not come back yet. */
  isBusy?: () => boolean;
};

/**
 * Keep the server-rendered board in step with writes made outside the browser.
 * Hidden tabs do no work; returning to one refreshes immediately before the
 * regular cadence resumes. A tick that finds the previous refresh still in
 * flight does nothing: the next one will look again.
 */
export function subscribeToBoardRefresh(
  source: BoardRefreshSource,
  doc: RefreshDocument = document,
  clock: RefreshClock = window,
): () => void {
  let interval: number | null = null;

  const refresh = () => {
    if (source.isBusy?.()) return;
    source.refresh();
  };

  const stop = () => {
    if (interval === null) return;
    clock.clearInterval(interval);
    interval = null;
  };

  const start = () => {
    if (interval !== null || doc.visibilityState !== "visible") return;
    interval = clock.setInterval(refresh, BOARD_REFRESH_INTERVAL_MS);
  };

  const onVisibilityChange = () => {
    if (doc.visibilityState === "visible") {
      refresh();
      start();
    } else {
      stop();
    }
  };

  start();
  doc.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    stop();
  };
}
