import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardFilter } from "../../lib/board-filter";
import { EMPTY_BOARD_TOTALS, type BoardTotals } from "../../lib/board-totals";
import { dict, type Lang } from "../../lib/i18n";
import { BoardTotal, totalParts } from "./board-total";

const FILTER: BoardFilter = {
  organizationIds: [],
  projectIds: [],
  missionId: null,
  types: [],
  priorities: [],
  resolvedIn: null,
};

/** Intl inserts narrow/no-break spaces between symbol and figure. */
function flat(text: string): string {
  return text.replace(/[   ​]/g, " ");
}

function render(
  totals: Partial<BoardTotals>,
  lang: Lang = "pt-BR",
  Component: typeof BoardTotal = BoardTotal,
): string {
  return flat(
    renderToStaticMarkup(
      createElement(Component, {
        totals: { ...EMPTY_BOARD_TOTALS, attempts: 4, ...totals },
        filter: FILTER,
        t: dict(lang),
      }),
    ),
  );
}

describe("board total stat", () => {
  it("leads with labeled money in the workspace's currency", () => {
    const html = render({
      tokens: 175_200_000,
      durationMs: (4 * 60 + 14) * 60_000,
      costUsd: 27.1,
      costComputed: 4,
    });
    expect(html).toContain("Custo");
    expect(html).toContain("~US$ 27,10");
    // The support numbers keep their unit and stay behind the money.
    expect(html).toContain("175.2M tokens · 4h14");
  });

  it("says $ in en and US$ in pt-BR from one figure", () => {
    expect(render({ costUsd: 27.1, costComputed: 1 }, "en")).toContain(
      "~$27.10",
    );
    expect(render({ costUsd: 27.1, costComputed: 1 }, "pt-BR")).toContain(
      "~US$ 27,10",
    );
  });

  it("drops the tilde when every cost was measured and reported", () => {
    const html = render({ costUsd: 27.1, costReported: 4 });
    expect(html).toContain("US$ 27,10");
    expect(html).not.toContain("~");
  });

  it("never prints a figure the board could not establish", () => {
    // Money off: tokens lead instead, and zero is not printed as a price.
    const html = render({ tokens: 12_400, costUsd: null });
    expect(html).toContain("12k tokens");
    expect(html).not.toContain("US$");
    expect(html).not.toContain("Custo");
  });

});

/**
 * The popover only exists once the stat is clicked, so its reading is checked
 * where it is decided rather than through a render that cannot open it.
 */
function note(totals: Partial<BoardTotals>, lang: Lang = "pt-BR") {
  return totalParts(
    { ...EMPTY_BOARD_TOTALS, attempts: 4, ...totals },
    FILTER,
    dict(lang),
  ).approxNote;
}

describe("the reading of the tilde", () => {
  it("counts what the figure could not measure or price", () => {
    expect(note({ costUsd: 27.1, estimated: 3, costUnpriced: 1 })).toBe(
      "~ = estimado: 3 sem uso medido · 1 sem preço",
    );
  });

  it("names the price table when that is the whole of it", () => {
    expect(note({ costUsd: 27.1, costComputed: 2 })).toBe(
      "~ = calculado pela tabela de preços",
    );
  });

  it("does not say the same thing twice", () => {
    // The source lines already count what the board priced itself, so the
    // note stays on the counts nothing else reports.
    expect(note({ costUsd: 27.1, estimated: 3, costComputed: 2 })).toBe(
      "~ = estimado: 3 sem uso medido",
    );
  });

  it("says nothing when there is no tilde to explain", () => {
    expect(note({ costUsd: 27.1, costReported: 4 })).toBeNull();
  });

  it("explains the tilde on tokens when money is off", () => {
    expect(note({ costUsd: null, tokens: 12_400, estimated: 2 })).toBe(
      "~ = estimado: 2 sem uso medido",
    );
  });

});
