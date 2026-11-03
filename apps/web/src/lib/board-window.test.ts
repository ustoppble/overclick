import { describe, expect, it } from "vitest";
import {
  addExtraCards,
  columnTotal,
  findLinkedCard,
  mergeBoardCards,
  olderLeft,
  pageCursor,
  searchWithServerHits,
  windowCursor,
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

  it("starts the first page below the oldest change of the window", () => {
    const since = "2026-10-03T00:00:00.000Z";
    const cards = [
      card("v1", "validado", 10),
      card("v2", "validado", 4),
      card("o1", "aberto", 1),
    ];
    expect(windowCursor(cards, "validado", since)).toEqual({
      updatedAt: "2026-10-04T00:00:00.000Z",
      id: "v2",
    });
    expect(windowCursor(cards, "descartado", since)).toBeNull();
  });

  it("does not let a search hit or a linked card pull the cursor past the window", () => {
    const since = "2026-10-23T00:00:00.000Z";
    const windowCards = [
      card("v-new", "validado", 30),
      card("v-edge", "validado", 25),
      // ?card= of a three-month-old card rides along with the window.
      card("v-linked", "validado", 2),
    ];
    // A search hit lives in the extras, which never reach the cursor.
    const cursor = windowCursor(windowCards, "validado", since);
    expect(cursor).toEqual({ updatedAt: "2026-10-25T00:00:00.000Z", id: "v-edge" });
  });

  it("moves the cursor only with the page the server returned", () => {
    const page = [
      card("p1", "validado", 20),
      card("p2", "validado", 18),
      card("p3", "validado", 16),
    ];
    expect(pageCursor(page)).toEqual({
      updatedAt: "2026-10-16T00:00:00.000Z",
      id: "p3",
    });
    expect(pageCursor([])).toBeNull();
  });

  it("opens the current owner of a short id before the card that once had it", () => {
    const former = {
      ...card("former", "validado", 3),
      shortId: "OC-9",
      previousShortIds: [] as string[],
    };
    const old = { ...former, id: "old", shortId: "OC-4", previousShortIds: ["OC-9"] };
    const owner = { ...former, id: "owner" };
    expect(findLinkedCard([old, owner], "oc-9")?.id).toBe("owner");
    expect(findLinkedCard([old], "OC-9")?.id).toBe("old");
    expect(findLinkedCard([old, owner], "OC-404")).toBeNull();
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

  it("offers show-older on the done column too, with what is left of the real total", () => {
    const counts = { aberto: 5, em_execucao: 2, feito: 2672, validado: 50, descartado: 71 };
    const loaded = { aberto: 5, em_execucao: 2, feito: 12, validado: 3, descartado: 71 };
    expect(olderLeft(counts, loaded, () => false)).toEqual({
      feito: 2660,
      validado: 47,
    });
  });

  it("drops a column the server said is exhausted", () => {
    const counts = { aberto: 0, em_execucao: 0, feito: 90, validado: 0, descartado: 0 };
    const loaded = { aberto: 0, em_execucao: 0, feito: 40, validado: 0, descartado: 0 };
    expect(olderLeft(counts, loaded, (status) => status === "feito")).toEqual({});
  });

  it("offers nothing while the counts are not the ones of this filter", () => {
    const loaded = { aberto: 0, em_execucao: 0, feito: 40, validado: 0, descartado: 0 };
    expect(olderLeft(null, loaded, () => false)).toEqual({});
  });
});
