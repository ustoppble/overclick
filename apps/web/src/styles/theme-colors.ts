import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_THEME, type Theme } from "../lib/theme";

/**
 * A theme's colours as the cascade resolves them, for the guards that do
 * arithmetic on them (`contrast.test.ts`, `archive-contrast.test.ts`).
 *
 * A theme is its own values over the base theme's: `:root` declares the
 * whole contract and a theme file overrides part of it. A value resolves
 * through `var()` chains and `rgb(var(--…-rgb) / a)` tints down to an RGBA
 * quadruple; a translucent colour is then painted over the floor it sits on,
 * the way the browser does it, before any ratio is taken.
 */

export type Rgba = [number, number, number, number];

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

export function declaredTokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of stripComments(css).matchAll(/(--oc-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

export function themeTokens(theme: Theme): Map<string, string> {
  const base = declaredTokens(read(`themes/${BASE_THEME}.css`));
  if (theme === BASE_THEME) return base;
  return new Map([...base, ...declaredTokens(read(`themes/${theme}.css`))]);
}

/** `0 0 0` or `var(--oc-ok-rgb)` down to three numbers. */
function triplet(tokens: Map<string, string>, value: string): [number, number, number] {
  const ref = /^var\((--oc-[a-z0-9-]+)\)$/.exec(value.trim());
  if (ref) return triplet(tokens, tokens.get(ref[1]) ?? "");
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`not an RGB triplet: ${value}`);
  }
  return [parts[0], parts[1], parts[2]];
}

export function resolve(tokens: Map<string, string>, value: string): Rgba {
  const v = value.trim();
  const ref = /^var\((--oc-[a-z0-9-]+)\)$/.exec(v);
  if (ref) {
    const next = tokens.get(ref[1]);
    if (next == null) throw new Error(`undeclared token ${ref[1]}`);
    return resolve(tokens, next);
  }
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\(\s*(var\(--oc-[a-z0-9-]+\)|\d+ \d+ \d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v);
  if (rgb) {
    const [r, g, b] = triplet(tokens, rgb[1]);
    return [r, g, b, rgb[2] ? Number(rgb[2]) : 1];
  }
  throw new Error(`cannot resolve ${value}`);
}

/** Paint a translucent colour over an opaque one. */
export function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio of two opaque colours. */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The ratio of a (possibly translucent) ink on a floor token over the canvas. */
export function inkOnFloor(theme: Theme, ink: string, floor: string): number {
  const tokens = themeTokens(theme);
  const canvas = resolve(tokens, "var(--oc-bg)");
  const ground = floor === "--oc-bg" ? canvas : over(resolve(tokens, `var(${floor})`), canvas);
  return contrast(over(resolve(tokens, `var(${ink})`), ground), ground);
}
