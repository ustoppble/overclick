import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS } from "./audited-sheets";
import {
  classSpecificity,
  parseDeclarations,
  parseRules,
  splitSelectorList,
  type CssRule,
} from "./css-rules";

/**
 * The Control (ux-v2 §3): one anatomy for every bar trigger — 32px tall, 1px
 * border, `--oc-radius-control` (8px). It was the absence of this guard that
 * let `.mf-trigger` end up with `border-width: 0` and a 16px box while its
 * three neighbours stayed correct (OCL-89's motivation).
 *
 * The touch floor (44px vs 32px, A1/OCL-87) is in dispute in this same
 * mission — this guard checks the rest of the anatomy and deliberately does
 * NOT assert a hit-area floor. That is its own guard, once the amendment's
 * implementation card lands.
 *
 * Cascade resolution here is deliberately simple, not a full CSS engine: it
 * only compares class-selector specificity and source order, and it skips
 * everything written inside `@media` (the anatomy is a base/desktop
 * property; responsive folds are a separate concern). That is enough for
 * this codebase, where every trigger selector is class-based.
 */
const TRIGGER_CLASSES = ["gb-avatar", "gb-chip", "pf-trigger", "mf-trigger", "ff-trigger", "period-trigger"];

/**
 * The avatar is the one round trigger (navigation plan E1): it is a person,
 * not a command, and the circle is what tells the two apart. It keeps the
 * border and the 32px box of every other trigger; only the radius differs.
 */
const ROUND_TRIGGERS: Record<string, string> = { "gb-avatar": "50%" };

const STATEFUL_PSEUDO = /:hover|:focus|:active|:disabled/;

function targetsClass(simpleSelector: string, cls: string): boolean {
  const re = new RegExp(`\\.${cls}\\b(?![-\\w])`);
  return re.test(simpleSelector);
}

/** `border: <width> ...` sets border-width too; pull out just the width. */
function borderShorthandWidth(value: string): string | null {
  const first = value.trim().split(/\s+/)[0];
  if (/^(0|\d+(\.\d+)?(px|em|rem))$/.test(first)) return first;
  return null;
}

type Property = "border-width" | "height" | "border-radius";

function extractProperty(decl: { prop: string; value: string }, property: Property): string | null {
  if (property === "border-width") {
    if (decl.prop === "border-width") return decl.value.trim();
    if (decl.prop === "border") return borderShorthandWidth(decl.value);
    return null;
  }
  if (decl.prop === property) return decl.value.trim();
  return null;
}

interface Winner {
  value: string;
  specificity: number;
}

/** Last matching declaration wins on a specificity tie; higher specificity always wins. */
function resolveEffectiveValue(
  rules: { rule: CssRule; sourceOrder: number }[],
  triggerClass: string,
  property: Property,
): string | null {
  let winner: Winner | null = null;

  for (const { rule } of rules) {
    if (rule.insideAtRule) continue;
    for (const simple of splitSelectorList(rule.selector)) {
      if (STATEFUL_PSEUDO.test(simple)) continue;
      if (!targetsClass(simple, triggerClass)) continue;
      for (const decl of parseDeclarations(rule.body)) {
        const value = extractProperty(decl, property);
        if (value === null) continue;
        const specificity = classSpecificity(simple);
        if (!winner || specificity >= winner.specificity) {
          winner = { value, specificity };
        }
      }
    }
  }

  return winner?.value ?? null;
}

const allRulesInSourceOrder = Object.values(COMPONENT_SHEETS)
  .flatMap((css) => parseRules(css))
  .map((rule, sourceOrder) => ({ rule, sourceOrder }));

describe("every bar trigger keeps the Control anatomy (ux-v2 §3)", () => {
  for (const cls of TRIGGER_CLASSES) {
    it(`.${cls} keeps a 1px border`, () => {
      const width = resolveEffectiveValue(allRulesInSourceOrder, cls, "border-width");
      expect(width, `.${cls} resolved border-width: ${width}`).toBe("1px");
    });

    it(`.${cls} keeps the 32px control box`, () => {
      const height = resolveEffectiveValue(allRulesInSourceOrder, cls, "height");
      expect(height, `.${cls} resolved height: ${height}`).toBe("32px");
    });

    it(`.${cls} keeps the --oc-radius-control radius`, () => {
      const radius = resolveEffectiveValue(allRulesInSourceOrder, cls, "border-radius");
      if (ROUND_TRIGGERS[cls]) {
        expect(radius).toBe(ROUND_TRIGGERS[cls]);
        return;
      }
      // The shared anatomy rule hardcodes 8px today rather than the token;
      // both resolve to the same doctrinal value, so both pass.
      expect(["8px", "var(--oc-radius-control)"]).toContain(radius);
    });
  }
});

/**
 * The stat on level 1 is not a bordered Control, but it shares the row with
 * two of them, so it owes them the same centre line. It hung ~8px above the
 * pill and the menu while it aligned on the text baseline inside a box that
 * was only a minimum, and its overflow clip cut a long figure mid-digit.
 */
function topLevel(selector: string): CssRule[] {
  return allRulesInSourceOrder
    .map(({ rule }) => rule)
    .filter((rule) => !rule.insideAtRule && splitSelectorList(rule.selector).includes(selector));
}

function declared(rules: CssRule[], prop: string): string | null {
  let value: string | null = null;
  for (const rule of rules) {
    for (const decl of parseDeclarations(rule.body)) {
      if (decl.prop === prop) value = decl.value.trim();
    }
  }
  return value;
}

describe("the running total sits on the row's centre line (level 1)", () => {
  const stat = topLevel(".nb .board-total");

  it("is the 32px of the Control beside it, not a minimum", () => {
    expect(declared(stat, "height")).toBe("32px");
    expect(declared(stat, "min-height")).toBeNull();
  });

  it("centres its text instead of aligning it on the baseline", () => {
    expect(declared(stat, "align-items")).toBe("center");
  });

  it("never clips its own figure", () => {
    expect(declared(stat, "overflow")).toBeNull();
  });

  it("sets itself off with a straight stroke, not a border-left on a rounded box", () => {
    expect(declared(stat, "border-left")).toBeNull();
    expect(declared(topLevel(".nb .board-total::before"), "height")).toBe("16px");
  });
});

describe("the global bar is one line of places, state and the avatar (navigation plan E1)", () => {
  const rulesOf = (selector: string, inside: boolean) =>
    allRulesInSourceOrder
      .map(({ rule }) => rule)
      .filter((rule) => rule.insideAtRule === inside && splitSelectorList(rule.selector).includes(selector));
  const has = (rules: CssRule[], prop: string, value: string) =>
    rules.some((rule) =>
      parseDeclarations(rule.body).some((d) => d.prop === prop && d.value.trim() === value),
    );

  it("is a 48px row that never wraps", () => {
    const row = rulesOf(".global-bar .gb-row", false);
    expect(has(row, "display", "flex")).toBe(true);
    expect(has(row, "flex-wrap", "nowrap")).toBe(true);
    expect(has(row, "height", "48px")).toBe(true);
  });

  it("never hides the review chip on the desktop; on the phone it moves to the bottom bar", () => {
    const hides = allRulesInSourceOrder.filter(
      ({ rule }) =>
        splitSelectorList(rule.selector).some((s) => /\.gb-chip-review(?![-\w])/.test(s)) &&
        parseDeclarations(rule.body).some((d) => d.prop === "display" && d.value.trim().startsWith("none")),
    );
    // Exactly one place may hide it: the phone, where the tab bar carries it.
    expect(hides.length).toBe(1);
    expect(hides[0]!.rule.insideAtRule).toBe(true);
    expect(has(rulesOf(".gb-tabbar", true), "display", "grid")).toBe(true);
    expect(has(rulesOf(".gb-tabbar", false), "display", "none")).toBe(true);
  });

  it("drops the running chip's word before anything else", () => {
    expect(has(rulesOf(".global-bar .gb-chip-run .gb-lbl", true), "display", "none")).toBe(true);
  });

  it("leaves the old level 1 out of the board: no state chip, no account menu", () => {
    const text = Object.values(COMPONENT_SHEETS).join("\n");
    expect(text).not.toContain(".am-trigger");
    expect(text).not.toContain(".account-menu");
  });
});

describe("the filter line is one line, and what does not fit steps aside instead of wrapping", () => {
  const inAtRules = (selector: string) =>
    allRulesInSourceOrder
      .map(({ rule }) => rule)
      .filter((rule) => rule.insideAtRule && splitSelectorList(rule.selector).includes(selector));
  const declares = (rules: CssRule[], prop: string, value: string) =>
    rules.some((rule) =>
      parseDeclarations(rule.body).some((d) => d.prop === prop && d.value.trim() === value),
    );

  it("lays the two levels out as one row that never wraps", () => {
    expect(declares(inAtRules(".nb .topbar-wrap"), "display", "flex")).toBe(true);
    expect(declares(inAtRules(".nb .topbar-wrap"), "flex-wrap", "nowrap")).toBe(true);
    expect(declares(inAtRules(".nb .topbar-wrap > .topbar-l1"), "display", "contents")).toBe(true);
    expect(declares(inAtRules(".nb .topbar-wrap > .topbar-l2"), "display", "contents")).toBe(true);
  });

  it("no longer wraps level 2 at any width", () => {
    const wraps = allRulesInSourceOrder.some(
      ({ rule }) =>
        splitSelectorList(rule.selector).includes(".nb .topbar-l2") &&
        parseDeclarations(rule.body).some((d) => d.prop === "flex-wrap" && d.value.trim() === "wrap"),
    );
    expect(wraps).toBe(false);
  });

  it("collapses in order: the cost's support, the period date, the count and the clear label", () => {
    expect(declares(inAtRules(".nb .board-total .bt-sub"), "display", "none")).toBe(true);
    expect(declares(inAtRules(".nb .topbar-l2 .period-by-filter"), "display", "none")).toBe(true);
    expect(declares(inAtRules(".nb .topbar-l2 .ff-sheet-only"), "display", "block")).toBe(true);
    expect(declares(inAtRules(".nb .topbar-l2 .filter-result:not(.narrowed)"), "display", "none")).toBe(true);
    expect(declares(inAtRules(".nb .topbar-l2 .clear-board-filters .cbf-label"), "display", "none")).toBe(true);
  });

  it("never lets the scope pair or the mission shrink below their triggers' floor", () => {
    expect(declares(inAtRules(".nb .topbar-l2 .crumb"), "min-width", "96px")).toBe(true);
    expect(declares(inAtRules(".nb .topbar-l2 .mission-filter"), "min-width", "96px")).toBe(true);
  });

  it("keeps a floor under the project and mission triggers", () => {
    const floor = allRulesInSourceOrder
      .map(({ rule }) => rule)
      .filter(
        (rule) =>
          !rule.insideAtRule &&
          splitSelectorList(rule.selector).some((s) => /\.topbar-l2 \.(pf|mf)-trigger$/.test(s)),
      );
    expect(declared(floor, "min-width")).toBe("96px");
  });
});
