import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict } from "../../lib/i18n";
import { parseRules } from "../../styles/css-rules";
import { MissionProgressBar } from "./mission-progress-bar";

const here = dirname(fileURLToPath(import.meta.url));
const nebula = readFileSync(join(here, "../../styles/nebula.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function bodyOf(selector: string): string {
  return parseRules(nebula)
    .filter((rule) => rule.selector.split(",").map((s) => s.trim()).includes(selector))
    .map((rule) => rule.body)
    .join(";");
}

describe("mission progress bar (OCL-138, variant A in E3)", () => {
  it("fills validated, to review and running, in that order; the queue is the track", () => {
    const html = renderToStaticMarkup(
      createElement(MissionProgressBar, {
        counts: { aberto: 3, em_execucao: 2, feito: 4, validado: 1 },
        t: dict("en"),
      }),
    );

    const order = ["seg-validado", "seg-feito", "seg-em-execucao"].map((name) =>
      html.indexOf(name),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("seg-aberto");
    expect(html).toContain("50% delivered");
    // Colour alone never carries the meaning: the numbers are in the
    // accessible name too, not only in segment widths.
    expect(html).toContain("3 queued");
    expect(html).toContain("2 in progress");
    expect(html).toContain("4 to review");
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

    expect(html).not.toContain("mission-progress-seg");
    expect(html).toContain("0% delivered");
  });

  it("the large bar carries a legend with the status marks, localized", () => {
    const html = renderToStaticMarkup(
      createElement(MissionProgressBar, {
        counts: { aberto: 4, em_execucao: 2, feito: 2, validado: 1 },
        t: dict("pt-BR"),
        size: "lg",
      }),
    );

    expect(html).toContain('class="mission-progress-legend"');
    for (const status of ["validado", "feito", "em_execucao", "aberto"]) {
      expect(html).toContain(`data-status="${status}"`);
    }
    expect(html).toContain("validado");
    expect(html).toContain("para revisar");
    expect(html).toContain("em execução");
    expect(html).toContain("na fila");
    expect(html).toContain("33% entregue");
  });

  it("is grey (variant A): the first, second and third ink on a 10% track, no status colour", () => {
    expect(bodyOf(".nb .mission-progress-seg.seg-validado")).toContain("var(--oc-text-1)");
    expect(bodyOf(".nb .mission-progress-seg.seg-feito")).toContain("var(--oc-text-2)");
    expect(bodyOf(".nb .mission-progress-seg.seg-em-execucao")).toContain("var(--oc-text-3)");
    expect(bodyOf(".nb .mission-progress-bar")).toMatch(/\/\s*0?\.1\)/);
    const all = parseRules(nebula)
      .filter((rule) => rule.selector.includes("mission-progress"))
      .map((rule) => rule.body)
      .join(";");
    expect(all).not.toMatch(/--oc-(warn|ok|info|todo|attention)/);
  });
});
