"use client";

import { boardFilterToQuery, type BoardFilter } from "../../lib/board-filter";
import type { BoardTotals } from "../../lib/board-totals";
import type { Dict } from "../../lib/i18n";
import { formatMoneyOrNone, formatTokens } from "../../lib/format";
import type { BoardCard, BoardMissionOption } from "./board";

const RELEASE_STATUSES = [
  "aberto",
  "em_execucao",
  "feito",
  "validado",
  "descartado",
] as const;

export function releaseOverview(
  cards: BoardCard[],
  missions: BoardMissionOption[],
  /** The columns' exact counts when the cards come by page (OCL board lazy). */
  exact?: Record<(typeof RELEASE_STATUSES)[number], number>,
) {
  const counts =
    exact ??
    (Object.fromEntries(
      RELEASE_STATUSES.map((status) => [
        status,
        cards.filter((card) => card.status === status).length,
      ]),
    ) as Record<(typeof RELEASE_STATUSES)[number], number>);
  const missionIds = new Set(cards.flatMap((card) => card.missionId ?? []));
  const involvedMissions = missions.filter((mission) => missionIds.has(mission.id));
  const executors = [
    ...new Set(cards.flatMap((card) => card.executors)),
  ].sort((a, b) => a.localeCompare(b));
  return { counts, missions: involvedMissions, executors };
}

export function ReleaseHeader({
  release,
  cards,
  counts,
  missions,
  totals,
  filter,
  onMissionSelect,
  t,
}: {
  release: string | null;
  cards: BoardCard[];
  /** The columns' exact counts; without them the cards held are counted. */
  counts?: Record<(typeof RELEASE_STATUSES)[number], number>;
  missions: BoardMissionOption[];
  totals: BoardTotals;
  filter: BoardFilter;
  onMissionSelect: (missionId: string) => void;
  t: Dict;
}) {
  const overview = releaseOverview(cards, missions, counts);
  const statuses = [
    [t.board.statusOpen, overview.counts.aberto],
    [t.board.statusInProgress, overview.counts.em_execucao],
    [t.board.statusDone, overview.counts.feito],
    [t.board.statusValidated, overview.counts.validado],
    [t.board.statusDiscarded, overview.counts.descartado],
  ] as const;
  const notes = [
    totals.estimated > 0 ? t.board.totalEstimated(totals.estimated) : null,
    totals.missing > 0 ? t.board.totalMissing(totals.missing) : null,
    totals.costUnpriced > 0 ? t.board.totalUnpriced(totals.costUnpriced) : null,
  ].filter(Boolean) as string[];
  const insightsHref = `/usage?${boardFilterToQuery(filter)}`;

  return (
    <section
      className="release-header nebula-glass"
      aria-label={t.board.releaseLabel}
    >
      <div className="release-heading">
        <span className="release-kicker">{t.board.releaseLabel}</span>
        <h1>{release ?? t.board.noRelease}</h1>
      </div>

      <div className="release-counts" aria-label={t.board.releaseCardCounts}>
        {statuses.map(([label, value]) => (
          <span className="release-count" key={label}>
            <b>{value}</b>
            {label}
          </span>
        ))}
      </div>

      {/* Money leads and says what it is; tokens follow with their unit
          (ux-v2 §4). No figure in this row is a bare number. */}
      <div className="release-usage" aria-label={t.board.releaseUsage}>
        <span>
          <span className="bt-label">{t.board.totalCostLabel}</span>{" "}
          <b>
            {formatMoneyOrNone(
              totals.costUsd,
              totals.costUnpriced > 0
                ? t.board.totalUnpriced(totals.costUnpriced)
                : t.board.releaseCostUnavailable,
              t.lang,
            )}
          </b>
        </span>
        <span>
          <b>{formatTokens(totals.tokens)}</b> {t.board.tokensWord}
        </span>
        {notes.length > 0 ? <small>{notes.join(" · ")}</small> : null}
        <a href={insightsHref}>{t.board.totalOpenInsights}</a>
      </div>

      <div className="release-relations">
        <div>
          <span className="release-rel-label">{t.board.releaseMissions}</span>
          <div className="release-chips">
            {overview.missions.length > 0 ? (
              overview.missions.map((mission) => (
                <button
                  className="release-chip"
                  type="button"
                  key={mission.id}
                  onClick={() => onMissionSelect(mission.id)}
                >
                  {mission.title}
                </button>
              ))
            ) : (
              <span className="release-empty">{t.board.releaseNoMissions}</span>
            )}
          </div>
        </div>
        <div>
          <span className="release-rel-label">{t.board.releaseExecutors}</span>
          <div className="release-chips">
            {overview.executors.length > 0 ? (
              overview.executors.map((executor) => (
                <span className="release-chip static" key={executor}>
                  {executor}
                </span>
              ))
            ) : (
              <span className="release-empty">{t.board.releaseNoExecutors}</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
