/**
 * The Settings groups (E5, F8/F11): the ten tabs became five places, each with
 * a URL. A group can have sections, and each section is a page of its own at
 * `/settings/<group>/<section>`: the menu is a list of pages, never anchors
 * into one long page. A group with sections has no page of its own; it opens
 * on its first section.
 */
export type SettingsGroupId =
  | "organizations-projects"
  | "agents"
  | "team"
  | "prices"
  | "system";

export type SettingsSectionId =
  | "connections"
  | "usage-recipes"
  | "claim-timeout"
  | "people"
  | "invitations"
  | "language"
  | "updates";

/** What one Settings page shows: a group with no sections, or one section. */
export type SettingsPlace =
  | Extract<SettingsGroupId, "organizations-projects" | "prices">
  | SettingsSectionId;

export type SettingsGroup = {
  id: SettingsGroupId;
  sections: ReadonlyArray<{ id: SettingsSectionId }>;
};

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: "organizations-projects", sections: [] },
  {
    id: "agents",
    // `allowed-models` left with the Executors tab in E2.
    sections: [{ id: "connections" }, { id: "usage-recipes" }, { id: "claim-timeout" }],
  },
  { id: "team", sections: [{ id: "people" }, { id: "invitations" }] },
  { id: "prices", sections: [] },
  { id: "system", sections: [{ id: "language" }, { id: "updates" }] },
];

export const SETTINGS_GROUP_IDS: readonly SettingsGroupId[] = SETTINGS_GROUPS.map(
  (group) => group.id,
);

export function isSettingsGroup(value: unknown): value is SettingsGroupId {
  return typeof value === "string" && (SETTINGS_GROUP_IDS as readonly string[]).includes(value);
}

function sectionsOf(group: SettingsGroupId): ReadonlyArray<{ id: SettingsSectionId }> {
  return SETTINGS_GROUPS.find((g) => g.id === group)?.sections ?? [];
}

export function settingsHref(group: SettingsGroupId, section?: SettingsSectionId): string {
  return section ? `/settings/${group}/${section}` : `/settings/${group}`;
}

/** The section a `/settings/<group>/<section>` address asks for, or null. */
export function settingsSectionOf(group: SettingsGroupId, value: string): SettingsSectionId | null {
  return sectionsOf(group).find((section) => section.id === value)?.id ?? null;
}

/**
 * Where `/settings/<group>` sends now: its first section, or null when the
 * group has none and is a page itself.
 */
export function settingsGroupDestination(group: SettingsGroupId): string | null {
  const first = sectionsOf(group)[0];
  return first ? settingsHref(group, first.id) : null;
}

/**
 * The same hop as an HTTP redirect, in next.config: it answers before the
 * page streams, so it is a real 307 and the browser carries an old link's
 * `#anchor` to the destination (a redirect from inside a streamed page loses
 * it). Temporary: the destination is the same for everyone, but the page
 * behind it still sends a member elsewhere.
 */
export const SETTINGS_GROUP_REDIRECTS = SETTINGS_GROUPS.flatMap((group) => {
  const destination = settingsGroupDestination(group.id);
  return destination
    ? [{ source: settingsHref(group.id), destination, permanent: false as const }]
    : [];
});

/** The group a page belongs to, for the menu. */
export function settingsGroupOf(place: SettingsPlace): SettingsGroupId {
  if (isSettingsGroup(place)) return place;
  return SETTINGS_GROUPS.find((g) => g.sections.some((s) => s.id === place))!.id;
}

/**
 * An old link's anchor (`#usage-recipes`), as the page it names now. The
 * server never sees an anchor: `/settings/agents#usage-recipes` reaches the
 * group's first section with the anchor kept by the browser, and the page
 * forwards it from there.
 */
export function settingsAnchorDestination(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  for (const group of SETTINGS_GROUPS) {
    if (group.sections.some((section) => section.id === id)) {
      return settingsHref(group.id, id as SettingsSectionId);
    }
  }
  return null;
}
