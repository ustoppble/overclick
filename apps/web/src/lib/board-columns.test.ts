import { describe, expect, it } from "vitest";
import {
  COLUMN_STATUSES,
  countByStatus,
  firstStatusWithCards,
  type ColumnStatus,
} from "./board-columns";

const card = (status: ColumnStatus) => ({ status });

describe("board columns", () => {
  it("keeps the board order the phone selector reads in", () => {
    expect(COLUMN_STATUSES).toEqual([
      "aberto",
      "em_execucao",
      "feito",
      "validado",
      "descartado",
    ]);
  });

  it("counts every column, including the empty ones", () => {
    expect(
      countByStatus([
        card("aberto"),
        card("aberto"),
        card("feito"),
      ]),
    ).toEqual({
      aberto: 2,
      em_execucao: 0,
      feito: 1,
      validado: 0,
      descartado: 0,
    });
  });

  it("counts nothing without cards", () => {
    expect(countByStatus([])).toEqual({
      aberto: 0,
      em_execucao: 0,
      feito: 0,
      validado: 0,
      descartado: 0,
    });
  });

  it("opens on the first column that has cards", () => {
    expect(firstStatusWithCards(countByStatus([card("em_execucao")]))).toBe(
      "em_execucao",
    );
  });

  it("never opens on an empty column while cards sit further right", () => {
    expect(firstStatusWithCards(countByStatus([card("validado")]))).toBe(
      "validado",
    );
  });

  it("falls back to open when the board is empty", () => {
    expect(firstStatusWithCards(countByStatus([]))).toBe("aberto");
  });
});
