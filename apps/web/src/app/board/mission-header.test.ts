import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict } from "../../lib/i18n";
import type { BoardMissionOption } from "./board";
import { MissionOverview } from "./mission-header";

describe("selected mission header", () => {
  it("renders title, status, objective, collapsible markdown context and card counts", () => {
    const mission: BoardMissionOption = {
      id: "mission-1",
      title: "Design north",
      status: "ativa",
      objective: "Keep the **board** legible.",
      context: "## Round rule\n\n- Check narrow screens",
      counts: {
        total: 10,
        aberto: 4,
        em_execucao: 3,
        feito: 2,
        validado: 1,
      },
    };

    const html = renderToStaticMarkup(
      createElement(MissionOverview, { mission, t: dict("en") }),
    );

    expect(html).toContain("Design north");
    expect(html).toContain("active");
    expect(html).toContain('<strong class="md-strong">board</strong>');
    expect(html).toContain("<details");
    expect(html).toContain("Round rule");
    expect(html).toContain("Check narrow screens");
    expect(html).toContain("<b>4</b>");
    expect(html).toContain("<b>1</b>");
  });
});
