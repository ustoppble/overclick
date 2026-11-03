import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict } from "../../lib/i18n";
import { PeriodFilter } from "./period-filter";

describe("period filter", () => {
  it("offers 7 days (selected), 14 days, 30 days and all time, and no 90 days", () => {
    const html = renderToStaticMarkup(
      createElement(PeriodFilter, { value: "7d", onChange: () => {}, t: dict("pt-BR") }),
    );
    const labels = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Últimos 7 dias", "14 dias", "30 dias", "Todo o período"]);
    expect(html).toContain('value="7d" selected');
    expect(html).not.toContain("90");
    expect(html).toContain('aria-label="Período"');
  });

  it("is in English too", () => {
    const html = renderToStaticMarkup(
      createElement(PeriodFilter, { value: "all", onChange: () => {}, t: dict("en") }),
    );
    expect(html).toContain("Last 7 days");
    expect(html).toContain("All time");
    expect(html).toContain('aria-label="Period"');
  });
});
