"use client";

import { useEffect, useRef, useState } from "react";
import { boardFilterToQuery, type BoardFilter } from "../../lib/board-filter";
import type { BoardTotals } from "../../lib/board-totals";
import {
  approx,
  formatDuration,
  formatElapsed,
  formatMoney,
  formatTokens,
} from "../../lib/format";
import type { Dict } from "../../lib/i18n";

/*
 * The stat reads as money now (ux-v2.md §4): a label, the currency-explicit
 * figure leading, tokens and time secondary. The tilde on the figure is not
 * decoration — the popover says how many cards ride behind it.
 */

/** A caveat the total carries, with where to go to do something about it. */
type Warn = { text: string; href: string };

/**
 * Everything the bar shows about the total, computed once for the stat, the
 * popover and the menu line: the label, the lead figure, the support numbers,
 * the hover reading and the caveats. A run that reported an estimate, a run
 * that reported nothing, and a model with no price in the table are each
 * named, because a total that swallows them is worth less than no total.
 */
export function totalParts(totals: BoardTotals, filter: BoardFilter, t: Dict) {
  const href = `/insights?${boardFilterToQuery(filter)}`;
  const estimated = totals.estimated > 0;
  const tokensText = `${formatTokens(totals.tokens)} ${t.board.tokensWord}`;
  const time = formatDuration(totals.durationMs);
  // With money on, the dollars lead — labeled, in the workspace's locale —
  // and the rest supports them. With money off, or with nothing this
  // selection could price, tokens lead instead: a figure the board cannot
  // establish is never printed as a zero.
  const costUsd = totals.costUsd;
  const label = costUsd != null ? t.board.totalCostLabel : null;
  // The tilde is a claim about the figure, so it only shows up when the board
  // can name why: usage an agent estimated rather than measured, tokens no
  // price covers, money worked out from the price table instead of reported.
  // With every attempt reporting its own measured cost, the figure is exact
  // and the tilde goes — a "~" nobody can explain is worse than no "~".
  const counted = (
    costUsd != null
      ? [
          totals.estimated > 0 ? t.board.approxEstimated(totals.estimated) : null,
          totals.costUnpriced > 0
            ? t.board.approxUnpriced(totals.costUnpriced)
            : null,
        ]
      : [estimated ? t.board.approxEstimated(totals.estimated) : null]
  ).filter(Boolean) as string[];
  // Money the board priced itself is approximate too, but the source lines
  // below already count it, so it only speaks up when it is the whole reason
  // — otherwise the reading would say the same thing twice.
  const pricedFromTable = costUsd != null && totals.costComputed > 0;
  const isApprox = counted.length > 0 || pricedFromTable;
  const approxNote = counted.length
    ? t.board.totalApproxNote(counted.join(" · "))
    : pricedFromTable
      ? t.board.totalApproxComputed
      : null;
  const lead =
    costUsd != null
      ? approx(formatMoney(costUsd, t.lang), isApprox)
      : approx(tokensText, isApprox);
  const support = costUsd != null ? `${tokensText} · ${time}` : time;

  const warns: Warn[] = [];
  if (totals.costUnpriced > 0) {
    // The fix for an unpriced model lives in the price table, not in
    // Insights, so this one caveat points at Settings instead.
    warns.push({
      text: t.board.totalUnpriced(totals.costUnpriced),
      href: "/settings?tab=prices",
    });
  }
  if (totals.estimated > 0) {
    warns.push({ text: t.board.totalEstimated(totals.estimated), href });
  }
  if (totals.missing > 0) {
    warns.push({ text: t.board.totalMissing(totals.missing), href });
  }
  if (totals.suspect > 0) {
    warns.push({
      text: t.board.totalSuspect(
        totals.suspect,
        formatTokens(totals.suspectTokens),
      ),
      href,
    });
  }

  const detail = [
    totals.costComputed > 0
      ? `${totals.costComputed} ${t.board.costComputed}`
      : null,
    totals.costReported > 0
      ? `${totals.costReported} ${t.board.costReported}`
      : null,
    totals.costEstimated > 0
      ? `${totals.costEstimated} ${t.board.costEstimated}`
      : null,
    totals.elapsedOnly > 0
      ? t.board.openFor(formatElapsed(totals.elapsedMs))
      : null,
  ].filter(Boolean) as string[];

  // The hover reading, for the pointer that never clicks: the label, then the
  // sources and the caveats. The tilde's own note stays in the popover, where
  // it has a line to itself instead of a clause inside a run-on sentence.
  // The tokens and the time ride the title too: where the bar is short it
  // shows the figure alone, and hovering it still reads all three.
  const title = [t.board.totalLabel, support, ...detail, ...warns.map((w) => w.text)]
    .filter(Boolean)
    .join(" · ");

  return {
    href,
    label,
    lead,
    support,
    tokensText,
    time,
    approxNote,
    warns,
    detail,
    title,
  };
}

/**
 * The running total of what the work on screen consumed: a compact stat in
 * the bar that opens a popover with the full reading. The bar shows the
 * labeled figure and nothing else — what used to be a bare count of caveats
 * in parentheses is now said in words inside the popover, each linked to
 * where it is resolved: unpriced models to Settings › Prices, the rest to
 * the cards in Insights under this filter.
 *
 * The numbers come from the aggregation the Insights page runs, narrowed by
 * the same filter, so the two pages show the same selection.
 */
export function BoardTotal({
  totals,
  filter,
  t,
}: {
  totals: BoardTotals;
  filter: BoardFilter;
  t: Dict;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const parts = totalParts(totals, filter, t);

  // Same closing gesture as the filter panels: click away, or Escape.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (totals.attempts === 0) {
    return (
      <a className="board-total oc-tappable" href={parts.href} title={parts.title}>
        <span className="bt-none">{t.board.totalNone}</span>
      </a>
    );
  }

  return (
    <div className="board-total-wrap" ref={root}>
      <button
        type="button"
        className="board-total oc-tappable"
        title={parts.title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {parts.label ? <span className="bt-label">{parts.label}</span> : null}
        <b className="bt-lead">{parts.lead}</b>
        <span className="bt-sub">{parts.support}</span>
      </button>
      {open ? (
        <div className="bt-popover nebula-glass" role="dialog" aria-label={t.board.totalLabel}>
          <div className="bt-figure">
            <b className="bt-lead">{parts.lead}</b>
            <span className="bt-sub">
              {parts.tokensText} · {parts.time}
            </span>
          </div>
          {parts.approxNote ? (
            <span className="bt-line bt-note">{parts.approxNote}</span>
          ) : null}
          {parts.detail.map((line) => (
            <span key={line} className="bt-line">
              {line}
            </span>
          ))}
          {parts.warns.map((warn) => (
            <a key={warn.text} className="bt-line bt-link" href={warn.href}>
              {warn.text}
            </a>
          ))}
          <a className="bt-line bt-link bt-insights" href={parts.href}>
            {t.board.totalOpenInsights}
          </a>
        </div>
      ) : null}
    </div>
  );
}
