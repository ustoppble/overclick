import { describe, expect, it } from "vitest";
import { settingsTabDestination } from "../../lib/redirects";

/**
 * Every `/settings?tab=…` link that already left the app (bookmarks, links
 * people sent each other, the cost popover's "no price" link) lands on the
 * group that holds that tab now, in one hop. The member has one place only:
 * Meu agente.
 */
describe("the old Settings tabs find their group (E5, F11)", () => {
  const admin: Array<[string, string]> = [
    ["exec", "/settings/agents"],
    ["tokens", "/settings/agents#connections"],
    ["recipes", "/settings/agents#usage-recipes"],
    ["claims", "/settings/agents#claim-timeout"],
    ["organizations", "/settings/organizations-projects"],
    ["projects", "/settings/organizations-projects"],
    ["team", "/settings/team"],
    ["prices", "/settings/prices"],
    ["language", "/settings/system"],
    ["updates", "/settings/system"],
  ];

  it.each(admin)("admin ?tab=%s goes to %s", (tab, destination) => {
    expect(settingsTabDestination(tab, "admin")).toBe(destination);
  });

  it.each(admin)("member ?tab=%s goes to Meu agente", (tab) => {
    expect(settingsTabDestination(tab, "member")).toBe("/account/agent");
  });

  it("opens the admin on organizations and projects without a tab, or with an unknown one", () => {
    expect(settingsTabDestination(undefined, "admin")).toBe(
      "/settings/organizations-projects",
    );
    expect(settingsTabDestination("nope", "admin")).toBe(
      "/settings/organizations-projects",
    );
    expect(settingsTabDestination(["prices", "team"], "admin")).toBe(
      "/settings/prices",
    );
  });

  it("sends the member to Meu agente without a tab too", () => {
    expect(settingsTabDestination(undefined, "member")).toBe("/account/agent");
  });
});
