import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dict } from "../../lib/i18n";
import { OlderButton } from "./older-button";

function render(
  props: Partial<Parameters<typeof OlderButton>[0]> & { lang?: "en" | "pt-BR" } = {},
) {
  const { lang = "pt-BR", ...rest } = props;
  return renderToStaticMarkup(
    createElement(OlderButton, {
      left: 1659,
      pageSize: 50,
      loading: false,
      disabled: false,
      onClick: vi.fn(),
      t: dict(lang),
      ...rest,
    }),
  );
}

describe("the show-older button", () => {
  it("carries the number of older cards inside itself, short and in the reader's number format", () => {
    expect(render()).toContain(">+1.659 antigos</span>");
    expect(render({ lang: "en" })).toContain(">+1,659 older</span>");
  });

  it("keeps the page it will bring in its tooltip and its accessible name", () => {
    const html = render();
    expect(html).toContain('title="Ver mais antigos (mais 50)"');
    expect(html).toContain('aria-label="Ver mais antigos (mais 50) — +1.659 antigos"');
  });

  it("says how many it brings when fewer than a page are left", () => {
    expect(render({ left: 46 })).toContain('title="Ver mais antigos (mais 46)"');
  });

  it("reads Loading in the same box while a page is on its way", () => {
    const html = render({ loading: true, disabled: true });
    expect(html).toContain(">Carregando…</span>");
    expect(html).not.toContain("antigos</span>");
    expect(html).toContain("disabled");
  });

  it("is the same one-line control whatever the number", () => {
    for (const left of [1, 50, 1659, 12345]) {
      const html = render({ left });
      expect(html).toContain('class="btn-ghost col-more"');
      expect(html.match(/<span/g)).toHaveLength(1);
    }
  });
});
