import { describe, expect, it } from "vitest";
import {
  approx,
  formatDuration,
  formatElapsed,
  formatMoney,
  formatMoneyOrNone,
  formatCalendarDate,
  formatShortDate,
  formatShortDateTime,
  formatTokens,
  workspaceTimeZone,
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

describe("formatShortDate", () => {
  // Instants, not local parts: the day a date falls on is the workspace's,
  // so the test pins the instant and reads the same in any process TZ.
  const now = new Date("2026-11-04T12:00:00Z");
  const nov3 = new Date("2026-11-03T17:05:00Z"); // 14:05 in São Paulo

  it("puts the day first in Portuguese, so 3 November never reads as 11 March", () => {
    expect(formatShortDate(nov3, "pt-BR", now)).toBe("03/11");
  });

  it("keeps the month first in English", () => {
    expect(formatShortDate(nov3, "en", now)).toBe("11/03");
  });

  it("spells the time after the date in the reader's own order", () => {
    expect(flat(formatShortDateTime(nov3, "pt-BR", now))).toBe("03/11, 14:05");
    expect(flat(formatShortDateTime(nov3, "en", now))).toBe("11/03, 05:05 PM");
  });

  it("adds the year when it is not this year, so last November is not this one", () => {
    const lastYear = new Date("2025-11-03T17:05:00Z");
    expect(formatShortDate(lastYear, "pt-BR", now)).toBe("03/11/2025");
    expect(formatShortDate(lastYear, "en", now)).toBe("11/03/2025");
    expect(flat(formatShortDateTime(lastYear, "pt-BR", now))).toBe("03/11/2025, 14:05");
  });

  it("decides the day in the workspace's zone, so the server and the browser agree", () => {
    // 01:30 UTC on 4 November is still 3 November in São Paulo.
    const lateNight = new Date("2026-11-04T01:30:00Z");
    expect(formatShortDate(lateNight, "pt-BR", now)).toBe("03/11");
    expect(flat(formatShortDateTime(lateNight, "pt-BR", now))).toBe("03/11, 22:30");
    // and the year turns over in that zone too, not in the server's
    const newYearsEve = new Date("2027-01-01T01:00:00Z");
    expect(formatShortDate(newYearsEve, "pt-BR", now)).toBe("31/12");
  });

  it("names one zone per workspace language", () => {
    expect(workspaceTimeZone("pt-BR")).toBe("America/Sao_Paulo");
    expect(workspaceTimeZone("en")).toBe("UTC");
  });
});

describe("formatCalendarDate", () => {
  it("spells a stored calendar day in the reader's order, never as ISO (E0 review)", () => {
    expect(formatCalendarDate("2026-09-01", "pt-BR")).toBe("01/09/2026");
    expect(formatCalendarDate("2026-09-01", "en")).toBe("09/01/2026");
  });

  it("does not move the day by a time zone: a calendar day has none", () => {
    expect(formatCalendarDate("2026-01-01", "pt-BR")).toBe("01/01/2026");
    expect(formatCalendarDate("2026-12-31", "en")).toBe("12/31/2026");
  });

  it("leaves a value it cannot read as it came", () => {
    expect(formatCalendarDate("sometime", "pt-BR")).toBe("sometime");
  });
});
