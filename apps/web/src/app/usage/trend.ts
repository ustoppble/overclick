import {
  normalizeUsageSegments,
  resolveSegmentedCost,
  type ModelPrice,
  type UsageSegment,
} from "@agent-board/db";
import type { InsightUsageRow } from "../../lib/insights";

/**
 * Presentation-only bucketing for the spend-over-time chart. Nothing here
 * recomputes the numbers the page already shows: tokens are the same flat
 * counters the data layer sums, and a day's cost comes from the same
 * attempt snapshot the totals use. Legacy rows without a snapshot still use
 * resolveSegmentedCost until the idempotent backfill reaches them. It only
 * groups what loadInsightAttemptRows already returned, by the day each
 * attempt finished.
 */

export type TrendPoint = {
  /** yyyy-mm-dd in the server's local time. */
  dayKey: string;
  /** Axis label, d/m or m/d depending on the workspace language. */
  label: string;
  tokens: number;
  /** Resolved cost of the day; 0 when nothing could be priced, never null. */
  costUsd: number;
  attempts: number;
};

export type DailyTrend = {
  points: TrendPoint[];
  /** What the bars measure: cost when the money layer is on, tokens otherwise. */
  metric: "cost" | "tokens";
  /** Highest daily value of the chosen metric, for bar normalization. */
  max: number;
  peak: TrendPoint | null;
};

const MAX_DAYS = 45;

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(d: Date, lang: string): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return lang === "pt-BR" ? `${day}/${m}` : `${m}/${day}`;
}

/** Mirrors the data layer's fallback: stored segments win, flat counters fold
    into one segment for the model recorded at claim time. */
function segmentsOf(a: InsightUsageRow): UsageSegment[] {
  if (a.usageSegments?.length) return a.usageSegments;
  return normalizeUsageSegments(
    {
      tokens_in: a.tokensIn ?? undefined,
      tokens_out: a.tokensOut ?? undefined,
      tokens_cache: a.tokensCache ?? undefined,
    },
    a.model,
  );
}

export function trendValue(
  point: TrendPoint,
  metric: DailyTrend["metric"],
): number {
  return metric === "cost" ? point.costUsd : point.tokens;
}

export function buildDailyTrend(
  rows: Array<InsightUsageRow & { taskIsExample?: boolean }>,
  opts: {
    prices: readonly ModelPrice[];
    pricingEnabled: boolean;
    lang: string;
    maxDays?: number;
  },
): DailyTrend {
  const { prices, pricingEnabled, lang } = opts;
  const maxDays = opts.maxDays ?? MAX_DAYS;
  const metric: DailyTrend["metric"] = pricingEnabled ? "cost" : "tokens";

  const buckets = new Map<string, TrendPoint & { date: Date }>();
  for (const a of rows) {
    // Same scope the totals use: finished attempts, example cards out.
    if (a.taskIsExample || !a.finishedAt) continue;
    const key = dayKey(a.finishedAt);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        dayKey: key,
        label: dayLabel(a.finishedAt, lang),
        tokens: 0,
        costUsd: 0,
        attempts: 0,
        date: a.finishedAt,
      };
      buckets.set(key, bucket);
    }
    bucket.attempts += 1;
    // Suspect usage has its own bucket in Insights; the trend charts only the
    // trusted totals, so a whole-session transcript cannot create a fake peak.
    if (a.usageSuspect) continue;
    bucket.tokens += (a.tokensIn ?? 0) + (a.tokensOut ?? 0) + (a.tokensCache ?? 0);
    if (pricingEnabled) {
      const frozen =
        a.costStatus != null || a.costSource != null || a.costBreakdown != null;
      const cost = frozen
        ? { costUsd: a.costUsd != null ? Number(a.costUsd) : null }
        : resolveSegmentedCost(segmentsOf(a), prices, {
            costUsd: a.costUsd != null ? Number(a.costUsd) : null,
            usageEstimated: a.usageEstimated,
          });
      // Unknown costs add zero, the same rule the totals follow.
      bucket.costUsd += cost.costUsd ?? 0;
    }
  }

  const sorted = [...buckets.values()].sort((x, y) =>
    x.dayKey < y.dayKey ? -1 : 1,
  );
  // Zero-fill the gaps so the chart reads as a timeline, not a list of days.
  const filled: (TrendPoint & { date: Date })[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    if (i > 0) {
      const prev = sorted[i - 1];
      const gap = Math.round(
        (Date.parse(`${current.dayKey}T12:00:00`) -
          Date.parse(`${prev.dayKey}T12:00:00`)) /
          86_400_000,
      );
      for (let g = 1; g < gap; g++) {
        const d = new Date(Date.parse(`${prev.dayKey}T12:00:00`) + g * 86_400_000);
        filled.push({
          dayKey: dayKey(d),
          label: dayLabel(d, lang),
          tokens: 0,
          costUsd: 0,
          attempts: 0,
          date: d,
        });
      }
    }
    filled.push(current);
  }

  const points = filled.slice(-maxDays).map(({ date: _date, ...p }) => p);
  let max = 0;
  let peak: TrendPoint | null = null;
  for (const p of points) {
    const v = trendValue(p, metric);
    if (v > max) {
      max = v;
      peak = p;
    }
  }
  return { points, metric, max, peak };
}
