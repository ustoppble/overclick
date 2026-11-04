/**
 * The Settings groups (E5, F8/F11): the ten tabs became five places, each with
 * a URL. A group can have anchors for the panels inside it, which is what the
 * old `?tab=` links land on.
 */
export type SettingsGroupId =
  | "organizations-projects"
  | "agents"
  | "team"
  | "prices"
  | "system";

export type SettingsGroup = {
  id: SettingsGroupId;
  anchors: ReadonlyArray<{ id: string }>;
};

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: "organizations-projects", anchors: [] },
  {
    id: "agents",
    // `allowed-models` left with the Executors tab in E2.
    anchors: [{ id: "connections" }, { id: "usage-recipes" }, { id: "claim-timeout" }],
  },
  { id: "team", anchors: [{ id: "people" }, { id: "invitations" }] },
  { id: "prices", anchors: [] },
  { id: "system", anchors: [{ id: "language" }, { id: "updates" }] },
];

export const SETTINGS_GROUP_IDS: readonly SettingsGroupId[] = SETTINGS_GROUPS.map(
  (group) => group.id,
);

export function isSettingsGroup(value: unknown): value is SettingsGroupId {
  return typeof value === "string" && (SETTINGS_GROUP_IDS as readonly string[]).includes(value);
}

export function settingsGroupHref(group: SettingsGroupId, anchor?: string): string {
  return anchor ? `/settings/${group}#${anchor}` : `/settings/${group}`;
}
