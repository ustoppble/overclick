import { describe, expect, it } from "vitest";
import { ADMIN_DEFAULT_TAB, SETTINGS_TABS, settingsInitialTab } from "./tabs";

/**
 * The Executors tab left Settings (E2): the Overclock app decides what runs.
 * A link that still says `?tab=exec` opens Settings on the default tab
 * instead of failing.
 */
describe("the Settings tabs", () => {
  it("no longer has an Executors tab", () => {
    expect(SETTINGS_TABS.has("exec")).toBe(false);
    expect([...SETTINGS_TABS]).toContain("recipes");
  });

  it("opens the admin on organizations, also from an old ?tab=exec link", () => {
    expect(ADMIN_DEFAULT_TAB).toBe("organizations");
    expect(settingsInitialTab("exec", true)).toBe("organizations");
    expect(settingsInitialTab(undefined, true)).toBe("organizations");
    expect(settingsInitialTab(["prices"], true)).toBe("organizations");
    expect(settingsInitialTab("prices", true)).toBe("prices");
  });

  it("keeps a member on their tokens", () => {
    expect(settingsInitialTab("exec", false)).toBe("tokens");
    expect(settingsInitialTab("prices", false)).toBe("tokens");
  });
});
