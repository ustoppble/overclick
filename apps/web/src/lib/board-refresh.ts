/**
 * How often the board looks for writes made outside the browser. A refresh
 * rebuilds the whole page on the server, and on a small machine one takes
 * seconds; at 5 s they started faster than they finished and piled up.
 */
export const BOARD_REFRESH_INTERVAL_MS = 20_000;

/**
 * With a signature to compare, an unchanged board is left alone, but not
 * forever: the page also shows things that move with the clock (how long a
 * claim has been quiet) and things no signature reads, so it is rebuilt at
 * least this often.
 */
export const BOARD_REFRESH_MAX_AGE_MS = 300_000;

type RefreshDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

type RefreshClock = {
  setInterval(callback: () => unknown, delay: number): number;
  clearInterval(id: number): void;
};

export type BoardRefreshSource = {
  /** Ask the server for a fresh page. */
  refresh: () => void;
  /** A refresh asked earlier has not come back yet. */
  isBusy?: () => boolean;
  /**
   * The cheap question: a fingerprint of what the page is made of, or null
   * when the server would not say. Without it every tick refreshes.
   */
  signature?: () => Promise<string | null>;
  /** The fingerprint the page on screen was built with. */
  held?: () => string | null;
  now?: () => number;
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

  const now = source.now ?? Date.now;
  let lastRefreshAt = now();
  let checking = false;

  const refresh = () => {
    if (source.isBusy?.()) return;
    lastRefreshAt = now();
    source.refresh();
  };

  // The signature costs a few small queries; the page costs the whole board.
  // The page is only asked for when the signature moved (or cannot be read).
  const poll = async (): Promise<void> => {
    if (!source.signature) {
      refresh();
      return;
    }
    if (checking || source.isBusy?.()) return;
    checking = true;
    let current: string | null = null;
    try {
      current = await source.signature();
    } catch {
      current = null;
    } finally {
      checking = false;
    }
    const stale = now() - lastRefreshAt >= BOARD_REFRESH_MAX_AGE_MS;
    if (current === null || current !== (source.held?.() ?? null) || stale) {
      refresh();
    }
  };

  const stop = () => {
    if (interval === null) return;
    clock.clearInterval(interval);
    interval = null;
  };

  const start = () => {
    if (interval !== null || doc.visibilityState !== "visible") return;
    interval = clock.setInterval(poll, BOARD_REFRESH_INTERVAL_MS);
  };

  const onVisibilityChange = () => {
    if (doc.visibilityState === "visible") {
      void poll();
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
