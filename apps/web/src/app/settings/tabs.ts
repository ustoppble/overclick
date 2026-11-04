/** The tabs the client knows, so a link can land on one (OCL-20). */
export const SETTINGS_TABS: ReadonlySet<string> = new Set([
  "team",
  "organizations",
  "projects",
  "prices",
  "recipes",
  "tokens",
  "claims",
  "language",
  "updates",
]);

/**
 * Where the admin lands without a tab. It was the Executors tab until E2
 * took it out: the Overclock app decides what runs.
 */
export const ADMIN_DEFAULT_TAB = "organizations";

/**
 * The tab Settings opens on. An unknown tab is the same as no tab, which is
 * how an old `?tab=exec` link still opens Settings. A member has one tab:
 * their own tokens and pairing (OCL-222).
 */
export function settingsInitialTab(
  tabParam: string | string[] | undefined,
  admin: boolean,
): string {
  if (!admin) return "tokens";
  return typeof tabParam === "string" && SETTINGS_TABS.has(tabParam)
    ? tabParam
    : ADMIN_DEFAULT_TAB;
}
