import { describe, expect, it } from "vitest";
import {
  applyTransition,
  CARD_STATUSES,
  listValidEvents,
  type CardEvent,
  type CardSnapshot,
} from "../src/index.js";

function card(
  overrides: Partial<CardSnapshot> = {},
): CardSnapshot {
  return {
    status: "aberto",
    revisado: false,
    reopen_comment: null,
    ...overrides,
  };
}

describe("card state machine", () => {
  it("exposes the workflow statuses including discarded", () => {
    expect(CARD_STATUSES).toEqual([
      "aberto",
      "em_execucao",
      "feito",
      "validado",
      "descartado",
    ]);
  });

  it("allows aberto → em execução via claim", () => {
    const result = applyTransition(card(), { type: "claim" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("em_execucao");
      expect(result.value.revisado).toBe(false);
    }
  });

  it("keeps the reopen comment on claim so the next executor sees it", () => {
    const result = applyTransition(
      card({ reopen_comment: "faltou o teste do login" }),
      { type: "claim" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reopen_comment).toBe("faltou o teste do login");
    }
  });

  it("allows em execução → feito via handoff and clears the reopen comment", () => {
    const result = applyTransition(card({ status: "em_execucao" }), {
      type: "handoff",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("feito");
      expect(result.value.revisado).toBe(false);
      expect(result.value.reopen_comment).toBeNull();
    }
  });

  it("allows feito → validado via human validate", () => {
    const result = applyTransition(card({ status: "feito" }), {
      type: "validate",
      actor: "human",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("validado");
    }
  });

  it("allows validate after the optional revisado mark", () => {
    const result = applyTransition(
      card({ status: "feito", revisado: true }),
      { type: "validate", actor: "human" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("validado");
      expect(result.value.revisado).toBe(true);
    }
  });

  it("allows feito → aberto via reopen with a comment", () => {
    const result = applyTransition(card({ status: "feito", revisado: true }), {
      type: "reopen",
      comment: "o roteiro de confirmação falhou no passo 2",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("aberto");
      expect(result.value.revisado).toBe(false);
      expect(result.value.reopen_comment).toBe(
        "o roteiro de confirmação falhou no passo 2",
      );
    }
  });

  it("rejects reopen without a comment", () => {
    const result = applyTransition(card({ status: "feito" }), {
      type: "reopen",
      comment: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REOPEN_COMMENT_REQUIRED");
    }
  });

  it("rejects reopen with a whitespace-only comment", () => {
    const result = applyTransition(card({ status: "feito" }), {
      type: "reopen",
      comment: "   \n\t  ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REOPEN_COMMENT_REQUIRED");
    }
  });

  it("marks revisado on feito without changing status", () => {
    const result = applyTransition(card({ status: "feito" }), {
      type: "mark_revisado",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("feito");
      expect(result.value.revisado).toBe(true);
    }
  });

  it("treats revisado as an optional mark, not a fifth status", () => {
    const marked = applyTransition(card({ status: "feito" }), {
      type: "mark_revisado",
    });
    expect(marked.ok).toBe(true);
    if (marked.ok) {
      expect(CARD_STATUSES).not.toContain("revisado");
      expect(marked.value.status).toBe("feito");
    }
  });

  it("is idempotent when marking revisado twice", () => {
    const once = applyTransition(card({ status: "feito" }), {
      type: "mark_revisado",
    });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = applyTransition(once.value, { type: "mark_revisado" });
    expect(twice.ok).toBe(true);
    if (twice.ok) {
      expect(twice.value.revisado).toBe(true);
      expect(twice.value.status).toBe("feito");
    }
  });

  it("rejects mark_revisado unless the card is feito", () => {
    for (const status of ["aberto", "em_execucao", "validado"] as const) {
      const result = applyTransition(card({ status }), {
        type: "mark_revisado",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_TRANSITION");
      }
    }
  });

  it("rejects claim from em execução without force", () => {
    const result = applyTransition(card({ status: "em_execucao" }), {
      type: "claim",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ALREADY_CLAIMED");
    }
  });

  it("allows force_claim from em execução and stays em execução", () => {
    const result = applyTransition(card({ status: "em_execucao" }), {
      type: "force_claim",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("em_execucao");
    }
  });

  it("allows force_reopen from em execução → aberto", () => {
    const result = applyTransition(card({ status: "em_execucao" }), {
      type: "force_reopen",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("aberto");
      expect(result.value.revisado).toBe(false);
    }
  });

  it("rejects handoff from aberto", () => {
    const result = applyTransition(card(), { type: "handoff" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TRANSITION");
    }
  });

  it("explains handoff from aberto in tool language, not event names", () => {
    const result = applyTransition(card(), { type: "handoff" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        "Card is open, call task_claim before task_deliver.",
      );
      expect(result.error.message).not.toMatch(/handoff/i);
    }
  });

  it("keeps every invalid-transition message free of internal event names", () => {
    const events: CardEvent[] = [
      { type: "claim" },
      { type: "handoff" },
      { type: "mark_revisado" },
      { type: "force_reopen" },
    ];
    for (const status of ["aberto", "em_execucao", "feito", "validado"] as const) {
      for (const event of events) {
        const result = applyTransition(card({ status }), event);
        if (result.ok) continue;
        if (result.error.code !== "INVALID_TRANSITION") continue;
        expect(result.error.message).not.toMatch(
          /handoff|force_claim|force_reopen|mark_revisado|'claim'/i,
        );
      }
    }
  });

  it("rejects validate from aberto and em_execucao", () => {
    for (const status of ["aberto", "em_execucao"] as const) {
      const result = applyTransition(card({ status }), {
        type: "validate",
        actor: "human",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_TRANSITION");
      }
    }
  });

  it("rejects agent validation — validado is a human stamp", () => {
    const result = applyTransition(card({ status: "feito" }), {
      type: "validate",
      actor: "agent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_HUMAN_ONLY");
    }
  });

  it("rejects every transition out of validado", () => {
    const events: CardEvent[] = [
      { type: "claim" },
      { type: "force_claim" },
      { type: "handoff" },
      { type: "validate", actor: "human" },
      { type: "reopen", comment: "já validado" },
      { type: "mark_revisado" },
      { type: "force_reopen" },
    ];
    for (const event of events) {
      const result = applyTransition(card({ status: "validado" }), event);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_TRANSITION");
      }
    }
  });

  it("rejects claim and force_claim from feito", () => {
    for (const event of [
      { type: "claim" },
      { type: "force_claim" },
    ] as const) {
      const result = applyTransition(card({ status: "feito" }), event);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_TRANSITION");
      }
    }
  });

  it("lists valid events exhaustively for each status", () => {
    expect(listValidEvents(card({ status: "aberto" }))).toEqual(["claim"]);
    expect(listValidEvents(card({ status: "em_execucao" })).sort()).toEqual(
      ["force_claim", "force_reopen", "handoff"].sort(),
    );
    expect(listValidEvents(card({ status: "feito" })).sort()).toEqual(
      ["mark_revisado", "reopen", "validate"].sort(),
    );
    expect(listValidEvents(card({ status: "validado" }))).toEqual([]);
  });

  it("does not mutate the input snapshot", () => {
    const snapshot = card({ status: "feito" });
    applyTransition(snapshot, {
      type: "reopen",
      comment: "volta pra fila",
    });
    expect(snapshot).toEqual({
      status: "feito",
      revisado: false,
      reopen_comment: null,
    });
  });
});
