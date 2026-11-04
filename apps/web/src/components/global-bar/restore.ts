/**
 * Calls back when the browser brings the page back from its back/forward
 * cache (E4 review h-ipv, item 4). A page left with `location.assign` comes
 * back exactly as it was frozen — a control disabled "while the page goes"
 * would stay disabled for good. Returns the unsubscribe.
 */
export function onRestoredFromCache(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  callback: () => void,
): () => void {
  const listener = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) callback();
  };
  target.addEventListener("pageshow", listener);
  return () => target.removeEventListener("pageshow", listener);
}
