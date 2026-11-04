import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dict } from "./i18n";

/**
 * The navigation plan's vocabulary (E1 §6). Labels only: the statuses on the
 * wire stay aberto / em_execucao / feito / validado / descartado.
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "i18n.ts"), "utf8");

/** Every string a dictionary can put on screen, functions called with stand-ins. */
function screenStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function") {
    for (const args of [[1], [2], [["a@b.c"]], [{ aberto: 1, em_execucao: 1, feito: 1, validado: 1 }]]) {
      try {
        const result = (value as (...a: unknown[]) => unknown)(...args);
        if (typeof result === "string") out.push(result);
      } catch {
        /* a stand-in it does not take */
      }
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) screenStrings(item, out);
  }
  return out;
}

describe("the columns' names", () => {
  it("read Fila · Em execução · Para revisar · Validado · Descartado in pt-BR", () => {
    const b = dict("pt-BR").board;
    expect([b.colOpen, b.colInProgress, b.colDone, b.colValidated, b.colDiscarded]).toEqual([
      "Fila",
      "Em execução",
      "Para revisar",
      "Validado",
      "Descartado",
    ]);
  });

  it("read Queue · In progress · To review · Validated · Discarded in English", () => {
    const b = dict("en").board;
    expect([b.colOpen, b.colInProgress, b.colDone, b.colValidated, b.colDiscarded]).toEqual([
      "Queue",
      "In progress",
      "To review",
      "Validated",
      "Discarded",
    ]);
  });

  it("are the same words in a mission's summary", () => {
    const counts = { aberto: 3, em_execucao: 2, feito: 4, validado: 1 };
    expect(dict("pt-BR").board.missionProgressSummary(counts)).toBe(
      "3 na fila · 2 em execução · 4 para revisar · 1 validado",
    );
    expect(dict("en").board.missionProgressSummary(counts)).toBe(
      "3 queued · 2 in progress · 4 to review · 1 validated",
    );
  });

  it("never call the review a queue (F7)", () => {
    for (const lang of ["en", "pt-BR"]) {
      const b = dict(lang).board;
      expect(`${b.colDone} ${b.statusDone}`).not.toMatch(/fila|queue/i);
    }
  });
});

describe("the empty queue asks the agent, not the person", () => {
  it("no longer says Crie um card / Create a card", () => {
    expect(source).not.toContain("Crie um card");
    expect(source).not.toContain("Create a card");
    expect(dict("pt-BR").board.emptyOpenBefore).toBe("Nada na fila. Peça ao seu agente: ");
    expect(dict("en").board.emptyOpenBefore).toBe("Nothing queued. Ask your agent: ");
  });
});

describe("Insights is Consumo (Usage) on every screen", () => {
  for (const lang of ["en", "pt-BR"]) {
    it(`no screen string in ${lang} says Insights`, () => {
      const hits = screenStrings(dict(lang)).filter((text) => /insights/i.test(text));
      expect(hits).toEqual([]);
    });
  }

  it("pt-BR says membros, not members", () => {
    const hits = screenStrings(dict("pt-BR")).filter((text) => /\bmembers\b/.test(text));
    expect(hits).toEqual([]);
  });
});
