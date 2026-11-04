import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS } from "./audited-sheets";
import { parseDeclarations, parseRules, splitSelectorList } from "./css-rules";
import { DEFAULT_THEME, type Theme } from "../lib/theme";

/**
 * The archive is quieter by ink, never by fade (E0, A3).
 *
 * `.card.dim { opacity: .6 }` multiplied text that was already translucent:
 * the id and the meta of a validated card fell to 2.2:1, and the phone row at
 * .55 to 2.0:1. A fade over readable text is the bug itself, so no `.dim`
 * rule may declare one; the archive steps down the ink ladder instead, and
 * the bottom of that ladder has to pass on the floors a card sits on.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");

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

type Rgba = [number, number, number, number];

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

/** A theme is its own values over the base theme's, as the cascade does it. */
function themeTokens(theme: Theme): Map<string, string> {
  const base = declaredTokens(read(`themes/${DEFAULT_THEME}.css`));
  if (theme === DEFAULT_THEME) return base;
  return new Map([...base, ...declaredTokens(read(`themes/${theme}.css`))]);
}

function resolve(tokens: Map<string, string>, value: string): Rgba {
  const v = value.trim();
  const ref = /^var\((--oc-[a-z0-9-]+)\)$/.exec(v);
  if (ref) return resolve(tokens, tokens.get(ref[1]) ?? "");
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\(\s*(?:var\((--oc-[a-z0-9-]+)\)|(\d+ \d+ \d+))\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v);
  if (rgb) {
    const triplet = rgb[1] ? tokens.get(rgb[1]) ?? "" : rgb[2];
    const [r, g, b] = triplet.split(/\s+/).map(Number);
    return [r, g, b, rgb[3] ? Number(rgb[3]) : 1];
  }
  throw new Error(`cannot resolve ${value}`);
}

/** Paint a translucent colour over an opaque one. */
function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("text-3 passes AA on the floors a card sits on", () => {
  for (const theme of ["xai", "nebula"] as const) {
    const tokens = themeTokens(theme);
    const bg = resolve(tokens, "var(--oc-bg)");
    const surface = over(resolve(tokens, "var(--oc-surface-2)"), bg);
    const text3 = resolve(tokens, "var(--oc-text-3)");

    it(`${theme}: text-3 on the canvas is at least 4.5:1`, () => {
      expect(contrast(over(text3, bg), bg)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: text-3 on surface-2 is at least 4.5:1`, () => {
      expect(contrast(over(text3, surface), surface)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
