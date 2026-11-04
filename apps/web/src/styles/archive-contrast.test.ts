import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS } from "./audited-sheets";
import { parseDeclarations, parseRules, splitSelectorList } from "./css-rules";
import { THEMES } from "../lib/theme";
import { inkOnFloor } from "./theme-colors";

/**
 * The archive is quieter by ink, never by fade (E0, A3).
 *
 * `.card.dim { opacity: .6 }` multiplied text that was already translucent:
 * the id and the meta of a validated card fell to 2.2:1, and the phone row at
 * .55 to 2.0:1. A fade over readable text is the bug itself, so no `.dim`
 * rule may declare one; the archive steps down the ink ladder instead, and
 * the bottom of that ladder has to pass on the floors a card sits on.
 */

const rules = Object.values(COMPONENT_SHEETS).flatMap((css) => parseRules(css));

describe("the archive never fades its text", () => {
  it("no .dim rule declares an opacity", () => {
    const faded = rules
      .filter((rule) => splitSelectorList(rule.selector).some((s) => /\.dim\b/.test(s)))
      .filter((rule) => parseDeclarations(rule.body).some((d) => d.prop === "opacity"))
      .map((rule) => rule.selector);
    expect(faded).toEqual([]);
  });

  it("a validated card steps its title down to text-2 instead", () => {
    const title = rules.filter((rule) =>
      splitSelectorList(rule.selector).includes(".nb .card.dim h4"),
    );
    const color = title
      .flatMap((rule) => parseDeclarations(rule.body))
      .filter((d) => d.prop === "color")
      .map((d) => d.value)
      .pop();
    expect(color).toBe("var(--nebula-text-secondary)");
  });
});

/* ---------- the bottom of the ink ladder, computed from the tokens ---------- */

describe("the archived card's chips step down to text-3 too (E0 review)", () => {
  // Everything a validated card still says besides its title — the seals,
  // the CLI's name, the record, the numbers and the cost — reads in the
  // bottom ink, so the archive is one quiet level and not a mix of two.
  const CHIPS = [".selo", ".cli-name", ".card-type", ".card-cost", ".meta-harness", ".card-foot"];

  for (const chip of CHIPS) {
    it(`.card.dim ${chip} is text-3`, () => {
      // Said explicitly on the archived card, so no later rule for the live
      // card (a seal tinted for attention, a brighter CLI name) can lift it.
      const selector = `.nb .card.dim ${chip}`;
      const color = rules
        .filter((rule) => splitSelectorList(rule.selector).includes(selector))
        .flatMap((rule) => parseDeclarations(rule.body))
        .filter((d) => d.prop === "color")
        .map((d) => d.value)
        .pop();
      expect(color, selector).toBe("var(--nebula-text-tertiary)");
    });
  }
});

describe("text-3 passes AA on the floors a card sits on", () => {
  for (const theme of THEMES) {
    it(`${theme}: text-3 on the canvas is at least 4.5:1`, () => {
      expect(inkOnFloor(theme, "--oc-text-3", "--oc-bg")).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: text-3 on surface-2 is at least 4.5:1`, () => {
      expect(inkOnFloor(theme, "--oc-text-3", "--oc-surface-2")).toBeGreaterThanOrEqual(4.5);
    });
  }
});
