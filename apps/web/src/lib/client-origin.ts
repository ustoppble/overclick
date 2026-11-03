import { isIP } from "node:net";

/**
 * The caller's origin, as far as this deployment can honestly tell. Shared by
 * the sign-in budgets (`loginOrigin`) and the pairing endpoint.
 *
 * A forwarded-for header is written by whatever sits in front, and on a
 * directly exposed instance that is the caller itself: trusting it there
 * would hand a guesser a fresh budget per request just by varying a string.
 * So nothing is read unless the deploy declares a trusted proxy
 * (`OVERCLICK_TRUSTED_PROXY=1`), and then:
 *
 * - `OVERCLICK_CLIENT_IP_HEADER` set (e.g. `cf-connecting-ip`): that header,
 *   which an edge like Cloudflare writes with the visitor's own address.
 *   Behind such an edge the last forwarded-for hop is the edge itself, shared
 *   by everyone. The header is only as honest as the edge: it is trustworthy
 *   only if the server takes traffic from nowhere else (deploy/README.md).
 *   Its value must be one single IPv4 or IPv6 address (`net.isIP`, no `%zone`): anything
 *   else — garbage, a list, an empty value — is what a caller makes up when the
 *   server can be reached without the edge, and each distinct string would be a
 *   fresh budget. A request that does not carry a valid one gets the rule below.
 * - otherwise the last hop of `x-forwarded-for` — the entry our own proxy
 *   appended, which the caller cannot write past — or `x-real-ip` when there
 *   is no forwarded-for at all.
 */
export function clientOrigin(headers: Headers): string | null {
  if (process.env.OVERCLICK_TRUSTED_PROXY !== "1") return null;
  const named = process.env.OVERCLICK_CLIENT_IP_HEADER?.trim();
  if (named) {
    const value = headers.get(named)?.trim();
    if (value && !value.includes("%") && isIP(value) !== 0) return value;
  }
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return headers.get("x-real-ip");
  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.at(-1) ?? null;
}
