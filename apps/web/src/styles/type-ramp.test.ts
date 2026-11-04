import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS } from "./audited-sheets";
import { parseDeclarations, parseRules } from "./css-rules";
import { TYPE_RAMP_PX } from "./type-ramp";
import { KNOWN_TYPE_RAMP_EXCEPTIONS } from "./type-ramp-exceptions";

interface Violation {
  file: string;
  selector: string;
  value: string;
}

const RAMP = new Set<number>(TYPE_RAMP_PX);

/**
 * The literal size a declaration sets, in px, or null when it sets none.
 * A token (var(--...)) or a responsive clamp() carries no literal value to
 * hold to a fixed ramp; only a bare `<number>px` is checked, in `font-size`
 * and in the `font` shorthand (`font: 500 13px/16px …`), which is where the
 * newer sheets declare their size.
 */
function literalFontSize(prop: string, value: string): number | null {
  if (prop === "font-size") {
    const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
    return match ? Number(match[1]) : null;
  }
  if (prop === "font") {
    const match = /(?:^|\s)(\d+(?:\.\d+)?)px(?=\/|\s|$)/.exec(value);
    return match ? Number(match[1]) : null;
  }
  return null;
}

function findFontSizeViolations(file: string, css: string): Violation[] {
  const violations: Violation[] = [];
  for (const rule of parseRules(css)) {
    for (const decl of parseDeclarations(rule.body)) {
      const px = literalFontSize(decl.prop, decl.value);
      if (px == null) continue;
      if (!RAMP.has(px)) {
        violations.push({ file, selector: rule.selector, value: `${px}px` });
      }
    }
  }
  return violations;
}

function violationKey(v: Violation): string {
  return `${v.file}::${v.selector}::${v.value}`;
}

describe("the type ramp holds (ux-v2 §2, checklist item 3's sibling)", () => {
  const known = new Set(KNOWN_TYPE_RAMP_EXCEPTIONS.map(violationKey));

  const allViolations = Object.entries(COMPONENT_SHEETS).flatMap(([file, css]) =>
    findFontSizeViolations(file, css),
  );

  it("declares only 22/16/13/12px, or an explicitly allowlisted legacy escape", () => {
    const undeclared = allViolations.filter((v) => !known.has(violationKey(v)));
    expect(
      undeclared,
      undeclared
        .map((v) => `${v.file} ${v.selector} declares font-size: ${v.value}`)
        .join("\n"),
    ).toEqual([]);
  });

  it("does not carry allowlist entries the CSS no longer has (keep the escape list honest)", () => {
    const present = new Set(allViolations.map(violationKey));
    const stale = KNOWN_TYPE_RAMP_EXCEPTIONS.filter((v) => !present.has(violationKey(v)));
    expect(
      stale,
      stale.map((v) => `${v.file} ${v.selector} (${v.value}) — fixed, remove from the allowlist`).join("\n"),
    ).toEqual([]);
  });

  it("has no step below 12px (navigation plan E7: nothing under 12)", () => {
    expect(Math.min(...TYPE_RAMP_PX)).toBeGreaterThanOrEqual(12);
    expect([...TYPE_RAMP_PX]).toEqual([22, 16, 13, 12]);
  });

  it("keeps no escape below 12px: the floor has no exceptions", () => {
    const below = KNOWN_TYPE_RAMP_EXCEPTIONS.filter((v) => parseFloat(v.value) < 12);
    expect(
      below,
      below.map((v) => `${v.file} ${v.selector} (${v.value})`).join("\n"),
    ).toEqual([]);
  });

  it("no audited sheet declares a size below 12px, allowlisted or not", () => {
    const below = allViolations.filter((v) => parseFloat(v.value) < 12);
    expect(
      below,
      below.map((v) => `${v.file} ${v.selector} declares ${v.value}`).join("\n"),
    ).toEqual([]);
  });

  it("keeps no escape for the executors grid, which left with E2", () => {
    // The grid, its "seen" chips and the old policy chain are gone; a rule
    // that brings any of them back below the ramp needs a new decision, not
    // a leftover entry.
    const grid = /\.exec(-add|-grid)?\s|\.exec \.|\.mchip|\.seen-|\.policy \.chain/;
    expect(KNOWN_TYPE_RAMP_EXCEPTIONS.filter((v) => grid.test(`${v.selector} `))).toEqual([]);
    expect(allViolations.filter((v) => grid.test(`${v.selector} `))).toEqual([]);
  });
});
