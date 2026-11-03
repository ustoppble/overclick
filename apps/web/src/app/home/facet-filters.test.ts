import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dict } from "../../lib/i18n";
import { FacetFilters, toggleFacet } from "./facet-filters";

describe("facet filter menu", () => {
  it("adds and removes choices while preserving the canonical order", () => {
    const order = ["bug", "feature", "rfc"] as const;
    expect(toggleFacet(["rfc"], "bug", order)).toEqual(["bug", "rfc"]);
    expect(toggleFacet(["bug", "rfc"], "bug", order)).toEqual(["rfc"]);
  });

  it("keeps selections independent between the two menu sections", () => {
    const priorities = ["urgente", "alta", "media", "baixa"] as const;
    expect(toggleFacet(["alta"], "urgente", priorities)).toEqual([
      "urgente",
      "alta",
    ]);
  });

  it("renders one counted trigger and seven vertical checkbox options", () => {
    const html = renderToStaticMarkup(
      createElement(FacetFilters, {
        types: ["bug"],
        priorities: ["urgente"],
        releases: [
          { value: "v1.2.0", count: 2 },
          { value: null, count: 3 },
        ],
        resolvedIn: "v1.2.0",
        onTypesChange: vi.fn(),
        onPrioritiesChange: vi.fn(),
        onReleaseChange: vi.fn(),
        onClear: vi.fn(),
        query: "",
        onQueryChange: vi.fn(),
        defaultOpen: true,
        t: dict("en"),
      }),
    );

    expect(html).toContain(">Filters</span>");
    expect(html).toContain('class="badge">3</span>');
    expect(html).toContain(">Type</h3>");
    expect(html).toContain(">Priority</h3>");
    expect(html).toContain(">Release</h3>");
    expect(html).toContain("v1.2.0");
    expect(html).toContain("No release");
    expect(html.match(/type="checkbox"/g)).toHaveLength(7);
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain("facet-chip");
  });

  it("keeps the board search inside Filters and exposes the active term", () => {
    const html = renderToStaticMarkup(
      createElement(FacetFilters, {
        types: [],
        priorities: [],
        releases: [],
        resolvedIn: undefined,
        onTypesChange: vi.fn(),
        onPrioritiesChange: vi.fn(),
        onReleaseChange: vi.fn(),
        onClear: vi.fn(),
        query: "OCL-72",
        onQueryChange: vi.fn(),
        defaultOpen: true,
        t: dict("en"),
      }),
    );

    expect(html).toContain('type="search"');
    expect(html).toContain('value="OCL-72"');
    expect(html).toContain('class="badge ff-query-badge"');
    expect(html).toContain("Clear board search");
  });

  it("names itself differently inside the phone's filters sheet, where the bar button already says Filters", () => {
    const render = (lang: "en" | "pt-BR") =>
      renderToStaticMarkup(
        createElement(FacetFilters, {
          types: [],
          priorities: [],
          releases: [],
          resolvedIn: undefined,
          onTypesChange: vi.fn(),
          onPrioritiesChange: vi.fn(),
          onReleaseChange: vi.fn(),
          onClear: vi.fn(),
          query: "",
          onQueryChange: vi.fn(),
          t: dict(lang),
        }),
      );
    expect(render("en")).toContain('<span class="ff-label-bar">Filters</span>');
    expect(render("en")).toContain('<span class="ff-label-sheet">More filters</span>');
    expect(render("pt-BR")).toContain('<span class="ff-label-bar">Filtros</span>');
    expect(render("pt-BR")).toContain('<span class="ff-label-sheet">Mais filtros</span>');
  });
});
