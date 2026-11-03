"use client";

import { BOARD_PERIODS, type BoardPeriod } from "../../lib/board-filter";
import type { Dict } from "../../lib/i18n";

/**
 * How far back the board reaches, by a card's last activity. A native select:
 * four fixed answers need no panel, and the chip sits with the other filters
 * so it is read as one of them.
 */
export function PeriodFilter({
  value,
  onChange,
  t,
}: {
  value: BoardPeriod;
  onChange: (period: BoardPeriod) => void;
  t: Dict;
}) {
  return (
    <label className="filter-chip period-filter">
      <select
        aria-label={t.board.periodLabel}
        value={value}
        onChange={(event) => onChange(event.target.value as BoardPeriod)}
      >
        {BOARD_PERIODS.map((period) => (
          <option key={period} value={period}>
            {t.board.periodOptions[period]}
          </option>
        ))}
      </select>
    </label>
  );
}
