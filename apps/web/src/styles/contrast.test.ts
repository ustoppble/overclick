import { describe, expect, it } from "vitest";
import { THEMES } from "../lib/theme";
import { inkOnFloor } from "./theme-colors";

/**
 * Every theme is readable (navigation plan E7).
 *
 * A theme switch changes values, never layout (`tokens.test.ts`), so the one
 * way a theme can break the board is a colour that cannot be read. The pairs
 * below are every token the component sheets paint text with, on every floor
 * a text sits on: the canvas, the card's surface, the floating panel and the
 * modal. Each pair is computed from the theme files themselves, translucent
 * inks composited over their floor first, and has to clear WCAG AA for body
 * text, 4.5:1. The archive's own pair (text-3 on a card) lives in
 * `archive-contrast.test.ts`; this guard holds the whole set, in all three
 * themes, so a theme added later inherits the rule instead of a review note.
 */

const AA = 4.5;

/** The inks a component sheet paints text with. */
const INKS = [
  "--oc-text-1",
  "--oc-text-2",
  "--oc-text-3",
  "--oc-mist",
  "--oc-mist-light",
  "--oc-accent",
  "--oc-ok",
  "--oc-danger",
  "--oc-info",
  "--oc-warn",
  "--oc-attention",
  "--oc-todo",
  "--oc-tag-bug-fg",
  "--oc-tag-rfc-fg",
  "--oc-tag-feature-fg",
  "--oc-badge-fg",
  "--oc-chip-review-fg",
] as const;

/** The floors a text sits on, from the canvas up. */
const FLOORS = ["--oc-bg", "--oc-surface-2", "--oc-panel-bg", "--oc-modal-bg"] as const;

/** Text that sits on a fill of its own, not on a floor. */
const ON_FILL = [
  ["--oc-accent-contrast", "--oc-accent"],
  ["--oc-btn-light-text", "--oc-btn-light-bg"],
] as const;

describe("every theme's text clears 4.5:1 on every floor", () => {
  for (const theme of THEMES) {
    for (const ink of INKS) {
      it(`${theme}: ${ink}`, () => {
        const below = FLOORS.map((floor) => ({
          floor,
          ratio: Number(inkOnFloor(theme, ink, floor).toFixed(2)),
        })).filter((pair) => pair.ratio < AA);
        expect(below, `${theme} ${ink} under ${AA}:1`).toEqual([]);
      });
    }

    for (const [ink, fill] of ON_FILL) {
      it(`${theme}: ${ink} on ${fill}`, () => {
        expect(inkOnFloor(theme, ink, fill)).toBeGreaterThanOrEqual(AA);
      });
    }
  }
});
