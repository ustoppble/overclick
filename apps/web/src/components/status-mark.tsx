import type { ReactNode } from "react";
import type { ColumnStatus } from "../lib/board-columns";

/**
 * The one mark of a card's status (navigation plan E1, variant A): a neutral
 * 12px glyph whose shape says the state, so it reads in grey, on a
 * compressed live stream and to someone who does not tell colours apart
 * (WCAG 1.4.1). An empty ring is the queue, half is running, three quarters
 * waits for review, full with a tick is validated, struck through is
 * discarded. The grey rises with urgency (global-bar.css): To review in the
 * first ink, the rest in the second and third.
 *
 * Same mark wherever the status is named: the column head, the review chip,
 * the phone's rows and the card sheet's state chip.
 */
const RING = <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.25" />;

const GLYPH: Record<ColumnStatus, ReactNode> = {
  aberto: RING,
  em_execucao: (
    <>
      {RING}
      <path d="M6 3a3 3 0 0 1 0 6z" fill="currentColor" />
    </>
  ),
  feito: (
    <>
      {RING}
      <path d="M6 6V3a3 3 0 1 1-3 3z" fill="currentColor" />
    </>
  ),
  validado: (
    <>
      <circle cx="6" cy="6" r="5.6" fill="currentColor" />
      <path
        className="sm-tick"
        d="m3.6 6.1 1.6 1.6 3.2-3.3"
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  descartado: (
    <>
      {RING}
      <path d="M2.6 9.4 9.4 2.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </>
  ),
};

export function StatusMark({ status }: { status: ColumnStatus }) {
  return (
    <span className="status-mark" data-status={status}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
        {GLYPH[status]}
      </svg>
    </span>
  );
}
