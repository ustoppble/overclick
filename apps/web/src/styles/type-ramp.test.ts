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

function findFontSizeViolations(file: string, css: string): Violation[] {
  const violations: Violation[] = [];
  for (const rule of parseRules(css)) {
    for (const decl of parseDeclarations(rule.body)) {
      if (decl.prop !== "font-size") continue;
      // A token (var(--...)) or a responsive clamp() carries no literal
      // value to hold to a fixed ramp; only a bare `<number>px` is checked.
      const match = /^(\d+(?:\.\d+)?)px$/.exec(decl.value);
      if (!match) continue;
      const px = Number(match[1]);
      if (!RAMP.has(px)) {
        violations.push({ file, selector: rule.selector, value: decl.value });
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

  it("declares only 22/16/13/12/11px, or an explicitly allowlisted legacy escape", () => {
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

  it("keeps no escape for the executors grid, which left with E2", () => {
    // The grid, its "seen" chips and the old policy chain are gone; a rule
    // that brings any of them back below the ramp needs a new decision, not
    // a leftover entry.
    const grid = /\.exec(-add|-grid)?\s|\.exec \.|\.mchip|\.seen-|\.policy \.chain/;
    expect(KNOWN_TYPE_RAMP_EXCEPTIONS.filter((v) => grid.test(`${v.selector} `))).toEqual([]);
    expect(allViolations.filter((v) => grid.test(`${v.selector} `))).toEqual([]);
  });
});
