import { describe, expect, it } from "vitest";
import {
  TASK_STATUSES,
  canMarkRevisado,
  canTransition,
} from "./task-status";

describe("task status machine (spec §3.1)", () => {
  it("lists workflow statuses including discarded", () => {
    expect(TASK_STATUSES).toEqual([
      "aberto",
      "em_execucao",
      "feito",
      "validado",
      "descartado",
    ]);
  });

  it("allows claim: aberto → em_execucao", () => {
    expect(canTransition("aberto", "em_execucao", "agent")).toBe(true);
    expect(canTransition("aberto", "em_execucao", "human")).toBe(true);
  });

  it("allows handoff: em_execucao → feito", () => {
    expect(canTransition("em_execucao", "feito", "agent")).toBe(true);
  });

  it("allows reopen: feito → aberto when a comment is present", () => {
    expect(
      canTransition("feito", "aberto", "human", { hasComment: true }),
    ).toBe(true);
    expect(
      canTransition("feito", "aberto", "agent", { hasComment: true }),
    ).toBe(true);
  });

  it("rejects reopen without a comment", () => {
    expect(
      canTransition("feito", "aberto", "human", { hasComment: false }),
    ).toBe(false);
  });

  it("allows human-only validation: feito → validado", () => {
    expect(canTransition("feito", "validado", "human")).toBe(true);
    expect(canTransition("feito", "validado", "agent")).toBe(false);
  });

  it("allows a human (or force claim) to reopen a stuck attempt: em_execucao → aberto", () => {
    expect(canTransition("em_execucao", "aberto", "human")).toBe(true);
    expect(
      canTransition("em_execucao", "aberto", "agent", { force: true }),
    ).toBe(true);
    expect(canTransition("em_execucao", "aberto", "agent")).toBe(false);
  });

  it("rejects skips and backwards jumps that are not reopen", () => {
    expect(canTransition("aberto", "feito", "agent")).toBe(false);
    expect(canTransition("aberto", "validado", "human")).toBe(false);
    expect(canTransition("em_execucao", "validado", "human")).toBe(false);
    expect(canTransition("validado", "aberto", "human")).toBe(false);
  });

  it("treats revisado as a flag on feito, not a status", () => {
    expect(canMarkRevisado("feito")).toBe(true);
    expect(canMarkRevisado("aberto")).toBe(false);
    expect(canMarkRevisado("em_execucao")).toBe(false);
    expect(canMarkRevisado("validado")).toBe(false);
  });
});
