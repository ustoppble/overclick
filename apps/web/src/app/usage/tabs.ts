/**
 * The Consumo tabs (E5). `?by=` picks one; the page keeps the scope and the
 * period it was opened with, so a tab is a different cut of the same answer.
 */
export const USAGE_TABS = [
  "overview",
  "project",
  "mission",
  "agent",
  "model",
  "release",
  "card",
] as const;

export type UsageTab = (typeof USAGE_TABS)[number];

export type UsageBlock =
  | "totals"
  | "charts"
  | "project"
  | "mission"
  | "agent"
  | "model"
  | "reopened"
  | "release"
  | "card";

type Query = Record<string, string | string[] | undefined>;

/** `?by=`, with a missing or unknown value read as the overview. */
export function usageTab(by: string | string[] | undefined): UsageTab {
  const asked = Array.isArray(by) ? by[0] : by;
  return (USAGE_TABS as readonly string[]).includes(asked ?? "")
    ? (asked as UsageTab)
    : "overview";
}

/** What each tab draws: the overview the totals and charts, the others one table. */
export function usageTables(tab: UsageTab): UsageBlock[] {
  return tab === "overview" ? ["totals", "charts"] : [tab];
}

/** The link to a tab: every parameter but `by` is kept, in the order it came. */
export function usageTabHref(tab: UsageTab, query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "by") continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one !== undefined && one !== "") params.append(key, one);
    }
  }
  if (tab !== "overview") params.set("by", tab);
  const qs = params.toString();
  return qs ? `/usage?${qs}` : "/usage";
}
