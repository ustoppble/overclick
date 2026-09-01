import { describe, expect, it } from "vitest";
import {
  approx,
  formatDuration,
  formatElapsed,
  formatMoney,
  formatMoneyOrNone,
  formatTokens,
} from "./format";

/** Intl inserts narrow/no-break spaces between symbol and figure. */
function flat(text: string): string {
  return text.replace(/[\u00a0\u202f\u2007\u200b]/g, " ");
}

describe("formatMoney", () => {
  it("spells the currency explicitly per locale", () => {
    expect(flat(formatMoney(27.1, "pt-BR"))).toBe("US$ 27,10");
    expect(flat(formatMoney(27.1, "en"))).toBe("$27.10");
  });

  it("always keeps two decimals", () => {
    expect(flat(formatMoney(2, "en"))).toBe("$2.00");
    expect(flat(formatMoney(1234.5, "pt-BR"))).toBe("US$ 1.234,50");
    expect(flat(formatMoney(1234.5, "en"))).toBe("$1,234.50");
  });

  it("never prints a null price as zero", () => {
    expect(formatMoneyOrNone(null, "sem preço", "pt-BR")).toBe("sem preço");
    expect(formatMoneyOrNone(null, "no price", "en")).toBe("no price");
    expect(flat(formatMoneyOrNone(0.42, "no price", "en"))).toBe("$0.42");
  });
});

describe("formatTokens", () => {
  it("scales to the unit the number fills", () => {
    expect(formatTokens(175_000_000)).toBe("175M");
    expect(formatTokens(94_800_000)).toBe("94.8M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(0)).toBe("0");
  });

  it("reaches the billion a long-running board actually gets to", () => {
    expect(formatTokens(12_519_100_000)).toBe("12.5B");
    expect(formatTokens(1_000_000_000)).toBe("1B");
    // One token below the step still reads in millions, so the boundary is
    // the billion itself and not a rounding artefact.
    expect(formatTokens(999_999_999)).toBe("1000M");
  });
});

describe("formatDuration", () => {
  it("claims only the unit it can be honest about", () => {
    expect(formatDuration(58_000)).toBe("58s");
    expect(formatDuration(33 * 60_000)).toBe("33m");
    expect(formatDuration((4 * 60 + 14) * 60_000)).toBe("4h14");
    expect(formatDuration(4 * 3_600_000)).toBe("4h00");
  });
});

describe("formatElapsed", () => {
  it("rounds age to days once hours stop meaning anything", () => {
    expect(formatElapsed(33 * 60_000)).toBe("33 min");
    expect(formatElapsed(41 * 3_600_000)).toBe("41h");
    expect(formatElapsed(4 * 86_400_000)).toBe("4d");
  });
});

describe("approx", () => {
  it("marks the inexact and leaves the exact alone", () => {
    expect(approx("$27.10", true)).toBe("~$27.10");
    expect(approx("175M", false)).toBe("175M");
  });
});
