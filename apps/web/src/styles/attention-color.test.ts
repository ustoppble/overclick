import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPONENT_SHEETS } from "./audited-sheets";
import { parseRules, splitSelectorList } from "./css-rules";
import { DEFAULT_THEME, THEMES, type Theme } from "../lib/theme";

/**
 * Variant A, "one colour only" (navigation plan, E1 §7): everything is grey
 * and the one colour is the attention amber, which only appears where
 * something waits for the person. It lives in its own token pair,
 * `--oc-attention` / `--oc-attention-rgb`, so the eight places that already
 * paint with `--oc-warn` keep their xai white and the amber cannot spread by
 * a theme edit.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The closed list (design README §3): nothing else may ask for the amber. */
const ATTENTION_SELECTORS = [
  // 1. the number on the "N to review" chip, and the phone's Review badge
  ".global-bar .gb-chip-review.attention .gb-n",
  ".gb-tabbar .gb-tab-badge.attention",
  // 2. the To review column counter, on the desktop and on the phone list,
  //    and the review list's title, which is the same counter
  ".nb .col-head .count.attention",
  ".nb .ml-head .count.attention",
  ".rq-title .rq-n.attention",
  // 3. "no signal for N min" on a running card
  ".nb .telemetry.no-signal",
].sort();

/**
 * What painted with the warn family when E1 started. These keep the theme's
 * warn (white on xai); a new rule has to take the attention token, and only
 * from the closed list above.
 */
const WARN_SELECTORS_BEFORE_E1 = [
  ".nb .mission-status.pausada",
  ".nb .mission-progress-seg.seg-em-execucao",
  ".nb .review-chip",
  ".nb .d-status.feito",
  ".nb .price-alert",
  ".nb .price-alert .sec-cap",
  ".nb .policy .act small.price-flag",
  ".nb .pip",
  ".nb .policy .chain .sel.orphan",
  ".nb .cover-list li.missing",
  ".nb .cover-list li.missing .cover-state",
  ".nb .ml-flag",
].sort();

function selectorsUsing(pattern: RegExp): string[] {
  const out = new Set<string>();
  for (const css of Object.values(COMPONENT_SHEETS)) {
    for (const rule of parseRules(strip(css))) {
      if (!pattern.test(rule.body)) continue;
      for (const selector of splitSelectorList(rule.selector)) out.add(selector.trim());
    }
  }
  return [...out].sort();
}

describe("the attention amber is spent only where something waits for you", () => {
  it("only the closed list's selectors use --oc-attention", () => {
    expect(selectorsUsing(/--oc-attention\b/)).toEqual(ATTENTION_SELECTORS);
  });

  it("no new rule paints with --oc-warn: only the ones that did before E1", () => {
    // Fewer is fine (a later stage may delete one); a new one is not.
    const added = selectorsUsing(/--oc-(warn|chip-review|glow-pip)/).filter(
      (selector) => !WARN_SELECTORS_BEFORE_E1.includes(selector),
    );
    expect(added).toEqual([]);
  });

  it("the global bar sheet is one of the audited sheets", () => {
    expect(Object.keys(COMPONENT_SHEETS)).toContain("styles/global-bar.css");
  });
});

// ---------- contrast, computed from the themes themselves ----------

type Rgba = [number, number, number, number];

const THEME_FILES: Record<Theme, string> = {
  nebula: read("themes/nebula.css"),
  xai: read("themes/xai.css"),
  overclock: read("themes/overclock.css"),
};

function tokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of strip(css).matchAll(/(--oc-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

function resolver(theme: Theme) {
  const base = tokens(THEME_FILES[DEFAULT_THEME]);
  const own = tokens(THEME_FILES[theme]);
  const raw = (name: string) => own.get(name) ?? base.get(name);
  const resolve = (value: string, depth = 0): string => {
    if (depth > 12) throw new Error(`token cycle at ${value}`);
    return value.replace(/var\((--oc-[a-z0-9-]+)\)/g, (_, name: string) => {
      const found = raw(name);
      if (found === undefined) throw new Error(`${theme}: ${name} is not declared`);
      return resolve(found, depth + 1);
    });
  };
  return (name: string) => resolve(raw(name) ?? "");
}

function parseColour(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = value.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1];
  throw new Error(`not a colour this test reads: ${value}`);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the attention token, per theme", () => {
  it("xai takes the approved amber #d9ae63", () => {
    const value = resolver("xai");
    expect(value("--oc-attention")).toBe("#d9ae63");
    expect(value("--oc-attention-rgb")).toBe("217 174 99");
  });

  it("xai still keeps warn white, so the eight old places stay grey", () => {
    expect(resolver("xai")("--oc-warn-rgb")).toBe("255 255 255");
  });

  for (const theme of THEMES) {
    it(`${theme}: the pair names the same colour`, () => {
      const value = resolver(theme);
      const [r, g, b] = parseColour(value("--oc-attention"));
      expect(value("--oc-attention-rgb")).toBe(`${r} ${g} ${b}`);
    });

    it(`${theme}: the amber reads at 4.5:1 or more on the canvas, the card and the hover`, () => {
      const value = resolver(theme);
      const canvas = parseColour(value("--oc-bg"));
      const amber = parseColour(value("--oc-attention"));
      for (const surface of ["--oc-bg", "--oc-surface-2", "--oc-surface-3"]) {
        const behind = over(parseColour(value(surface)), canvas);
        const ratio = contrast(over(amber, behind), behind);
        expect(ratio, `${theme} ${surface}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
