import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS } from "./audited-sheets";
import { parseDeclarations, parseRules, splitSelectorList, type CssRule } from "./css-rules";

/**
 * The head of a column and its "show older" button have to hold at every width
 * the five columns share the screen, from 769px (just above the phone list) up.
 * Between 769 and about 1000px a column is ~140px wide: the title wrapped to
 * two lines, the count and the "+N older" hint were squeezed around it, and the
 * button, which never wrapped, ran into its neighbours.
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

  it("no longer carries the older-cards hint: the number lives in the button", () => {
    const text = Object.values(COMPONENT_SHEETS).join("\n");
    expect(text).not.toContain("older-hint");
  });
});

describe("the show-older button is one 32px control, the same in every column", () => {
  const more = rulesFor(".nb .col .col-more", false);

  it("has the Control's height and radius, one line, the full width of its column", () => {
    expect(declared(more, "height")).toBe("32px");
    expect(declared(more, "border-radius")).toBe("var(--oc-radius-control)");
    expect(declared(more, "white-space")).toBe("nowrap");
    expect(declared(more, "align-self")).toBe("stretch");
    expect(declared(more, "min-width")).toBe("0");
  });

  it("elides its label before it grows past the column", () => {
    const label = rulesFor(".nb .col .col-more > span", false);
    expect(declared(label, "overflow")).toBe("hidden");
    expect(declared(label, "text-overflow")).toBe("ellipsis");
  });

  it("is a full-width, 44px row at the top of the phone list, not a tab in its corner", () => {
    const row = rulesFor(".nb .board-mobile .col .col-more", true);
    expect(declared(row, "display")).toBe("flex");
    expect(declared(row, "width")).toBe("100%");
    expect(declared(row, "height")).toBe("44px");
    expect(declared(row, "border-radius")).toBe("0");
  });

  it("is not moved by anything the head holds: no tie to a hint or a second line", () => {
    const text = Object.values(COMPONENT_SHEETS).join("\n");
    expect(text).not.toContain(".board:has(");
  });
});
