import type React from "react";
import type { GroupInsight } from "../../lib/insights";
import type { InsightsCopy } from "./copy";
import { formatMoney, formatTokens } from "../../lib/format";
import { trendValue, type DailyTrend } from "./trend";

/**
 * The visual layer of the page: pure markup, server-rendered, no JS.
 * Every bar carries a title so the exact number is one hover away.
 */

export function TrendChart({
  trend,
  t,
}: {
  trend: DailyTrend;
  t: InsightsCopy;
}) {
  const { points, metric } = trend;
  const fmt =
    metric === "cost" ? (v: number) => formatMoney(v, t.lang) : formatTokens;
  if (points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <div className="ins-trend">
      <div
        className="ins-trend-bars"
        role="img"
        aria-label={metric === "cost" ? t.trendCostTitle : t.trendTokensTitle}
        style={{ "--ins-points": points.length } as React.CSSProperties}
      >
        {points.map((p) => {
          const v = trendValue(p, metric);
          const h =
            v > 0 && trend.max > 0
              ? Math.max(3, Math.round((v / trend.max) * 100))
              : 0;
          return (
            <div
              key={p.dayKey}
              className="ins-trend-col"
              title={`${p.label} · ${fmt(v)} · ${t.trendAttempts(p.attempts)}`}
            >
              <div
                className={v > 0 ? "ins-bar" : "ins-bar-zero"}
                style={{ height: `${h}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="ins-trend-axis">
        <span>{first.label}</span>
        <span>{last.label}</span>
      </div>
    </div>
  );
}

export function ShareBars({
  rows,
  pricingEnabled,
  t,
}: {
  rows: GroupInsight[];
  pricingEnabled: boolean;
  t: InsightsCopy;
}) {
  // Null means this row has no figure at all. It keeps its line, with no bar
  // and no share: a model nobody priced is not a model that cost nothing, and
  // it must not push everyone else's percentage up either.
  const value = (r: GroupInsight): number | null =>
    pricingEnabled ? r.costUsd : r.tokens;
  const fmt =
    pricingEnabled ? (v: number) => formatMoney(v, t.lang) : formatTokens;
  // A group that spent no tokens is not a share of consumption; it belongs
  // in the honesty note, not as an empty bar at the bottom of the list.
  const consumed = rows.filter((r) => r.tokens > 0);
  const sum = consumed.reduce((acc, r) => acc + (value(r) ?? 0), 0);
  const max = consumed.reduce((acc, r) => Math.max(acc, value(r) ?? 0), 0);
  return (
    <div className="ins-share">
      {consumed.map((r) => {
        const v = value(r);
        const pct = v != null && sum > 0 ? Math.round((v / sum) * 100) : 0;
        const w = v != null && max > 0 ? (v / max) * 100 : 0;
        const name = r.label ?? t.noModel;
        return (
          <div className="ins-share-row" key={r.key}>
            <span className="ins-share-name" title={name}>
              {name}
            </span>
            <span className="ins-share-track">
              <span
                className="ins-share-fill"
                style={{
                  width: `${w}%`,
                  opacity: 0.35 + 0.65 * (v != null && max > 0 ? v / max : 0),
                }}
              />
            </span>
            <span className={`ins-share-val${v == null ? " ins-dim" : ""}`}>
              {v == null
                ? r.unpricedTokens > 0
                  ? t.costNoPrice
                  : t.costNotReported
                : fmt(v)}
            </span>
            <span className="ins-share-pct">
              {v == null ? t.sourceNone : `${pct}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
