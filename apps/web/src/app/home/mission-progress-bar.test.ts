import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict } from "../../lib/i18n";
import { MissionProgressBar } from "./mission-progress-bar";

describe("mission progress bar (OCL-138)", () => {
  it("renders one segment per non-zero status, plus the % as text", () => {
    const html = renderToStaticMarkup(
      createElement(MissionProgressBar, {
        counts: { aberto: 3, em_execucao: 2, feito: 4, validado: 1 },
        t: dict("en"),
      }),
    );

    expect(html).toContain("seg-aberto");
    expect(html).toContain("seg-em-execucao");
    expect(html).toContain("seg-feito");
    expect(html).toContain("seg-validado");
    expect(html).toContain("50%");
    // colour alone never carries the meaning: the numbers are in the
    // accessible name too, not only in segment widths.
    expect(html).toContain("3 open");
    expect(html).toContain("2 in progress");
    expect(html).toContain("4 done");
    expect(html).toContain("1 validated");
  });

  it("skips zero-count segments instead of rendering an empty sliver", () => {
    const html = renderToStaticMarkup(
      createElement(MissionProgressBar, {
        counts: { aberto: 0, em_execucao: 0, feito: 1, validado: 0 },
        t: dict("en"),
      }),
    );

    expect(html).toContain("seg-feito");
    expect(html).not.toContain("seg-aberto");
    expect(html).not.toContain("seg-em-execucao");
    expect(html).not.toContain("seg-validado");
  });

  it("renders an empty track, not a crash, when the mission holds no cards", () => {
    const html = renderToStaticMarkup(
      createElement(MissionProgressBar, {
        counts: { aberto: 0, em_execucao: 0, feito: 0, validado: 0 },
        t: dict("en"),
      }),
    );

    expect(html).toContain("seg-empty");
    expect(html).toContain("0%");
  });

  it("localizes the legend in pt-BR to match the requested wording", () => {
    const html = renderToStaticMarkup(
      createElement(MissionProgressBar, {
        counts: { aberto: 3, em_execucao: 2, feito: 5, validado: 1 },
        t: dict("pt-BR"),
      }),
    );

    expect(html).toContain("3 abertos");
    expect(html).toContain("2 fazendo");
    expect(html).toContain("5 prontos");
    expect(html).toContain("1 validado");
    expect(html).toContain("concluído");
  });
});
