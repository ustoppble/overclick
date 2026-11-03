import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS } from "./audited-sheets";
import { parseDeclarations, parseRules, splitSelectorList, type CssRule } from "./css-rules";

/**
 * The head of a column has to hold at every width the five columns share the
 * screen, from 769px (just above the phone list) up. Between 769 and about
 * 1000px a column is ~140px wide: the title wrapped to two lines and the count
 * was squeezed beside it.
 */
const rules = Object.values(COMPONENT_SHEETS).flatMap((css) => parseRules(css));

function rulesFor(selector: string, insideAtRule: boolean): CssRule[] {
  return rules.filter(
    (rule) =>
      rule.insideAtRule === insideAtRule && splitSelectorList(rule.selector).includes(selector),
  );
}

function declared(list: CssRule[], prop: string): string | null {
  let value: string | null = null;
  for (const rule of list) {
    for (const decl of parseDeclarations(rule.body)) {
      if (decl.prop === prop) value = decl.value.trim();
    }
  }
  return value;
}

describe("the column head is one line at every width", () => {
  const head = rulesFor(".nb .col-head", false);

  it("lays the mark, the title and the count on one flex row, centred on it", () => {
    expect(declared(head, "display")).toBe("flex");
    expect(declared(head, "align-items")).toBe("center");
    expect(declared(head, "flex-wrap")).toBeNull();
  });

  it("keeps the title on one line and elides it before it pushes the count out", () => {
    const title = rulesFor(".nb .col-head .col-title", false);
    expect(declared(title, "white-space")).toBe("nowrap");
    expect(declared(title, "overflow")).toBe("hidden");
    expect(declared(title, "text-overflow")).toBe("ellipsis");
    expect(declared(title, "min-width")).toBe("0");
  });

  it("keeps the count whole and in front of the cards, never shrunk", () => {
    const count = rulesFor(".nb .col-head .count", false);
    expect(declared(count, "white-space")).toBe("nowrap");
    expect(declared(count, "flex")).toBe("none");
  });

  it("carries no older-cards count, hint or button: the period decides what a column holds", () => {
    const text = Object.values(COMPONENT_SHEETS).join("\n");
    expect(text).not.toContain("older-hint");
    expect(text).not.toContain("col-more");
  });
});

describe("the facet menu trigger swaps its name on the phone", () => {
  it("shows Filters on the bar and More filters in the sheet, one of the two at a time", () => {
    expect(declared(rulesFor(".nb .ff-trigger .ff-label-sheet", false), "display")).toBe("none");
    const inPhone = (selector: string) =>
      rules.filter(
        (rule) => rule.insideAtRule && splitSelectorList(rule.selector).includes(selector),
      );
    expect(declared(inPhone(".nb .ff-trigger .ff-label-bar"), "display")).toBe("none");
    expect(declared(inPhone(".nb .ff-trigger .ff-label-sheet"), "display")).toBe("inline");
  });
});

describe("the date the period reads lives in More filters on the phone", () => {
  const inPhone = (selector: string) =>
    rules.filter((rule) => rule.insideAtRule && splitSelectorList(rule.selector).includes(selector));

  it("hides the bar's own control in the sheet and shows the section in the menu instead", () => {
    expect(declared(rulesFor(".nb .ff-sheet-only", false), "display")).toBe("none");
    expect(declared(inPhone(".nb .ff-sheet-only"), "display")).toBe("block");
    expect(declared(inPhone(".nb .topbar-more .period-by-filter"), "display")).toBe("none");
  });

  it("counts it on the More filters badge only where the menu holds it", () => {
    expect(declared(rulesFor(".nb .ff-trigger .badge.ff-badge-sheet", false), "display")).toBe("none");
    expect(declared(inPhone(".nb .ff-trigger .badge.ff-badge-bar"), "display")).toBe("none");
    expect(declared(inPhone(".nb .ff-trigger .badge.ff-badge-sheet"), "display")).toBe("inline-flex");
  });
});
