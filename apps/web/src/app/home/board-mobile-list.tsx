"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  COLUMN_STATUSES,
  countByStatus,
  firstStatusWithCards,
  type ColumnStatus,
} from "../../lib/board-columns";
import type { Dict } from "../../lib/i18n";
import { Icon } from "../../components/icon";
import type { BoardCard } from "./board";

/**
 * The board on a phone (AGB-62).
 *
 * Four columns never fit a narrow screen, and the carousel that came before
 * this made them fight for it: two columns on screen meant every title was
 * cut in half, and the title is the one thing a person opens the board to
 * read. So the phone shows one column at a time as a plain vertical list,
 * and the card takes the whole width.
 *
 * The selector on top is the column head from the desktop board, made into a
 * control: the same label, the same count, now switchable. It is a native
 * select on purpose, because the phone renders its options full size and
 * nothing about the choice depends on a popover behaving on touch.
 *
 * The rows themselves come in already rendered, so the list never owns a
 * second version of the card: the same BoardCard, the same filters, the same
 * detail panel. The count sits outside the select so it is never the thing an
 * ellipsis eats.
 *
 * Since AGB-64 a card here is a single row, not the three-line card the desktop
 * columns render: on a narrow screen the board is for scanning what exists, and
 * everything a row drops is one tap away in the detail panel.
 */
export function BoardMobileList({
  cards,
  labels,
  renderRow,
  renderEmpty,
  t,
}: {
  /** Already through the board filters, exactly what the columns render. */
  cards: BoardCard[];
  labels: Record<ColumnStatus, string>;
  /** The card as one dense row, rendered by the board that owns the detail. */
  renderRow: (card: BoardCard) => ReactNode;
  renderEmpty: (status: ColumnStatus) => ReactNode;
  t: Dict;
}) {
  const counts = useMemo(() => countByStatus(cards), [cards]);
  // Only the opening column follows the cards. Once a person picks a column,
  // a filter emptying it is an answer, not a reason to move them elsewhere.
  const [status, setStatus] = useState<ColumnStatus>(() =>
    firstStatusWithCards(countByStatus(cards)),
  );
  const list = cards.filter((card) => card.status === status);

  return (
    <div className="board-mobile">
      <label className="ml-head">
        <select
          className="ml-status"
          aria-label={t.board.columnShown}
          value={status}
          onChange={(event) => setStatus(event.target.value as ColumnStatus)}
        >
          {COLUMN_STATUSES.map((option) => (
            <option key={option} value={option}>
              {labels[option]}
            </option>
          ))}
        </select>
        {/* The select has no chrome of its own here, so the caret is what
            says this line is a control and not a heading. Since AGB-73 the
            caret is the set's own chevron, not the ▾ character: the glyph a
            phone had for that codepoint was never the same shape twice. */}
        <span className="ml-caret">
          <Icon name="chevronDown" label={null} size={13} />
        </span>
        <span className="count">{counts[status]}</span>
      </label>
      <div className="col">
        {list.length === 0 ? renderEmpty(status) : list.map(renderRow)}
      </div>
    </div>
  );
}
