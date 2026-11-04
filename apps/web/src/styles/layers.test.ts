import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The layer contract, enforced (OCL-59).
 *
 * The board lost the clicks on its own account menu to a card: the bar's
 * glass makes the bar a stacking context, so the menu's z-index counted only
 * inside the bar, and from outside the bar had no layer at all — which put
 * every card that comes later in the document over an open menu.
 *
 * Three things keep that from coming back, and none of them survives review
 * alone:
 *   1. no rule writes a z-index of its own — a rule names a rung;
 *   2. the rungs are ordered, so "menu over the board" is a fact about the
 *      ladder and not about which element happens to open a context;
 *   3. the bar states its rung at every width, in the base rule, because a
 *      layer that only exists under a media query is the bug itself.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");

const COMPONENT_SHEETS = {
  "styles/nebula.css": read("nebula.css"),
  "styles/global-bar.css": read("global-bar.css"),
  "app/insights/insights.css": read("../app/insights/insights.css"),
  "app/settings/project-context.module.css": read(
    "../app/settings/project-context.module.css",
  ),
};
const BASE_THEME = read("themes/nebula.css");

/** Comments hold examples and old values; only real CSS is under test. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The ladder, floor first. The order here is the order on screen. */
const LADDER = [
  "--oc-z-atmo-back",
  "--oc-z-atmo-mid",
  "--oc-z-atmo-front",
  "--oc-z-content",
  "--oc-z-fade",
  "--oc-z-bar",
  "--oc-z-panel",
  "--oc-z-backdrop",
  "--oc-z-chrome",
  "--oc-z-menu",
  "--oc-z-modal",
  "--oc-z-sheet",
];

function rung(name: string): number {
  const found = stripComments(BASE_THEME).match(
    new RegExp(`${name}\\s*:\\s*(-?\\d+)\\s*;`),
  );
  if (!found) throw new Error(`${name} is not declared by the base theme`);
  return Number(found[1]);
}

describe("no rule writes a layer of its own", () => {
  for (const [name, css] of Object.entries(COMPONENT_SHEETS)) {
    it(`${name} names a rung on every z-index`, () => {
      const written = [...stripComments(css).matchAll(/z-index\s*:\s*([^;}]+)/g)]
        .map((m) => m[1].trim())
        .filter((value) => !/^var\(--oc-z-[a-z-]+\)$/.test(value));
      expect(written).toEqual([]);
    });
  }
});

describe("the ladder is a ladder", () => {
  it("every rung the board asks for is declared, and only those", () => {
    const asked = new Set(
      Object.values(COMPONENT_SHEETS).flatMap((css) =>
        [...stripComments(css).matchAll(/var\(\s*(--oc-z-[a-z-]+)\s*\)/g)].map((m) => m[1]),
      ),
    );
    expect([...asked].filter((name) => !LADDER.includes(name))).toEqual([]);
  });

  it("climbs, one rung strictly above the last", () => {
    const values = LADDER.map(rung);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });

  it("puts a menu over everything the board draws under it", () => {
    for (const below of ["--oc-z-content", "--oc-z-fade", "--oc-z-bar", "--oc-z-panel", "--oc-z-chrome"]) {
      expect(rung("--oc-z-menu"), `menu vs ${below}`).toBeGreaterThan(rung(below));
    }
    // and the detail, which a menu can open, stays over the menu
    expect(rung("--oc-z-modal")).toBeGreaterThan(rung("--oc-z-menu"));
    expect(rung("--oc-z-sheet")).toBeGreaterThan(rung("--oc-z-modal"));
  });
});

describe("the bar carries its rung at every width", () => {
  // The board's bars live in nebula.css, the global bar in its own sheet.
  const css = stripComments(
    COMPONENT_SHEETS["styles/nebula.css"] + "\n" + COMPONENT_SHEETS["styles/global-bar.css"],
  );

  /** The body of a top-level rule for `selector`, or null if it only exists
   *  inside a media query. */
  function baseRule(selector: string): string | null {
    let depth = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === "{") {
        if (depth === 0) {
          const head = css.slice(0, i).split("}").pop()!.split("{").pop()!.trim();
          if (head === selector) {
            const end = css.indexOf("}", i);
            return css.slice(i + 1, end);
          }
        }
        depth++;
      } else if (css[i] === "}") depth--;
    }
    return null;
  }

  // `.topbar-wrap` is the board's own chrome since OCL-35 split it in two
  // levels; `.topbar` is still the whole bar on every other screen. Both
  // carry menus, so both carry the rung.
  it.each([".nb .topbar", ".nb .topbar-wrap"])(
    "%s states the chrome rung outside every media query",
    (selector) => {
      const body = baseRule(selector);
      expect(body).not.toBeNull();
      expect(body).toMatch(/z-index:\s*var\(--oc-z-chrome\)/);
      // a z-index only counts on a positioned box
      expect(body).toMatch(/position:\s*(relative|sticky|fixed|absolute)/);
    },
  );

  it("hangs its menu and its panels on the rungs above the board", () => {
    // The avatar menu hangs off the global bar (navigation plan E1), which
    // itself sits on the menu rung so the board's chrome never covers it.
    for (const selector of [".global-bar", ".gb-menu", ".nb .bt-popover"]) {
      const body = baseRule(selector);
      expect(body, selector).not.toBeNull();
      expect(body, selector).toMatch(/z-index:\s*var\(--oc-z-menu\)/);
    }
  });
});
