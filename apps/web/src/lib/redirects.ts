/**
 * Where the links that already left the app land now (navigation plan E3 and
 * E5). One hop each: the old page answers with a redirect, and nothing
 * chains. The pages that ask for these are `/home` (E3), `/insights`,
 * `/organizations` and `/settings?tab=…` (E5). The redirects are temporary
 * (307) in the release that introduces them and become permanent (308) in
 * the next one: a 308 is kept by the browser, and a rollback would leave it
 * pointing at a route that is gone.
 */

export type RedirectRole = "admin" | "member";
type Query = Record<string, string | string[] | undefined>;

/** The member's one place: their own agent and connections. */
export const MEMBER_DESTINATION = "/account/agent";

/** `/organizations` was a read-only half-screen; the editing lives here. */
export const ORGANIZATIONS_DESTINATION = "/settings/organizations-projects";

/** Where the admin lands on `/settings` with no tab, or one nobody knows. */
const ADMIN_DEFAULT = "/settings/organizations-projects";

const TAB_DESTINATIONS: Record<string, string> = {
  // The Executors tab left in E2; its old link opens the Agents group.
  exec: "/settings/agents",
  tokens: "/settings/agents#connections",
  recipes: "/settings/agents#usage-recipes",
  claims: "/settings/agents#claim-timeout",
  organizations: "/settings/organizations-projects",
  projects: "/settings/organizations-projects",
  team: "/settings/team",
  prices: "/settings/prices",
  language: "/settings/system",
  updates: "/settings/system",
};

/** The query as a string, repeated parameters kept and empty ones dropped. */
function queryString(query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one !== undefined && one !== "") params.append(key, one);
    }
  }
  return params.toString();
}

/**
 * `/settings?tab=X`, as the reader of that tab is sent. A member has no
 * Settings: whatever the tab, they go to their own agent. A tab that is not
 * known is the same as none.
 */
export function settingsTabDestination(
  tab: string | string[] | undefined,
  role: RedirectRole,
): string {
  if (role !== "admin") return MEMBER_DESTINATION;
  const asked = Array.isArray(tab) ? tab[0] : tab;
  return (asked && TAB_DESTINATIONS[asked]) || ADMIN_DEFAULT;
}

/** `/insights?…` becomes `/usage?…` with the filter the link carried. */
export function insightsDestination(query: Query): string {
  const qs = queryString(query);
  return qs ? `/usage?${qs}` : "/usage";
}

/** The old addresses that only redirect; nothing may send a reader to them. */
export const REDIRECT_SOURCES = ["/home", "/insights", "/organizations"] as const;

function first(value: string | string[] | undefined): string | null {
  const one = Array.isArray(value) ? value[0] : value;
  return one?.trim() ? one.trim() : null;
}

/**
 * `/home?…` as it is read now (E3). A link to one card goes to that card's
 * address; the To review list (`?status=feito`) stays a list, with the card
 * it opens; anything else is the board with the filter the link carried. A
 * redirect in next.config would carry the `card` parameter along
 * (`/cards/OCL-12?card=OCL-12`), so `/home` is a page that only redirects.
 */
export function homeDestination(query: Query): string {
  const card = first(query.card);
  if (card && first(query.status) !== "feito") {
    return `/cards/${encodeURIComponent(card)}`;
  }
  const qs = queryString(query);
  return qs ? `/board?${qs}` : "/board";
}

/**
 * The query parameter the board reads a card's address from (E3).
 * `/cards/OCL-12` is served by the board page itself (a rewrite, not a page of
 * its own), so the board stays mounted while a card opens and closes over it,
 * and a refresh with the card open rebuilds the same board, not another page.
 */
export const CARD_ROUTE_PARAM = "cardRoute";

export const CARD_ROUTE_REWRITES = [
  { source: "/cards/:id", destination: `/board?${CARD_ROUTE_PARAM}=:id` },
];
