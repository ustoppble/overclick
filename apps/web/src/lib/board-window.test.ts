import { describe, expect, it } from "vitest";
import {
  addExtraCards,
  cardsInPeriod,
  findLinkedCard,
  mergeBoardCards,
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
  it("keeps the search hits the reader pulled in across a refresh", () => {
    const window = [card("a", "aberto", 20), card("v-new", "validado", 30)];
    const older = [card("v-old", "validado", 2)];
    // The refresh hands a fresh window that never had the search hit.
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

  it("adds search hits without duplicating what is already held", () => {
    const current = [card("a", "validado", 3)];
    const next = addExtraCards(current, [card("a", "validado", 3), card("b", "validado", 2)]);
    expect(next.map((c) => c.id)).toEqual(["a", "b"]);
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
      { ...card("a", "validado", 1), shortId: "OC-1", organizationId: "o", projectId: "p", missionId: null, tipo: "bug" as const, priority: "media" as const, resolvedIn: null, title: "black panes" },
      { ...card("b", "validado", 1), shortId: "OC-2", organizationId: "o", projectId: "p", missionId: null, tipo: "bug" as const, priority: "media" as const, resolvedIn: null, title: "matched in its contract" },
      { ...card("c", "validado", 1), shortId: "OC-3", organizationId: "o", projectId: "p", missionId: null, tipo: "bug" as const, priority: "media" as const, resolvedIn: null, title: "unrelated" },
    ];
    expect(
      searchWithServerHits(cards, "black", new Set(["b"])).map((c) => c.id),
    ).toEqual(["a", "b"]);
  });

  describe("the period decides what every column shows", () => {
    // Created on the 1st, touched on the 30th; created and touched on the 25th.
    const touched = { ...card("touched", "feito", 1), updatedAt: "2026-10-30T00:00:00.000Z" };
    const recent = card("recent", "aberto", 25);
    const stale = card("stale", "validado", 3);
    const since = "2026-10-20T00:00:00.000Z";

    it("reads the last activity under Updated", () => {
      expect(cardsInPeriod([touched, recent, stale], since, "updated").map((c) => c.id)).toEqual([
        "touched",
        "recent",
      ]);
    });

    it("reads the creation date under Created", () => {
      expect(cardsInPeriod([touched, recent, stale], since, "created").map((c) => c.id)).toEqual([
        "recent",
      ]);
    });

    it("keeps every card for all time", () => {
      expect(cardsInPeriod([touched, recent, stale], null, "created")).toHaveLength(3);
      expect(cardsInPeriod([touched, recent, stale], null, "updated")).toHaveLength(3);
    });
  });
});
