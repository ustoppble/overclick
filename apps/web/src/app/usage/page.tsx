import { and, asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { mission, project } from "@agent-board/db";
import { Icon } from "../../components/icon";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { CliMark } from "../../components/cli-mark";
import { Wordmark } from "../../components/wordmark";
import {
  NO_MISSION,
  boardFilterFromQuery,
  filterBoardCards,
} from "../../lib/board-filter";
import { getSession } from "../../lib/cookies";
import { missionScope, projectScope } from "../../lib/scope";
import { pagePrincipal } from "../../lib/web-scope";
import { dict } from "../../lib/i18n";
import { db } from "../../lib/db";
import {
  computeInsights,
  filterMissionAttempts,
  loadInsightAttemptRows,
  loadMissionAttemptRows,
  loadReopenRows,
  type CombinedGroupInsight,
  type GroupInsight,
  type ModelReopenInsight,
  type UsageTotals,
} from "../../lib/insights";
import { modelHarness, type ModelHarness } from "../../lib/model-harness";
import { loadModelPrices } from "../../lib/prices";
import { ShareBars, TrendChart } from "./charts";
import { insightsCopy, type InsightsCopy } from "./copy";
import { CostTable } from "./cost-table";
import {
  formatDuration,
  formatElapsed,
  formatMoney,
  formatMoneyOrNone,
  formatRate,
  formatTokens,
} from "../../lib/format";
import { buildDailyTrend } from "./trend";
import { USAGE_TABS, usageTab, usageTabHref, usageTables, type UsageBlock } from "./tabs";

export const dynamic = "force-dynamic";

/** A query param that was given once, or not at all. */
function one(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/**
 * What this page is counting, in words, when it is not counting everything.
 * A number that answers a filter has to say which filter, or it reads as the
 * whole workspace and lies by omission.
 */
function describeFilter(
  filter: {
    projectIds: string[];
    missionId: string | null;
    types: string[];
    priorities: string[];
    resolvedIn?: string | null;
  },
  t: InsightsCopy,
): string | null {
  const parts: string[] = [];
  if (filter.projectIds.length > 0) {
    parts.push(t.filterProjects(filter.projectIds.length));
  }
  if (filter.missionId === NO_MISSION) parts.push(t.filterNoMission);
  else if (filter.missionId) parts.push(t.filterMission);
  if (filter.types.length > 0) parts.push(t.filterTypes(filter.types));
  if (filter.priorities.length > 0) {
    parts.push(t.filterPriorities(filter.priorities));
  }
  if (filter.resolvedIn === null) parts.push(t.filterNoRelease);
  else if (filter.resolvedIn) parts.push(t.filterRelease(filter.resolvedIn));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "2 estimated · 1 usage not reported", or the all-clear. Never a silent sum. */
function honestyNote(totals: UsageTotals, t: InsightsCopy): string {
  const parts: string[] = [];
  if (totals.estimated > 0) parts.push(t.estimatedCount(totals.estimated));
  if (totals.missing > 0) parts.push(t.missingCount(totals.missing));
  if (totals.zeroUsage > 0) parts.push(t.zeroUsageCount(totals.zeroUsage));
  if (totals.suspect > 0) parts.push(t.suspectCount(totals.suspect));
  if (totals.deliveryUnverified > 0) {
    parts.push(t.unverifiedCount(totals.deliveryUnverified));
  }
  return parts.length > 0 ? parts.join(" · ") : t.allReported;
}

/** Where the dollars in a sum came from: computed, reported, or estimated. */
function sourceNote(totals: UsageTotals, t: InsightsCopy): string {
  const parts: string[] = [];
  if (totals.costComputed > 0) parts.push(t.computedCount(totals.costComputed));
  if (totals.costReported > 0) parts.push(t.reportedCount(totals.costReported));
  if (totals.costEstimated > 0) parts.push(t.estimatedCount(totals.costEstimated));
  if (totals.costUnpriced > 0) parts.push(t.unpricedCount(totals.costUnpriced));
  return parts.length > 0 ? parts.join(" · ") : t.noCostSource;
}

/** One visible key per panel: the symbols on values are explained in place. */
function SymbolsLegend({ t }: { t: InsightsCopy }) {
  return <p className="ins-legend">{t.symbolsLegend}</p>;
}

/**
 * The qualifiers a table's rows carry, as one quiet line under it. Markers on
 * the values point here; every count the old inline badges showed is named in
 * full, per row, out of the numeric columns.
 */
function GroupFootnote({
  rows,
  fallbackLabel,
  pricingEnabled,
  showUnpriced,
  showUnverified,
  t,
}: {
  rows: GroupTableRow[];
  fallbackLabel: string;
  pricingEnabled: boolean;
  /** Only the by-model table names the models without a price row. */
  showUnpriced: boolean;
  /** Executor/model tables surface deliveries without a verified commit. */
  showUnverified: boolean;
  t: InsightsCopy;
}) {
  const name = (r: GroupInsight) => r.label ?? fallbackLabel;
  const qualifierRows = rows.filter(
    (row) => !row.lineLabel || row.combinedTotal,
  );
  const items: string[] = [];
  const estimated = qualifierRows.filter((r) => r.estimated > 0);
  if (estimated.length > 0) {
    items.push(
      t.footEstimated(
        estimated.map((r) => `${name(r)} ×${r.estimated}`).join(" · "),
      ),
    );
  }
  const missing = qualifierRows.filter((r) => r.missing > 0);
  if (missing.length > 0) {
    items.push(
      t.footMissing(missing.map((r) => `${name(r)} ×${r.missing}`).join(" · ")),
    );
  }
  const zeroUsage = qualifierRows.filter((r) => r.zeroUsage > 0);
  if (zeroUsage.length > 0) {
    items.push(
      t.footZeroUsage(
        zeroUsage.map((r) => `${name(r)} ×${r.zeroUsage}`).join(" · "),
      ),
    );
  }
  const suspect = qualifierRows.filter((r) => r.suspect > 0);
  if (suspect.length > 0) {
    items.push(
      t.footSuspect(
        suspect
          .map((r) => `${name(r)} ${t.suspectSeparate(formatTokens(r.suspectTokens))}`)
          .join(" · "),
      ),
    );
  }
  const elapsed = qualifierRows.filter((r) => r.elapsedOnly > 0);
  if (elapsed.length > 0) {
    items.push(
      t.footElapsed(
        elapsed
          .map((r) => `${name(r)} ${t.elapsedTag(formatElapsed(r.elapsedMs))}`)
          .join(" · "),
      ),
    );
  }
  if (showUnpriced && pricingEnabled) {
    const unpriced = qualifierRows.filter((r) => r.costUnpriced > 0);
    if (unpriced.length > 0) {
      items.push(t.footUnpriced(unpriced.map(name).join(", ")));
    }
  }
  if (showUnverified) {
    const unverified = qualifierRows.filter((r) => r.deliveryUnverified > 0);
    if (unverified.length > 0) {
      items.push(
        t.footUnverified(
          unverified
            .map((r) => `${name(r)} ×${r.deliveryUnverified}`)
            .join(" · "),
        ),
      );
    }
  }
  if (items.length === 0) return null;
  return (
    <p className="ins-foot">
      {items.map((item) => (
        <span key={item} className="ins-foot-item">
          {item}
        </span>
      ))}
    </p>
  );
}

type GroupTableRow = GroupInsight & {
  /** The parent group name when this is an execution/orchestration/total line. */
  groupLabel?: string;
  lineLabel?: string;
  combinedTotal?: boolean;
};

function combinedRows(
  groups: CombinedGroupInsight[],
  t: InsightsCopy,
): GroupTableRow[] {
  const rows: GroupTableRow[] = [];
  for (const group of groups) {
    const collapsed =
      group.orchestration.tokens === 0 &&
      group.orchestration.durationMs === 0 &&
      group.orchestration.attempts === 0;
    if (collapsed) {
      rows.push({
        ...group.total,
        key: `${group.key}:total`,
        label: group.label,
        groupLabel: group.label ?? "",
        lineLabel: undefined,
        combinedTotal: false,
      });
      continue;
    }
    rows.push(
      {
        ...group.execution,
        key: `${group.key}:execution`,
        label: group.label,
        groupLabel: group.label ?? "",
        lineLabel: t.executionLine,
        combinedTotal: false,
      },
      {
        ...group.orchestration,
        key: `${group.key}:orchestration`,
        label: group.label,
        groupLabel: group.label ?? "",
        lineLabel: t.orchestrationLine,
        combinedTotal: false,
      },
      {
        ...group.total,
        key: `${group.key}:total`,
        label: group.label,
        groupLabel: group.label ?? "",
        lineLabel: t.totalLine,
        combinedTotal: true,
      },
    );
  }
  return rows;
}

function GroupTable({
  rows,
  fallbackLabel,
  t,
  pricingEnabled,
  showUnpriced = false,
  showUnverified = false,
  harness,
}: {
  rows: GroupTableRow[];
  fallbackLabel: string;
  t: InsightsCopy;
  /** Only the by-model table: the CLI and the effort each model ran with. */
  harness?: Map<string, ModelHarness>;
  /** Money is opt-in: with it off the cost column is not there at all. */
  pricingEnabled: boolean;
  showUnpriced?: boolean;
  showUnverified?: boolean;
}) {
  return (
    <>
      <div className="ins-scroll">
        <table className="ins-table">
          <colgroup>
            <col />
            {harness ? <col className="ins-col-harness" /> : null}
            {harness ? <col className="ins-col-harness" /> : null}
            {pricingEnabled ? <col className="ins-col-cost" /> : null}
            <col className="ins-col-tokens" />
            <col className="ins-col-time" />
            <col className="ins-col-attempts" />
            {showUnverified ? <col className="ins-col-attempts" /> : null}
          </colgroup>
          <thead>
            <tr>
              <th>{t.colName}</th>
              {harness ? <th>{t.colCli}</th> : null}
              {harness ? <th>{t.colEffort}</th> : null}
              {pricingEnabled ? <th className="num">{t.colCost}</th> : null}
              <th className="num">{t.colTokens}</th>
              <th className="num">{t.colTime}</th>
              <th className="num">{t.colAttempts}</th>
              {showUnverified ? <th className="num">{t.colUnverified}</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const name = row.label ?? fallbackLabel;
              const groupName = row.groupLabel ?? name;
              return (
                <tr key={row.key}>
                  <td>
                    <span
                      className={`ins-name${row.label ? "" : " ins-dim"}`}
                      title={row.lineLabel ? `${groupName} · ${row.lineLabel}` : name}
                    >
                      {row.lineLabel ? (
                        <>
                          <span>{groupName}</span>
                          <span className="ins-group-line">{row.lineLabel}</span>
                        </>
                      ) : (
                        name
                      )}
                    </span>
                  </td>
                  {harness ? <HarnessCells entry={harness.get(row.label ?? "")} t={t} /> : null}
                  {/* A row the board could not price says so. A zero here
                      would read as free work and shrink every comparison it
                      takes part in. */}
                  {pricingEnabled ? (
                    <td className="num">
                      {row.costUsd != null ? (
                        <>
                          <b>{formatMoney(row.costUsd, t.lang)}</b>
                          {row.unpricedTokens > 0 ? (
                            <span
                              className="ins-mark"
                              title={t.noPriceTitle(formatTokens(row.unpricedTokens))}
                            >
                              ⌀
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span
                          className="ins-dim"
                          title={
                            row.unpricedTokens > 0
                              ? t.noPriceTitle(formatTokens(row.unpricedTokens))
                              : undefined
                          }
                        >
                          {/* No price and nothing reported are two different
                              silences, and only one of them is somebody's
                              missing row in Settings. */}
                          {row.unpricedTokens > 0
                            ? t.costNoPrice
                            : t.costNotReported}
                        </span>
                      )}
                    </td>
                  ) : null}
                  <td className="num">
                    {formatTokens(row.tokens)}
                    {row.estimated > 0 ||
                    row.missing > 0 ||
                    row.zeroUsage > 0 ||
                    row.suspect > 0 ? (
                      <span
                        className="ins-mark"
                        title={
                          row.suspect > 0
                            ? t.suspectSeparate(formatTokens(row.suspectTokens))
                            : row.zeroUsage > 0
                              ? t.zeroUsageCount(row.zeroUsage)
                              : honestyNote(row, t)
                        }
                      >
                        {row.suspect > 0
                          ? "!"
                          : row.missing > 0
                            ? "○"
                            : row.zeroUsage > 0
                              ? "0"
                              : "≈"}
                      </span>
                    ) : null}
                  </td>
                  {/* Execution time; the elapsed clock a row also carries is a
                      marker here and a footnote below, never added in. */}
                  <td className="num">
                    {formatDuration(row.durationMs)}
                    {row.elapsedOnly > 0 ? (
                      <span
                        className="ins-mark"
                        title={t.elapsedTag(formatElapsed(row.elapsedMs))}
                      >
                        +
                      </span>
                    ) : null}
                  </td>
                  <td className="num">{row.attempts}</td>
                  {showUnverified ? (
                    <td className="num">
                      {row.deliveryUnverified > 0 ? (
                        <span className="ins-mark" title={t.footUnverified(`${name} ×${row.deliveryUnverified}`)}>
                          {row.deliveryUnverified}
                        </span>
                      ) : (
                        "0"
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <GroupFootnote
        rows={rows}
        fallbackLabel={fallbackLabel}
        pricingEnabled={pricingEnabled}
        showUnpriced={showUnpriced}
        showUnverified={showUnverified}
        t={t}
      />
    </>
  );
}

/**
 * The CLI mark and the effort a model ran with. "—" when nothing declared
 * them: the claim records what the agent said, and the board never guesses.
 */
function HarnessCells({
  entry,
  t,
}: {
  entry: ModelHarness | undefined;
  t: InsightsCopy;
}) {
  const clis = entry?.clis ?? [];
  const efforts = entry?.efforts ?? [];
  return (
    <>
      <td className="ins-harness">
        {clis.length > 0 ? (
          clis.map((cli) => (
            <span key={cli} className="ins-harness-cli">
              <CliMark cli={cli} />
              <span className="ins-mono">{cli}</span>
            </span>
          ))
        ) : (
          <span className="ins-dim" title={t.notDeclared}>
            —
          </span>
        )}
      </td>
      <td className="ins-harness">
        {efforts.length > 0 ? (
          <span className="ins-mono">{efforts.join(" · ")}</span>
        ) : (
          <span className="ins-dim" title={t.notDeclared}>
            —
          </span>
        )}
      </td>
    </>
  );
}

function ReopenTable({
  rows,
  t,
}: {
  rows: ModelReopenInsight[];
  t: InsightsCopy;
}) {
  if (rows.length === 0) {
    return <p className="ins-dim">{t.emptyReopens}</p>;
  }
  return (
    <div className="ins-scroll">
      <table className="ins-table ins-table-slim">
        <colgroup>
          <col />
          <col className="ins-col-deliveries" />
          <col className="ins-col-deliveries" />
          <col className="ins-col-rate" />
        </colgroup>
        <thead>
          <tr>
            <th>{t.colModel}</th>
            <th className="num">{t.colDeliveries}</th>
            <th className="num">{t.colReopened}</th>
            <th className="num">{t.colRate}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const name = row.model ?? t.noModel;
            return (
              <tr key={row.model ?? "__unknown__"}>
                <td>
                  <span
                    className={`ins-name ins-mono${row.model ? "" : " ins-dim"}`}
                    title={name}
                  >
                    {name}
                  </span>
                </td>
                <td className="num">{row.deliveries}</td>
                <td className="num">{row.reopened}</td>
                <td className="num">
                  <b>{formatRate(row.rate)}</b>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const principal = await pagePrincipal(session);

  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");

  // No price table to read when the money layer is off: there is nothing on
  // this page for it to fill.
  const [attemptRows, missionAttemptRows, reopenRows, prices, params] = await Promise.all([
    loadInsightAttemptRows(db(), ws.id, principal),
    loadMissionAttemptRows(db(), ws.id, principal),
    loadReopenRows(db(), ws.id, principal),
    ws.pricingEnabled ? loadModelPrices(db(), ws.id) : Promise.resolve([]),
    searchParams,
  ]);

  // The board hands its filter over in the link. Same filter, same rows, same
  // aggregation: the total on the topbar and the numbers here are one answer.
  const [projectRows, missionRows] = await Promise.all([
    db()
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.workspaceId, ws.id), projectScope(principal)))
      .orderBy(asc(project.createdAt)),
    db()
      .select({ id: mission.id })
      .from(mission)
      .where(and(eq(mission.workspaceId, ws.id), missionScope(principal))),
  ]);
  const t = insightsCopy(ws.language);
  // The wordmark is shared chrome, so its label comes from the shared
  // dictionary and not from this page's own copy.
  const shared = dict(ws.language);
  const filter = boardFilterFromQuery(
    {
      projects: one(params.projects),
      mission: one(params.mission),
      types: one(params.types),
      priorities: one(params.priorities),
      release: one(params.release),
    },
    projectRows,
    missionRows,
  );
  const filtered = filterBoardCards(attemptRows, filter);
  const filteredMissionAttempts = filterMissionAttempts(missionAttemptRows, filter);
  const filterNote = describeFilter(filter, t);

  const insights = computeInsights(
    filtered,
    reopenRows,
    prices,
    filteredMissionAttempts,
  );
  const switchedRuns = insights.switchedRuns;
  const pricingEnabled = ws.pricingEnabled;
  const { totals } = insights;
  const trend = buildDailyTrend([...filtered, ...filteredMissionAttempts], {
    prices,
    pricingEnabled,
    lang: ws.language ?? "en",
  });
  const trendFmt =
    trend.metric === "cost"
      ? (v: number) => formatMoney(v, t.lang)
      : formatTokens;
  const unpricedModels = insights.byModel.filter((r) => r.costUnpriced > 0);
  const tab = usageTab(params.by);
  const blocks = new Set<UsageBlock>(usageTables(tab));
  const harness = modelHarness(filtered);
  // The scope and the period this page was opened with ride on every tab link.
  const keep = Object.fromEntries(
    Object.entries(params).filter(([key]) => key !== "by"),
  );
  const tabLabels: Record<(typeof USAGE_TABS)[number], string> = {
    overview: t.tabOverview,
    project: t.tabProject,
    mission: t.tabMission,
    agent: t.tabAgent,
    model: t.tabModel,
    release: t.tabRelease,
    card: t.tabCard,
  };

  return (
    <div className="nb nebula-surface">
      <NebulaAtmosphere />

      <div className="page ins-page">
        <header className="ins-topbar-wrap">
          <div className="ins-topbar-l1">
            <Wordmark label={shared.board.homeLink} />
            <div className="spacer" />
            {/* The arrow was a character inside the label; it is the set's own
                glyph now, silent because the word beside it says where it goes. */}
            <a className="btn-ghost ins-back" href="/home">
              <Icon name="back" label={null} size={14} />
              {t.backToBoard}
            </a>
          </div>
          <div className="ins-topbar-l2">
            <div className="crumb">
              {ws.name} / <b>{t.title}</b>
            </div>
          </div>
        </header>

        {/* Title, what the page counts and the filter that qualifies both are
            one group with one gap, instead of three margins that had to be
            corrected against each other whenever the filter appeared. */}
        <header className="ins-head">
          <h1>{t.title}</h1>
          <p className="page-sub">{t.sub}</p>
          {filterNote ? (
            <p className="ins-filter">
              {t.filteredBy} <b>{filterNote}</b>{" "}
              <a
                href={usageTabHref(tab, {
                  period: params.period,
                  periodBy: params.periodBy,
                })}
              >
                <Icon name="clear" label={null} size={12} />
                {t.clearFilter}
              </a>
            </p>
          ) : null}
        </header>

        {/* One cut of the answer at a time. A tab is a link: F5 keeps it, the
            browser's Back leaves it, and the scope and period stay on it. */}
        <nav className="usage-tabs" aria-label={t.tabsLabel}>
          {USAGE_TABS.map((id) => (
            <a
              key={id}
              href={usageTabHref(id, keep)}
              aria-current={tab === id ? "page" : undefined}
              className={tab === id ? "on" : ""}
            >
              {tabLabels[id]}
            </a>
          ))}
        </nav>

        {totals.attempts === 0 ? (
          /* An empty page is a state, not a missing one: it says what is
             missing, what fills it, and offers the one way to go do that. */
          <div className="ins-empty nebula-glass">
            <Icon name="empty" label={null} size={26} className="ins-empty-icon" />
            <p className="ins-empty-title">{t.emptyTitle}</p>
            <p className="ins-empty-body">{t.empty}</p>
            <a className="btn-ghost ins-empty-cta" href="/home">
              <Icon name="back" label={null} size={14} />
              {t.emptyCta}
            </a>
          </div>
        ) : (
          <>
            {blocks.has("totals") ? (<>
            <div className="ins-tiles">
              {/* Tokens and time first: they are true on every plan. Money is
                  a layer this workspace switched on, or it is simply absent. */}
              <div className="ins-tile nebula-glass">
                <div className="ins-lbl">{t.totalTokens}</div>
                <div className="ins-num">{formatTokens(totals.tokens)}</div>
                <div className="ins-note">{honestyNote(totals, t)}</div>
              </div>
              <div className="ins-tile nebula-glass">
                <div className="ins-lbl">{t.totalTime}</div>
                <div className="ins-num">{formatDuration(totals.durationMs)}</div>
                {/* Time the cards sat claimed is not time anyone worked, so it
                    is named apart instead of swelling the number above. */}
                {totals.elapsedOnly > 0 ? (
                  <div className="ins-note">
                    {t.elapsedNote(
                      formatElapsed(totals.elapsedMs),
                      totals.elapsedOnly,
                    )}
                  </div>
                ) : null}
              </div>
              {pricingEnabled ? (
                <div className="ins-tile nebula-glass">
                  <div className="ins-lbl">{t.totalCost}</div>
                  {/* Nothing priced means no figure, not a figure of zero. */}
                  <div className="ins-num">
                    {formatMoneyOrNone(
                      totals.costUsd,
                      totals.unpricedTokens > 0
                        ? t.costNoPrice
                        : t.costNotReported,
                      t.lang,
                    )}
                  </div>
                  <div className="ins-note">{sourceNote(totals, t)}</div>
                  {/* What the total leaves out, said in the unit it can be
                      said in: tokens the price table cannot turn into money. */}
                  {totals.unpricedTokens > 0 ? (
                    <div className="ins-note">
                      {t.unpricedTokensNote(formatTokens(totals.unpricedTokens))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="ins-tile nebula-glass">
                <div className="ins-lbl">{t.attempts}</div>
                <div className="ins-num">{totals.attempts}</div>
              </div>
            </div>

            <div className="ins-subtotals nebula-glass" aria-label={t.totalCost}>
              <span>
                {t.executionSubtotal(
                  formatTokens(insights.executionTotals.tokens),
                  formatDuration(insights.executionTotals.durationMs),
                  insights.executionTotals.attempts,
                )}
              </span>
              <span>
                {t.orchestrationSubtotal(
                  formatTokens(insights.orchestrationTotals.tokens),
                  formatDuration(insights.orchestrationTotals.durationMs),
                  insights.orchestrationTotals.attempts,
                )}
              </span>
            </div>

            </>) : null}

            {blocks.has("charts") ? (
            <div className="ins-charts">
              {/* the plot grows to meet the panel beside it instead of
                  leaving a band of empty glass under four days of bars */}
              <section className="ins-panel ins-panel-trend nebula-glass">
                <div className="ins-cap">
                  <span>
                    {trend.metric === "cost"
                      ? t.trendCostTitle
                      : t.trendTokensTitle}
                  </span>
                  <span className="ins-cap-note">
                    {trend.peak
                      ? `${t.trendPeak(trendFmt(trend.max), trend.peak.label)} · ${t.trendDays(trend.points.length)}`
                      : t.trendDays(trend.points.length)}
                  </span>
                </div>
                <TrendChart trend={trend} t={t} />
              </section>
              <section className="ins-panel nebula-glass">
                <div className="ins-cap">
                  <span>
                    {pricingEnabled ? t.shareCostTitle : t.shareTokensTitle}
                  </span>
                  <span className="ins-cap-note">{t.shareNote}</span>
                </div>
                <ShareBars
                  rows={insights.combinedGroups.byModel.map((group) => group.total)}
                  pricingEnabled={pricingEnabled}
                  t={t}
                />
                {/* Runs that switched model split their tokens but not their
                    clock: say so instead of letting the times look additive. */}
                {switchedRuns > 0 ? (
                  <p className="ins-foot">{t.sharedModelsNote(switchedRuns)}</p>
                ) : null}
                {pricingEnabled && unpricedModels.length > 0 ? (
                  <p className="ins-foot">
                    <span className="ins-foot-item">
                      {t.footUnpriced(
                        unpricedModels.map((r) => r.label ?? t.noModel).join(", "),
                      )}
                    </span>
                  </p>
                ) : null}
              </section>
            </div>
            ) : null}

            <div className="ins-grid">
              {blocks.has("project") ? (
              <section className="ins-panel nebula-glass">
                <div className="ins-cap">
                  <span>{t.byProject}</span>
                </div>
                <GroupTable
                  rows={combinedRows(insights.combinedGroups.byProject, t)}
                  fallbackLabel="—"
                  t={t}
                  pricingEnabled={pricingEnabled}
                />
                <SymbolsLegend t={t} />
              </section>
              ) : null}
              {blocks.has("mission") ? (
              <section className="ins-panel nebula-glass">
                <div className="ins-cap">
                  <span>{t.byMission}</span>
                </div>
                <GroupTable
                  rows={combinedRows(insights.combinedGroups.byMission, t)}
                  fallbackLabel={t.noMission}
                  t={t}
                  pricingEnabled={pricingEnabled}
                />
                <SymbolsLegend t={t} />
              </section>
              ) : null}
              {blocks.has("agent") ? (
              <section className="ins-panel nebula-glass">
                <div className="ins-cap">
                  <span>{t.byExecutor}</span>
                </div>
                <GroupTable
                  rows={insights.byExecutor}
                  fallbackLabel="—"
                  t={t}
                  pricingEnabled={pricingEnabled}
                  showUnverified
                />
                <SymbolsLegend t={t} />
              </section>
              ) : null}
              {blocks.has("model") ? (
              <section className="ins-panel nebula-glass">
                <div className="ins-cap">
                  <span>{t.byModel}</span>
                </div>
                <GroupTable
                  rows={combinedRows(insights.combinedGroups.byModel, t)}
                  fallbackLabel={t.noModel}
                  t={t}
                  pricingEnabled={pricingEnabled}
                  showUnpriced
                  showUnverified
                  harness={harness}
                />
                <SymbolsLegend t={t} />
                <p className="ins-foot">{t.modelFromRecord}</p>
              </section>
              ) : null}
              {blocks.has("model") ? (
              <section className="ins-panel nebula-glass">
                <div className="ins-cap">
                  <span>{t.reopenedByModel}</span>
                </div>
                <ReopenTable rows={insights.reopensByModel} t={t} />
              </section>
              ) : null}
              {blocks.has("release") ? (
              <section className="ins-panel nebula-glass">
                <div className="ins-cap">
                  <span>{t.byRelease}</span>
                </div>
                <GroupTable
                  rows={insights.byRelease}
                  fallbackLabel={t.noRelease}
                  t={t}
                  pricingEnabled={pricingEnabled}
                />
                <SymbolsLegend t={t} />
              </section>
              ) : null}
            </div>

            {blocks.has("card") ? (
            <section className="ins-panel nebula-glass ins-cards">
              <div className="ins-cap">
                <span>{pricingEnabled ? t.perCard : t.perCardNoMoney}</span>
                {pricingEnabled ? (
                  <span className="ins-cap-note">{t.pricesNote}</span>
                ) : null}
              </div>
              <CostTable
                cards={insights.perCard}
                lang={ws.language}
                pricingEnabled={pricingEnabled}
              />
              <SymbolsLegend t={t} />
            </section>
            ) : null}
          </>
        )}
      </div>

      <div className="nebula-glass-fade viewport-fade" aria-hidden="true" />
    </div>
  );
}
