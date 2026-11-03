import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Board, type BoardCard } from "./board";

function card(id: string, status: BoardCard["status"]): BoardCard {
  return {
    id,
    organizationId: "o1",
    shortId: `OCL-${id}`,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    title: `Card ${id}`,
    tipo: "feature",
    priority: "media",
    status,
    supersedes: null,
    supersededBy: null,
    isExample: false,
    projectId: "p1",
    projectName: "OverClick",
    missionId: null,
    mission: null,
    ranCli: null,
    executors: [],
    harnessChain: null,
    modelSource: null,
    awaitingMyReview: false,
    devolve: "queue",
    executor: null,
    elapsed: null,
    claimInactive: null,
    claimStale: false,
    resolvedIn: null,
    telemetryLine: [],
  };
}

const cards = [
  card("1", "aberto"),
  card("2", "aberto"),
  card("3", "em_execucao"),
  card("4", "feito"),
  card("5", "validado"),
];

function render(lang: "en" | "pt-BR") {
  return renderToStaticMarkup(
    createElement(Board, { cards, lang, missions: [] }),
  );
}

describe("the board's columns", () => {
  it("never offers older cards: the period alone decides what a column holds", () => {
    for (const lang of ["en", "pt-BR"] as const) {
      const html = render(lang);
      // Neither the desktop columns nor the phone list (board-mobile).
      expect(html).toContain('class="board-mobile"');
      expect(html).not.toContain("col-more");
      expect(html).not.toMatch(/antigos|older|Ver mais|Show older/i);
    }
  });

  it("heads each column with the cards it shows", () => {
    const html = render("en");
    expect(html).toMatch(/Open<\/span><span class="count">2<\/span>/);
    expect(html).toMatch(/Validated<\/span><span class="count">1<\/span>/);
  });
});
