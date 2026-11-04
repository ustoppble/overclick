import { describe, expect, it } from "vitest";
import {
  SETTINGS_GROUPS,
  SETTINGS_GROUP_REDIRECTS,
  SETTINGS_GROUP_IDS,
  isSettingsGroup,
  settingsAnchorDestination,
  settingsGroupDestination,
  settingsHref,
  settingsSectionOf,
} from "./groups";

describe("the Settings groups (E5, F8/F11)", () => {
  it("are the five the design draws, in order", () => {
    expect(SETTINGS_GROUP_IDS).toEqual([
      "organizations-projects",
      "agents",
      "team",
      "prices",
      "system",
    ]);
  });

  it("know a group, and nothing else", () => {
    expect(isSettingsGroup("agents")).toBe(true);
    expect(isSettingsGroup("exec")).toBe(false);
    expect(isSettingsGroup(undefined)).toBe(false);
  });

  it("keep the sections the old anchors named, as pages now", () => {
    const sections = Object.fromEntries(
      SETTINGS_GROUPS.map((g) => [g.id, g.sections.map((s) => s.id)]),
    );
    expect(sections).toEqual({
      "organizations-projects": [],
      agents: ["connections", "usage-recipes", "claim-timeout"],
      team: ["people", "invitations"],
      prices: [],
      system: ["language", "updates"],
    });
    expect(sections.agents).not.toContain("allowed-models");
  });
});

/**
 * Every item of the Settings menu is a page of its own (OCL settings pages):
 * a group with sections has no page that stacks them, it opens on its first.
 */
describe("each Settings item has its own address", () => {
  it("links to /settings/<group>/<section>, or /settings/<group> for a group with none", () => {
    expect(settingsHref("prices")).toBe("/settings/prices");
    expect(settingsHref("organizations-projects")).toBe("/settings/organizations-projects");
    expect(settingsHref("agents", "connections")).toBe("/settings/agents/connections");
    expect(settingsHref("system", "updates")).toBe("/settings/system/updates");
  });

  it("never puts an anchor in a link", () => {
    for (const group of SETTINGS_GROUPS) {
      expect(settingsHref(group.id)).not.toContain("#");
      for (const section of group.sections) {
        expect(settingsHref(group.id, section.id)).not.toContain("#");
      }
    }
  });

  it("sends a group with sections to its first one, and leaves the others alone", () => {
    expect(settingsGroupDestination("agents")).toBe("/settings/agents/connections");
    expect(settingsGroupDestination("team")).toBe("/settings/team/people");
    expect(settingsGroupDestination("system")).toBe("/settings/system/language");
    expect(settingsGroupDestination("prices")).toBeNull();
    expect(settingsGroupDestination("organizations-projects")).toBeNull();
  });

  it("answers that hop before the page, as a temporary redirect", () => {
    expect(SETTINGS_GROUP_REDIRECTS).toEqual([
      { source: "/settings/agents", destination: "/settings/agents/connections", permanent: false },
      { source: "/settings/team", destination: "/settings/team/people", permanent: false },
      { source: "/settings/system", destination: "/settings/system/language", permanent: false },
    ]);
  });

  it("knows a section only inside its own group", () => {
    expect(settingsSectionOf("agents", "claim-timeout")).toBe("claim-timeout");
    expect(settingsSectionOf("agents", "people")).toBeNull();
    expect(settingsSectionOf("prices", "anything")).toBeNull();
    expect(settingsSectionOf("system", "nope")).toBeNull();
  });
});

/**
 * The old links carried an anchor (`/settings/agents#usage-recipes`). The
 * server never sees it: the group answers with its first section and the
 * browser keeps the anchor across the redirect, so the page forwards it here.
 */
describe("an old #anchor finds its page", () => {
  it.each([
    ["#connections", "/settings/agents/connections"],
    ["#usage-recipes", "/settings/agents/usage-recipes"],
    ["#claim-timeout", "/settings/agents/claim-timeout"],
    ["#people", "/settings/team/people"],
    ["#invitations", "/settings/team/invitations"],
    ["#language", "/settings/system/language"],
    ["#updates", "/settings/system/updates"],
  ])("%s goes to %s", (hash, destination) => {
    expect(settingsAnchorDestination(hash)).toBe(destination);
  });

  it("ignores no anchor, an unknown one, and anything that is not a section", () => {
    expect(settingsAnchorDestination("")).toBeNull();
    expect(settingsAnchorDestination("#")).toBeNull();
    expect(settingsAnchorDestination("#allowed-models")).toBeNull();
    expect(settingsAnchorDestination("#prices")).toBeNull();
  });
});
