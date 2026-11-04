"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { Dict } from "../../lib/i18n";
import {
  SETTINGS_GROUPS,
  settingsAnchorDestination,
  settingsGroupOf,
  settingsHref,
  type SettingsGroupId,
  type SettingsPlace,
  type SettingsSectionId,
} from "./groups";

/**
 * The Settings menu on the left (E5). Every item is a page with its own URL,
 * so F5 keeps the place and Back leaves it. A group with sections is a label
 * over its pages, not a page that stacks them.
 */
export function SettingsGroupsNav({
  current,
  t,
}: {
  current: SettingsPlace;
  t: Dict;
}) {
  const router = useRouter();
  const activeRef = useRef<HTMLAnchorElement>(null);
  const currentGroup = settingsGroupOf(current);

  // An old link with an anchor (`/settings/agents#usage-recipes`) lands on the
  // group's first section with the anchor still on it: the server never saw
  // it. Forward it to the page it names, replacing this entry in history.
  useEffect(() => {
    const destination = settingsAnchorDestination(window.location.hash);
    if (destination && destination !== window.location.pathname) router.replace(destination);
  }, [router]);

  // On a phone the menu is one scrolling line: keep the page you are on in it.
  useEffect(() => {
    if (window.matchMedia("(max-width: 899px)").matches) {
      activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [current]);

  const label: Record<SettingsGroupId, string> = {
    "organizations-projects": t.groups.organizationsProjects,
    agents: t.groups.agents,
    team: t.groups.team,
    prices: t.groups.prices,
    system: t.groups.system,
  };
  const section: Record<SettingsSectionId, string> = {
    connections: t.groups.connections,
    "usage-recipes": t.groups.usageRecipes,
    "claim-timeout": t.groups.claimTimeout,
    people: t.groups.people,
    invitations: t.groups.invitations,
    language: t.groups.language,
    updates: t.groups.updates,
  };
  const link = (href: string, on: boolean, text: string) => (
    <a
      href={href}
      ref={on ? activeRef : undefined}
      aria-current={on ? "page" : undefined}
      className={on ? "on" : ""}
    >
      {text}
    </a>
  );
  return (
    <nav className="sgroups-nav" aria-label={t.groups.navLabel}>
      <ul>
        {SETTINGS_GROUPS.map((group) => (
          <li key={group.id} className={currentGroup === group.id ? "in" : undefined}>
            {group.sections.length === 0 ? (
              link(settingsHref(group.id), current === group.id, label[group.id])
            ) : (
              <>
                <span className="sgroups-label">{label[group.id]}</span>
                <ul className="sgroups-sub">
                  {group.sections.map((item) => (
                    <li key={item.id}>
                      {link(settingsHref(group.id, item.id), current === item.id, section[item.id])}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
