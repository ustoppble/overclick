import type { Dict } from "../../lib/i18n";
import { SETTINGS_GROUPS, settingsGroupHref, type SettingsGroupId } from "./groups";

/**
 * The Settings groups as a nav on the left (E5). Each group is a page with its
 * own URL, so F5 keeps the place and Back leaves it. The anchors under a group
 * are the panels inside it.
 */
export function SettingsGroupsNav({
  current,
  t,
}: {
  current: SettingsGroupId;
  t: Dict;
}) {
  const label: Record<SettingsGroupId, string> = {
    "organizations-projects": t.groups.organizationsProjects,
    agents: t.groups.agents,
    team: t.groups.team,
    prices: t.groups.prices,
    system: t.groups.system,
  };
  const anchor: Record<string, string> = {
    connections: t.groups.connections,
    "usage-recipes": t.groups.usageRecipes,
    "claim-timeout": t.groups.claimTimeout,
    people: t.groups.people,
    invitations: t.groups.invitations,
    language: t.groups.language,
    updates: t.groups.updates,
  };
  return (
    <nav className="sgroups-nav" aria-label={t.groups.navLabel}>
      <ul>
        {SETTINGS_GROUPS.map((group) => (
          <li key={group.id}>
            <a
              href={settingsGroupHref(group.id)}
              aria-current={current === group.id ? "page" : undefined}
              className={current === group.id ? "on" : ""}
            >
              {label[group.id]}
            </a>
            {group.anchors.length > 0 ? (
              <ul className="sgroups-sub">
                {group.anchors.map((item) => (
                  <li key={item.id}>
                    <a href={settingsGroupHref(group.id, item.id)}>{anchor[item.id]}</a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}
