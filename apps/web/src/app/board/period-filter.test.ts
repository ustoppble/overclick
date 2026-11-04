import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dict } from "../../lib/i18n";
import { PeriodFilter } from "./period-filter";

const render = (props: Partial<Parameters<typeof PeriodFilter>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PeriodFilter, {
      value: "7d",
      by: "updated",
      onChange: vi.fn(),
      onByChange: vi.fn(),
      t: dict("pt-BR"),
      ...props,
    }),
  );

describe("the period, written out on the filter line (navigation plan E4)", () => {
  it("reads 'Mostrar: atualizados nos últimos 7 dias' and keeps the panel closed", () => {
    const html = render();
    expect(html).toContain('class="period-trigger oc-tappable"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Mostrar:</span>");
    expect(html).toContain("atualizados nos últimos 7 dias");
    expect(html).toContain("<svg");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('role="listbox"');
  });

  it("writes a period out of the default in full, with the date it reads", () => {
    expect(render({ value: "30d", by: "created" })).toContain("criados nos últimos 30 dias");
    expect(render({ value: "all", t: dict("en") })).toContain("updated at any time");
    expect(render({ value: "all", t: dict("en") })).toContain(">Show:</span>");
  });

  it("holds the period and the date it reads in one panel: no second control for the date", () => {
    const html = render({ defaultOpen: true });
    expect(html.match(/role="listbox"/g)).toHaveLength(2);
    expect(html.match(/role="option"/g)).toHaveLength(6);
    expect(html).toContain(">Período</h3>");
    expect(html).toContain(">Data do período</h3>");
    expect(html).not.toContain("period-by-filter");
  });
});
