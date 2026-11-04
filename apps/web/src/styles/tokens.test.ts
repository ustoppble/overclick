import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS, LEGACY_LOCAL_TOKEN_SHEETS } from "./audited-sheets";
import { BASE_THEME, THEMES, type Theme } from "../lib/theme";

/**
 * The token contract, enforced (OCL-56).
 *
 * Three things have to stay true for a theme switch to be a switch and not a
 * redesign, and none of them survives review alone:
 *   1. no component rule carries a colour of its own (doctrine §5, item 1);
 *   2. every token a component asks for is declared by the base theme, or
 *      the switch would silently drop a colour;
 *   3. a theme file declares values and nothing else — no selector of its
 *      own beyond its theme, no property that moves a box (item 14).
 * The fourth is the snapshot at the end: what each theme actually resolves
 * to, so a value nobody meant to change cannot change quietly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");

const THEME_FILES: Record<Theme, string> = {
  nebula: read("themes/nebula.css"),
  xai: read("themes/xai.css"),
  overclock: read("themes/overclock.css"),
};

/** Comments hold examples and old values; only real CSS is under test. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function declaredTokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of stripComments(css).matchAll(/(--oc-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

function usedTokens(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripComments(css).matchAll(/var\(\s*(--oc-[a-z0-9-]+)/g)) {
    out.add(m[1]);
  }
  return out;
}

describe("component sheets carry no colour of their own", () => {
  for (const [name, css] of Object.entries(COMPONENT_SHEETS)) {
    if (LEGACY_LOCAL_TOKEN_SHEETS.has(name)) continue;
    it(`${name} has no hex or rgba() literal`, () => {
      const body = stripComments(css);
      expect(body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
      expect(body.match(/rgba\(/g) ?? []).toEqual([]);
      // rgb() survives only in the one form that composes a token:
      // rgb(var(--oc-…-rgb) / a). A literal triplet is a colour again.
      for (const call of body.match(/rgb\([^()]*(?:\([^()]*\)[^()]*)*\)/g) ?? []) {
        expect(call, `${name}: ${call}`).toMatch(/^rgb\(\s*var\(--oc-[a-z0-9-]+\)/);
      }
    });
  }
});

describe("every token a component asks for is declared", () => {
  const base = declaredTokens(THEME_FILES[BASE_THEME]);

  for (const [name, css] of Object.entries(COMPONENT_SHEETS)) {
    if (LEGACY_LOCAL_TOKEN_SHEETS.has(name)) continue;
    it(`${name} asks for nothing the base theme does not define`, () => {
      const missing = [...usedTokens(css)].filter((token) => !base.has(token));
      expect(missing).toEqual([]);
    });
  }

  it("the base theme's own references resolve inside itself", () => {
    const missing = [...usedTokens(THEME_FILES[BASE_THEME])].filter(
      (token) => !base.has(token),
    );
    expect(missing).toEqual([]);
  });

  for (const theme of THEMES) {
    it(`${theme} overrides names the contract knows`, () => {
      const unknown = [...declaredTokens(THEME_FILES[theme]).keys()].filter(
        (token) => !base.has(token),
      );
      expect(unknown).toEqual([]);
    });

    it(`${theme} references only tokens that exist`, () => {
      const own = declaredTokens(THEME_FILES[theme]);
      const missing = [...usedTokens(THEME_FILES[theme])].filter(
        (token) => !base.has(token) && !own.has(token),
      );
      expect(missing).toEqual([]);
    });
  }
});

describe("a theme file changes values, never layout", () => {
  /** Anything that could move, size or reflow a box. */
  const LAYOUT_PROPERTIES =
    /(^|[;{\s])(display|position|top|right|bottom|left|width|height|min-width|min-height|max-width|max-height|margin|padding|gap|flex|grid|float|inset|overflow|order|z-index|align-items|justify-content|white-space|transform)\s*:/;

  for (const theme of THEMES) {
    const css = stripComments(THEME_FILES[theme]);

    it(`${theme} declares nothing but --oc-* custom properties`, () => {
      const inside = css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
      const declarations = inside
        .split(";")
        .map((line) => line.trim())
        .filter(Boolean)
        // rgb(… / a) and gradients carry no colons at declaration level; a
        // declaration is anything before the first colon of a statement.
        .map((line) => line.split(":")[0].trim())
        .filter((name) => !name.includes("(") && !name.includes(")") && name.length > 0);
      const stray = declarations.filter((name) => !name.startsWith("--oc-"));
      expect(stray).toEqual([]);
    });

    it(`${theme} carries no layout property`, () => {
      expect(LAYOUT_PROPERTIES.test(css.replace(/--oc-[a-z0-9-]+\s*:/g, ""))).toBe(false);
    });

    it(`${theme} opens exactly one rule, and it is its own`, () => {
      const selectors = css
        .split("{")
        .slice(0, -1)
        .map((chunk) => chunk.split("}").pop()!.trim())
        .filter(Boolean);
      const expected =
        theme === BASE_THEME
          ? [`:root,\n[data-theme="${theme}"]`.replace(/\s+/g, " ")]
          : [`[data-theme="${theme}"]`];
      expect(selectors.map((s) => s.replace(/\s+/g, " "))).toEqual(expected);
    });
  }
});

describe("the base and the default are two answers (navigation plan E7)", () => {
  it(":root is the base theme, nebula, even though a newcomer opens on xai", () => {
    // The contract lives on :root so an unknown data-theme still draws with
    // every token declared; which theme a person *sees* first is decided by
    // DEFAULT_THEME in theme.ts and the boot script, not by this file.
    expect(BASE_THEME).toBe("nebula");
    expect(stripComments(THEME_FILES.nebula)).toMatch(/:root,\s*\[data-theme="nebula"\]\s*\{/);
    for (const theme of THEMES.filter((t) => t !== BASE_THEME)) {
      expect(stripComments(THEME_FILES[theme])).not.toMatch(/:root/);
    }
  });
});

describe("the token snapshot, per theme", () => {
  for (const theme of THEMES) {
    it(`${theme} resolves to the values it was reviewed with`, () => {
      expect(Object.fromEntries(declaredTokens(THEME_FILES[theme]))).toMatchSnapshot();
    });
  }
});
