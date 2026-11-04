import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS } from "./audited-sheets";

/**
 * E5 moves Insights to /usage and adds two sheets of its own (the Settings
 * group nav and the Consumo tabs). Every guard reads COMPONENT_SHEETS, so
 * these have to be on it, under the new paths, and nothing may still point
 * at the old folder.
 */
describe("the E5 sheets are audited", () => {
  it("the Consumo sheet lives under app/usage", () => {
    expect(Object.keys(COMPONENT_SHEETS)).toContain("app/usage/insights.css");
    expect(Object.keys(COMPONENT_SHEETS)).not.toContain("app/insights/insights.css");
  });

  it("the new sheets are on the list", () => {
    expect(Object.keys(COMPONENT_SHEETS)).toContain("app/settings/settings-groups.css");
    expect(Object.keys(COMPONENT_SHEETS)).toContain("app/usage/usage-tabs.css");
  });

  it("the new sheets name no size under 12px and no colour but the tokens", () => {
    for (const file of ["app/settings/settings-groups.css", "app/usage/usage-tabs.css"]) {
      const css = COMPONENT_SHEETS[file] ?? "";
      expect(css.length, file).toBeGreaterThan(0);
      for (const match of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
        expect(Number(match[1]), `${file} font-size`).toBeGreaterThanOrEqual(12);
      }
      expect(css, `${file} colour literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });
});
