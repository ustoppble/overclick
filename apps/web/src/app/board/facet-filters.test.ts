import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TASK_PRIORITIES, TASK_TYPES } from "../../lib/board-filter";
import { dict } from "../../lib/i18n";
import { FacetMenu, MoreFilters, toggleFacet } from "./facet-filters";

describe("facet menus", () => {
  it("adds and removes choices while preserving the canonical order", () => {
    const order = ["bug", "feature", "rfc"] as const;
    expect(toggleFacet(["rfc"], "bug", order)).toEqual(["bug", "rfc"]);
    expect(toggleFacet(["bug", "rfc"], "bug", order)).toEqual(["rfc"]);
  });

  it("keeps the priorities in their own order", () => {
    const priorities = ["urgente", "alta", "media", "baixa"] as const;
    expect(toggleFacet(["alta"], "urgente", priorities)).toEqual(["urgente", "alta"]);
  });

  it("gives type and priority a trigger each, counted, with the checkboxes behind it (E4)", () => {
    const t = dict("pt-BR");
    const types = renderToStaticMarkup(
      createElement(FacetMenu, {
        kind: "type",
        label: t.board.typeFilter,
        choices: TASK_TYPES,
        names: { bug: "bug", feature: "feature", rfc: "rfc" },
        value: ["feature", "rfc"],
        onChange: vi.fn(),
        defaultOpen: true,
      }),
    );
    expect(types).toMatch(/class="type-trigger on"/);
    expect(types).toContain(">Tipo</span>");
    expect(types).toContain('class="badge">2</span>');
    expect(types.match(/type="checkbox"/g)).toHaveLength(3);

    const priorities = renderToStaticMarkup(
      createElement(FacetMenu, {
        kind: "priority",
        label: t.board.priorityFilter,
        choices: TASK_PRIORITIES,
        names: { urgente: "urgente", alta: "alta", media: "média", baixa: "baixa" },
        value: [],
        onChange: vi.fn(),
      }),
    );
    expect(priorities).toMatch(/class="priority-trigger"/);
    expect(priorities).not.toContain("badge");
    expect(priorities).not.toContain('type="checkbox"');
  });

  it("leaves the release in More, and the search out of the line: it is in the global bar", () => {
    const html = renderToStaticMarkup(
      createElement(MoreFilters, {
        releases: [
          { value: "v1.2.0", count: 2 },
          { value: null, count: 3 },
        ],
        resolvedIn: "v1.2.0",
        onReleaseChange: vi.fn(),
        defaultOpen: true,
        t: dict("pt-BR"),
      }),
    );
    expect(html).toContain(">Mais</span>");
    expect(html).toContain('class="filter-chip ff-trigger on"');
    expect(html).toContain(">Release</h3>");
    expect(html).toContain("Sem release");
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('type="search"');
    expect(html).not.toContain('type="checkbox"');
  });
});
