import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dict } from "../../lib/i18n";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {} }) }));

const { SettingsGroupsNav } = await import("./settings-groups-nav");

const render = (current: Parameters<typeof SettingsGroupsNav>[0]["current"]) =>
  renderToStaticMarkup(createElement(SettingsGroupsNav, { current, t: dict("pt-BR") }));

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const active = (html: string) =>
  [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);

/** The Settings menu is a list of pages, not of anchors into one long page. */
describe("the Settings menu", () => {
  it("links every item to its own page, and nothing to an anchor", () => {
    const html = render("connections");
    expect(hrefs(html)).toEqual([
      "/settings/organizations-projects",
      "/settings/agents/connections",
      "/settings/agents/usage-recipes",
      "/settings/agents/claim-timeout",
      "/settings/team/people",
      "/settings/team/invitations",
      "/settings/prices",
      "/settings/system/language",
      "/settings/system/updates",
    ]);
    expect(html).not.toContain("#");
  });

  it("shows the groups with sections as labels, not as pages", () => {
    const html = render("prices");
    for (const label of ["Agentes", "Equipe", "Sistema"]) {
      expect(html).toContain(`<span class="sgroups-label">${label}</span>`);
    }
  });

  it.each([
    ["organizations-projects", "/settings/organizations-projects"],
    ["prices", "/settings/prices"],
    ["usage-recipes", "/settings/agents/usage-recipes"],
    ["invitations", "/settings/team/invitations"],
    ["updates", "/settings/system/updates"],
  ] as const)("marks %s, and only it, as the page you are on", (current, href) => {
    const marked = active(render(current));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain(`href="${href}"`);
  });
});
