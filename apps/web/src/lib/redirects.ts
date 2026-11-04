/**
 * Where the links that already left the app land now (E5). One hop each: the
 * old page answers with a redirect, and nothing chains. The pages that ask for
 * these are `/insights`, `/organizations` and `/settings?tab=…`.
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
