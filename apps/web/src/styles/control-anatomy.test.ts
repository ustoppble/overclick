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
const TRIGGER_CLASSES = ["am-trigger", "pf-trigger", "mf-trigger", "ff-trigger", "period-trigger"];

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
      // The shared anatomy rule hardcodes 8px today rather than the token;
      // both resolve to the same doctrinal value, so both pass.
      expect(["8px", "var(--oc-radius-control)"]).toContain(radius);
    });
  }
});
