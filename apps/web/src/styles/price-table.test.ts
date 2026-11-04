import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS } from "./audited-sheets";
import { parseDeclarations, parseRules, splitSelectorList } from "./css-rules";

/**
 * Settings › Cost is a fixed-layout table of six columns: the model, four
 * prices and the origin (E0, A4). With widths for only five, the sixth got
 * what was left of 100%, which is nothing: the origin broke one letter per
 * line and a row grew to 432px, the page to 16 thousand.
 */
const rules = Object.values(COMPONENT_SHEETS)
  .flatMap((css) => parseRules(css))
  .filter((rule) => !rule.insideAtRule);

function widthOf(column: number): string | null {
  const selector = `.nb .policy.prices th:nth-child(${column})`;
  let value: string | null = null;
  for (const rule of rules) {
    if (!splitSelectorList(rule.selector).includes(selector)) continue;
    for (const decl of parseDeclarations(rule.body)) {
      if (decl.prop === "width") value = decl.value;
    }
  }
  return value;
}

describe("the price table gives each of its six columns a share", () => {
  const widths = [1, 2, 3, 4, 5, 6].map(widthOf);

  it("declares a width for nth-child(1..6)", () => {
    expect(widths.map((w, i) => (w ? i + 1 : `missing ${i + 1}`))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("shares exactly the whole width, in percent", () => {
    const total = widths.reduce((sum, w) => sum + Number((w ?? "0").replace("%", "")), 0);
    expect(widths.every((w) => w?.endsWith("%"))).toBe(true);
    expect(total).toBe(100);
  });
});
