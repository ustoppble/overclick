import { describe, expect, it } from "vitest";
import {
  addExtraCards,
  columnTotal,
  mergeBoardCards,
  olderCursor,
  searchWithServerHits,
} from "./board-window";

type Card = {
  id: string;
  status: "aberto" | "em_execucao" | "feito" | "validado" | "descartado";
  createdAt: string;
  updatedAt: string;
  title: string;
};

function card(id: string, status: Card["status"], day: number, title = id): Card {
  const at = `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  return { id, status, createdAt: at, updatedAt: at, title };
}

describe("board window, client side", () => {
  it("keeps the older cards the reader loaded across a refresh", () => {
    const window = [card("a", "aberto", 20), card("v-new", "validado", 30)];
    const older = [card("v-old", "validado", 2)];
    // The refresh hands a fresh window that never had the older card.
    const refreshed = [card("a", "aberto", 20), card("v-new", "validado", 30)];
    expect(mergeBoardCards(window, older).map((c) => c.id)).toEqual([
      "v-old",
      "a",
      "v-new",
    ]);
    expect(mergeBoardCards(refreshed, older).map((c) => c.id)).toContain("v-old");
  });

  it("prefers the window's copy of a card it also holds as an extra", () => {
    const stale = { ...card("x", "validado", 2), title: "stale" };
    const fresh = { ...card("x", "aberto", 2), title: "reopened" };
    const merged = mergeBoardCards([fresh], [stale]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("reopened");
  });

  it("adds a page without duplicating what is already held", () => {
    const current = [card("a", "validado", 3)];
    const next = addExtraCards(current, [card("a", "validado", 3), card("b", "validado", 2)]);
    expect(next.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("starts the next page below the column's oldest change", () => {
    const cards = [
      card("v1", "validado", 10),
      card("v2", "validado", 4),
      card("o1", "aberto", 1),
    ];
    expect(olderCursor(cards, "validado")).toEqual({
      updatedAt: "2026-10-04T00:00:00.000Z",
      id: "v2",
    });
    expect(olderCursor(cards, "descartado")).toBeNull();
  });

  it("shows a server search hit the local words did not match", () => {
    const cards = [
      { ...card("a", "validado", 1), shortId: "OC-1", oQue: "", porQue: "", comoConfirmo: [], organizationId: "o", projectId: "p", missionId: null, tipo: "bug" as const, priority: "media" as const, resolvedIn: null, title: "black panes" },
      { ...card("b", "validado", 1), shortId: "OC-2", oQue: "", porQue: "", comoConfirmo: [], organizationId: "o", projectId: "p", missionId: null, tipo: "bug" as const, priority: "media" as const, resolvedIn: null, title: "matched in a comment" },
      { ...card("c", "validado", 1), shortId: "OC-3", oQue: "", porQue: "", comoConfirmo: [], organizationId: "o", projectId: "p", missionId: null, tipo: "bug" as const, priority: "media" as const, resolvedIn: null, title: "unrelated" },
    ];
    expect(
      searchWithServerHits(cards, "black", new Set(["b"])).map((c) => c.id),
    ).toEqual(["a", "b"]);
  });

  it("counts the whole column, never less than what is on screen", () => {
    expect(columnTotal(12, 3009)).toBe(3009);
    expect(columnTotal(5, undefined)).toBe(5);
    expect(columnTotal(6, 5)).toBe(6);
  });
});
