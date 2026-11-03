import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict } from "../../lib/i18n";
import { PeriodFilter } from "./period-filter";

describe("period filter", () => {
  it("is a menu trigger that shows the picked period and keeps the list closed", () => {
    const html = renderToStaticMarkup(
      createElement(PeriodFilter, { value: "7d", onChange: () => {}, t: dict("pt-BR") }),
    );
    expect(html).toContain('class="period-trigger oc-tappable"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Período"');
    expect(html).toContain("Últimos 7 dias");
    // a chevron like the project and mission triggers, and no native select
    expect(html).toContain("<svg");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("role=\"listbox\"");
  });

  it("labels the trigger with the picked period, in English too", () => {
    const html = renderToStaticMarkup(
      createElement(PeriodFilter, { value: "all", onChange: () => {}, t: dict("en") }),
    );
    expect(html).toContain("All time");
    expect(html).not.toContain("Last 7 days");
    expect(html).toContain('aria-label="Period"');
  });
});
