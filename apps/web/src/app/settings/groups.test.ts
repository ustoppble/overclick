import { describe, expect, it } from "vitest";
import {
  SETTINGS_GROUPS,
  SETTINGS_GROUP_IDS,
  isSettingsGroup,
  settingsGroupHref,
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

  it("link to /settings/<group>, with the anchor when there is one", () => {
    expect(settingsGroupHref("prices")).toBe("/settings/prices");
    expect(settingsGroupHref("agents", "connections")).toBe(
      "/settings/agents#connections",
    );
  });

  it("keep the anchors the old tabs redirect to", () => {
    const agents = SETTINGS_GROUPS.find((g) => g.id === "agents");
    expect(agents?.anchors.map((a) => a.id)).toEqual([
      "connections",
      "usage-recipes",
      "claim-timeout",
    ]);
    expect(agents?.anchors.map((a) => a.id)).not.toContain("allowed-models");
  });
});
