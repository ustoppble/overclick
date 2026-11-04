/**
 * The address people reach this board at, as the operator configured it
 * (`OVERCLICK_PUBLIC_URL`, e.g. https://board.example.com).
 *
 * It is the only origin a link inside an email may carry. The request's Host
 * and x-forwarded-* headers are written by whoever sent the request, so a link
 * built from them can be pointed at a site of the attacker's choosing.
 *
 * Returns null when the variable is empty or not a plain origin: https, or
 * http only for a local address. Any path, query or credentials are dropped.
 */
export function publicOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.OVERCLICK_PUBLIC_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  return url.origin;
}
