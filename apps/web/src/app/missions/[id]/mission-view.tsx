"use client";

import { useRouter } from "next/navigation";
import { CliMark } from "../../../components/cli-mark";
import { Icon } from "../../../components/icon";
import { Markdown } from "../../../components/markdown";
import type { BoardTotals } from "../../../lib/board-totals";
import { formatDuration, formatMoney, formatTokens } from "../../../lib/format";
import { dict, isLang } from "../../../lib/i18n";
import type { MissionRun } from "../../../lib/mission-page";
import {
  Board,
  type BoardCard,
  type BoardMissionOption,
  type ViewerRole,
} from "../../board/board";
import { MissionHeader } from "../../board/mission-header";
import { MissionProgressBar } from "../../board/mission-progress-bar";
import { MissionStatus } from "../mission-status";

/**
 * One mission as a place (navigation plan E3, F5): what it is for, what it
 * cost, what ran on it and how far it got, then its cards with the project of
 * each. It ignores the board's project scope: all of it is the whole mission.
 */
export function MissionView({
  lang,
  mission,
  cards,
  missions,
  projectNames,
  ran,
  totals,
  pricingEnabled,
  usageHref,
  viewerRole,
}: {
  lang: string;
  mission: BoardMissionOption;
  cards: BoardCard[];
  missions: BoardMissionOption[];
  projectNames: string[];
  ran: MissionRun[];
  totals: BoardTotals;
  pricingEnabled: boolean;
  usageHref: string;
  viewerRole: ViewerRole;
}) {
  const t = dict(lang);
  const money = isLang(lang) ? lang : "en";
  const router = useRouter();
  const empty = mission.counts.total === 0;

  return (
    <div className="ms-page">
      <nav className="ms-crumbs" aria-label={t.missions.title}>
        <a href="/missions">{t.missions.title}</a>
        <span aria-hidden="true">›</span>
        <span className="ms-crumb-here" aria-current="page">
          {mission.title}
        </span>
      </nav>

      <MissionHeader
        mission={mission}
        t={t}
        className="mission-header mp-header"
        onDeleted={() => router.push("/missions")}
      >
        <div className="mp-head">
          <div>
            <h1 className="ms-title">
              {mission.title} <MissionStatus status={mission.status} t={t} />
            </h1>
            {mission.objective.trim() ? (
              <Markdown text={mission.objective} className="mp-objective" />
            ) : (
              <p className="mp-objective">{t.board.missionNoObjective}</p>
            )}
            <div className="mp-stats">
              {pricingEnabled ? (
                <span>
                  <b>{totals.costUsd !== null ? formatMoney(totals.costUsd, money) : "—"}</b>
                  {t.missions.cost}
                </span>
              ) : null}
              <span>
                <b>{formatTokens(totals.tokens)}</b>
                {t.missions.tokens}
              </span>
              <span>
                <b>{formatDuration(totals.durationMs)}</b>
                {t.missions.runtime}
              </span>
              <a className="ms-btn" href={usageHref}>
                {t.missions.seeUsage}
                <Icon name="chevronRight" label={null} size={12} />
              </a>
            </div>
            {ran.length > 0 ? (
              <p className="mp-ran" title={t.missions.ranTitle}>
                <span className="mp-ran-label">{t.missions.ran}</span>
                {ran.map((record) => (
                  <span
                    key={`${record.cli}\u0000${record.model}\u0000${record.effort}`}
                    className="mp-rec"
                  >
                    <CliMark cli={record.cli} />
                    {record.model ?? record.cli}
                    {record.effort ? <span className="mp-eff">· {record.effort}</span> : null}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
          <div className="mp-side">
            {empty ? (
              <p className="mp-note">{t.missions.emptyProgress}</p>
            ) : (
              <>
                <MissionProgressBar counts={mission.counts} t={t} size="lg" />
                <p className="mp-note">{t.missions.projectsNote(projectNames)}</p>
              </>
            )}
          </div>
        </div>
        <details className="mp-context" open={empty || undefined}>
          <summary>
            <span className="mp-chev">
              <Icon name="chevronRight" label={null} size={12} />
            </span>
            {t.board.missionContext}
          </summary>
          <div className="mp-context-body">
            {mission.context.trim() ? (
              <Markdown text={mission.context} />
            ) : (
              <p>{t.board.missionNoContext}</p>
            )}
          </div>
        </details>
        {viewerRole === "member" ? (
          <p className="mp-only-yours">{t.missions.onlyYours}</p>
        ) : null}
      </MissionHeader>

      <div className="mp-board">
        {empty ? (
          <section className="ms-empty">
            <h2>{t.missions.noCards}</h2>
            <p>{t.missions.noCardsBody(mission.title)}</p>
          </section>
        ) : (
          <Board
            cards={cards}
            lang={lang}
            missions={missions}
            showProject
            viewerRole={viewerRole}
          />
        )}
      </div>
    </div>
  );
}
