import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardLoading } from "./board/board-loading";
import { BoardSkeleton } from "./board/board-skeleton";
import { DetailSkeleton } from "./board/detail-skeleton";
import InsightsLoading from "./usage/loading";
import { InsightsSkeleton } from "./usage/insights-skeleton";
import SettingsLoading from "./settings/[group]/loading";
import { SettingsSkeleton } from "./settings/settings-skeleton";

/**
 * Skeleton placeholders must never borrow status colours as decoration.
 * These are the exact status classes the design system uses; a skeleton that
 * carries any of them would flash green/yellow/red while loading.
 */
const STATUS_CLASSES = [
  "ok",
  "bug",
  "exec",
  "feito",
  "off",
  "type-bug",
  "d-status",
  "tag feature",
];

function render(Component: () => ReactElement): string {
  return renderToStaticMarkup(createElement(Component));
}

describe("skeleton components render a greyscale placeholder", () => {
  const cases: Array<{ name: string; Component: () => ReactElement }> = [
    { name: "BoardSkeleton", Component: BoardSkeleton },
    { name: "DetailSkeleton", Component: DetailSkeleton },
    { name: "InsightsSkeleton", Component: InsightsSkeleton },
    { name: "SettingsSkeleton", Component: SettingsSkeleton },
    { name: "BoardLoading", Component: BoardLoading },
    { name: "InsightsLoading", Component: InsightsLoading },
    { name: "SettingsLoading", Component: SettingsLoading },
  ];

  for (const { name, Component } of cases) {
    it(`${name} renders without crashing`, () => {
      const html = render(Component);
      expect(html.length).toBeGreaterThan(0);
      expect(html).toContain("sk");
    });

    it(`${name} carries the shimmer animation hook`, () => {
      const html = render(Component);
      expect(html).toContain("sk-shimmer");
    });

    it(`${name} does not use status colour classes`, () => {
      const html = render(Component);
      for (const cls of STATUS_CLASSES) {
        // Check class attribute segments to avoid matching unrelated text.
        const regex = new RegExp(`class=["'][^"']*\\b${cls}\\b`, "i");
        expect(regex.test(html)).toBe(false);
      }
    });
  }
});

describe("board skeleton anatomy", () => {
  it("renders five columns", () => {
    const html = render(BoardSkeleton);
    const columns = html.match(/class=["']sk-col["']/g) ?? [];
    expect(columns.length).toBe(5);
  });

  it("renders skeleton cards inside columns", () => {
    const html = render(BoardSkeleton);
    expect(html).toContain("sk-card");
    expect(html).toContain("sk-card-body");
  });
});

describe("detail skeleton anatomy", () => {
  it("renders contract and rail sections", () => {
    const html = render(DetailSkeleton);
    expect(html).toContain("sk-detail-main");
    expect(html).toContain("sk-detail-rail");
    expect(html).toContain("sk-detail-actions");
  });

  it("renders checklist placeholders", () => {
    const html = render(DetailSkeleton);
    const checks = html.match(/sk-check/g) ?? [];
    expect(checks.length).toBeGreaterThan(0);
  });
});

describe("insights skeleton anatomy", () => {
  it("renders tiles, charts and panels", () => {
    const html = render(InsightsSkeleton);
    expect(html).toContain("sk-ins-tiles");
    expect(html).toContain("sk-ins-charts");
    expect(html).toContain("sk-ins-grid");
  });
});

describe("settings skeleton anatomy", () => {
  it("renders tabs and form cards", () => {
    const html = render(SettingsSkeleton);
    expect(html).toContain("sk-settabs");
    expect(html).toContain("sk-set-card");
  });
});
