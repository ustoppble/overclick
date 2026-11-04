/** A card's own address (navigation plan E3, F4): the short id, flat. */
export function cardPath(shortId: string): string {
  return `/cards/${encodeURIComponent(shortId)}`;
}

const CARD_PATH = /^\/cards\/([^/]+)$/;

/** The short id a card's address carries, or null for any other path. */
export function cardIdFromPath(pathname: string): string | null {
  const match = CARD_PATH.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}
