import { describe, expect, it } from "vitest";
import { COLUMN_STATUSES, type ColumnStatus } from "./board-columns";
import { missionOptionsFromCounts, releaseOptionsFromCounts } from "./board-filter";
import {
  appendColumnPage,
  columnsAfterRefresh,
  newestFirst,
  type HeldColumns,
} from "./board-window";

type Card = { id: string };

function held(key: string, sizes: Partial<Record<ColumnStatus, number>>, next: string | null = "c1") {
  return {
    key,
    columns: Object.fromEntries(
      COLUMN_STATUSES.map((status) => [
        status,
        {
          cards: Array.from({ length: sizes[status] ?? 0 }, (_, i) => ({ id: `${status}-${i}` })),
          next: (sizes[status] ?? 0) > 0 ? next : null,
        },
      ]),
    ) as HeldColumns<Card>["columns"],
  };
}

describe("the columns by page, in the browser (OCL board lazy)", () => {
  it("adds a scrolled page after the cards held, without one twice", () => {
    const columns = held("k", { feito: 3, aberto: 1 });
    const next = appendColumnPage(columns, "feito", "c1", {
      key: "k",
      // aberto-0 changed columns since: it is held already and stays where it is.
      cards: [{ id: "feito-9" }, { id: "aberto-0" }, { id: "feito-2" }],
      next: "c2",
    });
    expect(next.columns.feito.cards.map((card) => card.id)).toEqual([
      "feito-0",
      "feito-1",
      "feito-2",
      "feito-9",
    ]);
    expect(next.columns.feito.next).toBe("c2");
    expect(next.columns.aberto).toBe(columns.columns.aberto);
  });

  it("drops a page that answers another filter or a cursor the columns already left", () => {
    const columns = held("k", { feito: 3 });
    const page = { key: "k", cards: [{ id: "x" }], next: null };
    expect(appendColumnPage(columns, "feito", "old-cursor", page)).toBe(columns);
    expect(appendColumnPage(columns, "feito", "c1", { ...page, key: "other" })).toBe(columns);
  });

  it("takes the refresh's first pages when nothing was scrolled past them", () => {
    expect(columnsAfterRefresh(held("k", { feito: 40 }), held("k", { feito: 40 }), 40)).toEqual({
      adopt: true,
    });
  });

  it("re-reads as deep as the reader scrolled, so the poll loses no page", () => {
    const answer = columnsAfterRefresh(held("k", { feito: 120, aberto: 7 }), held("k", { feito: 40 }), 40);
    expect(answer).toEqual({
      adopt: false,
      depth: { aberto: 7, em_execucao: 0, feito: 120, validado: 0, descartado: 0 },
    });
  });

  it("re-reads under the filter on screen when the refresh answered another one", () => {
    const answer = columnsAfterRefresh(held("mine", { feito: 10 }), held("server", { feito: 40 }), 40);
    expect(answer.adopt).toBe(false);
  });

  it("lays cards out newest first by the period's date, the id breaking ties", () => {
    const cards = [
      { id: "a", status: "feito" as const, createdAt: "2026-01-03", updatedAt: "2026-02-01" },
      { id: "b", status: "feito" as const, createdAt: "2026-01-01", updatedAt: "2026-03-01" },
      { id: "c", status: "feito" as const, createdAt: "2026-01-03", updatedAt: "2026-02-01" },
    ];
    expect(newestFirst(cards, "updated").map((card) => card.id)).toEqual(["b", "c", "a"]);
    expect(newestFirst(cards, "created").map((card) => card.id)).toEqual(["c", "a", "b"]);
  });

  it("offers the missions and releases the server counted, the picked one kept at zero", () => {
    const missions = [
      { id: "m1", title: "One" },
      { id: "m2", title: "Two" },
      { id: "m3", title: "Three" },
    ];
    expect(missionOptionsFromCounts(missions, { m1: 4 }, "m3")).toEqual([
      { id: "m1", title: "One", count: 4 },
      { id: "m3", title: "Three", count: 0 },
    ]);
    expect(
      releaseOptionsFromCounts([{ value: "v1.2.0" }, { value: "branch@abc" }], { "v1.2.0": 2, "": 5 }),
    ).toEqual([
      { value: "v1.2.0", count: 2 },
      { value: null, count: 5 },
    ]);
  });
});
