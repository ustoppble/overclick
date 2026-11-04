import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dict } from "../../lib/i18n";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("../../actions/missions", () => ({
  assignCardsToMissionAction: async () => ({ ok: true, previous: [] }),
  createMissionAction: async () => ({ ok: false, error: "x" }),
  restoreCardMissionsAction: async () => ({ ok: true }),
}));
vi.mock("../../actions/discard", () => ({
  discardCardsAction: async () => ({ ok: true, discarded: [], kept: [] }),
}));

const { DiscardConfirm, SelectionBar, SelectToggle, movableMissions } = await import(
  "./selection-bar"
);

const pt = dict("pt-BR");
const missions = [
  { id: "m1", title: "Login por código", status: "ativa" as const },
  { id: "m2", title: "Pausada", status: "pausada" as const },
  { id: "m3", title: "Encerrada", status: "concluida" as const },
];

const bar = (selected: string[], viewerRole: "admin" | "member" = "admin") =>
  renderToStaticMarkup(
    createElement(SelectionBar, {
      selected,
      shortIds: new Map([["a", "OCL-1"], ["b", "OCL-2"]]),
      missions,
      organizationId: null,
      viewerRole,
      onMoved: () => {},
      onDiscarded: () => {},
      onCancel: () => {},
      t: pt,
    }),
  );

/** Navigation plan E6 (F9): "Selecionar" always on the filter line, an explicit mode. */
describe("Selecionar (navigation plan E6)", () => {
  it("the Selecionar button exists with nothing selected", () => {
    const html = renderToStaticMarkup(
      createElement(SelectToggle, { on: false, onToggle: () => {}, t: pt }),
    );
    expect(html).toContain("Selecionar");
    expect(html).toContain('aria-pressed="false"');
    const on = renderToStaticMarkup(
      createElement(SelectToggle, { on: true, onToggle: () => {}, t: pt }),
    );
    expect(on).toContain("Selecionando");
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("Toque nos cards para marcar. Esc sai.");
  });

  it("with nothing picked the bar says so and its actions wait", () => {
    const html = bar([]);
    expect(html).toContain("Nenhum selecionado");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Mover para missão…/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Descartar</);
    expect(html).toContain("Cancelar");
  });

  it("reads N selecionados · Mover para missão… · Descartar · Cancelar, and never Validar", () => {
    const html = bar(["a", "b"]);
    expect(html).toContain("2 selecionados");
    expect(html).toContain("Mover para missão…");
    expect(html).toContain("Descartar");
    expect(html).toContain("Cancelar");
    expect(html).not.toMatch(/Validar|Validate/i);
    expect(bar(["a", "b"]).replace(/<[^>]+>/g, "|")).not.toMatch(/Validar/);
  });

  it("member: no Descartar on the bar — task_update would refuse it (needs can_manage)", () => {
    const html = bar(["a"], "member");
    expect(html).toContain("1 selecionado");
    expect(html).toContain("Mover para missão…");
    expect(html).not.toContain("Descartar");
    expect(html).not.toMatch(/Validar/);
  });

  it("the move menu offers the missions in progress, not the finished ones", () => {
    expect(movableMissions(missions).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("the discard confirmation shows the count and waits for a reason", () => {
    const html = renderToStaticMarkup(
      createElement(DiscardConfirm, {
        count: 2,
        reason: "",
        pending: false,
        error: null,
        onReason: () => {},
        onConfirm: () => {},
        onCancel: () => {},
        t: pt,
      }),
    );
    expect(html).toContain("Descartar 2 cards?");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Descartar 2 cards</);
    expect(html).toContain("obrigatório");
    expect(html).not.toMatch(/Desfazer/);
    const ready = renderToStaticMarkup(
      createElement(DiscardConfirm, {
        count: 2,
        reason: "escopo mudou",
        pending: false,
        error: null,
        onReason: () => {},
        onConfirm: () => {},
        onCancel: () => {},
        t: pt,
      }),
    );
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Descartar 2 cards</);
  });
});

describe("what a partial discard says about the cards that stayed", () => {
  it("keeps the first sentence of the tool's refusal, whole parentheses only", async () => {
    const { firstSentence } = await import("./selection-bar");
    expect(firstSentence("Card not found.")).toBe("Card not found.");
    expect(
      firstSentence(
        "AGB-4 is in execution and its claim is live (held by claude, last activity 2026-11-04T05:02:37.461Z). Release it first.",
      ),
    ).toBe("AGB-4 is in execution and its claim is live (held by claude, last activity 2026-11-04T05:02:37.461Z).");
    expect(firstSentence("Live claim (held by x. y) here. More.")).toBe("Live claim.");
  });
});
