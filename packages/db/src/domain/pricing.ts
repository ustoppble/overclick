/**
 * Model prices and the arithmetic the board owns.
 *
 * Tokens are the fact an agent reports; dollars are arithmetic. Everything
 * here is pure so the web app, the MCP layer and the tests share one answer.
 */

import {
  segmentTokenCounts,
  segmentTotalTokens,
  type UsageSegment,
} from "./usage";

/** One model's price, in US dollars per million tokens. */
export type ModelPrice = {
  /** Normalized key (see normalizeModelKey). */
  model: string;
  /** Display name, as the price list or the human wrote it. */
  label: string;
  inputPerMtok: number;
  outputPerMtok: number;
  /**
   * Price applied to the `tokens_cache` counter the usage contract carries.
   * Seeded at the cache READ rate, which is what a long agent session is
   * mostly made of; edit the row when your provider bills you otherwise.
   */
  cachePerMtok: number;
};

/** A seeded entry: the price plus the day that price was read off the list. */
type SeedPrice = ModelPrice & { seededAt: string };

/** Where a price came from: the seeded public list, or a human edit. */
export type PriceSource = "seed" | "custom";

/** A price row as the board shows it: the numbers plus their provenance. */
export type ModelPriceRow = ModelPrice & {
  source: PriceSource;
  /** Date the seeded public prices were captured. Null on an edited row. */
  seededAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

/**
 * Spellings emitted by CLIs that are not the key used by the price table.
 *
 * Keep this list explicit even when the generic punctuation/provider cleanup
 * below happens to reach the same answer. It is the audit trail for aliases
 * the board promises to understand, and every caller goes through this one
 * table instead of growing its own special case.
 */
export const MODEL_KEY_ALIASES: Readonly<Record<string, string>> = {
  "gpt-5-codex": "gpt-5-3-codex-spark",
  "gpt-5.3-codex-spark": "gpt-5-3-codex-spark",
  "openai/gpt-5.3-codex-spark": "gpt-5-3-codex-spark",
  "codex/gpt-5.3-codex-spark": "gpt-5-3-codex-spark",
  "gpt-5.6-sol": "gpt-5-6-sol",
  "openai/gpt-5.6-sol": "gpt-5-6-sol",
  "claude-opus-5": "opus-5",
  "claude-fable-5": "fable-5",
  "claude-sonnet-5": "sonnet-5",
  "anthropic/claude-fable-5": "fable-5",
  kimi: "k3",
  "kimi-code/k3": "k3",
  "moonshot/k3": "k3",
};

/**
 * The day the first batch of prices below was read off the public lists. Kept
 * as the default stamp so a row that never moved still says how old it is.
 */
export const MODEL_PRICES_SEEDED_AT = "2026-08-16";

/**
 * The day the rest of the families this board actually runs were captured.
 * A second date instead of restamping everything: a price read a week ago is
 * a week old, and pretending otherwise is how a stale number hides.
 */
export const MODEL_PRICES_FAMILIES_SEEDED_AT = "2026-08-17";

/** Shorthand for a seeded row, so the table below reads as a table. */
const at =
  (seededAt: string) =>
  (
    model: string,
    inputPerMtok: number,
    outputPerMtok: number,
    cachePerMtok: number,
  ): SeedPrice => ({
    model,
    label: model,
    inputPerMtok,
    outputPerMtok,
    cachePerMtok,
    seededAt,
  });

const p0 = at(MODEL_PRICES_SEEDED_AT);
const p1 = at(MODEL_PRICES_FAMILIES_SEEDED_AT);

/**
 * Public list prices, per million tokens, each row carrying the day it was
 * read. Keys are normalized (see normalizeModelKey), so "claude-opus-5",
 * "opus-5" and "kimi-code/k3" all land on the row that prices them.
 *
 * Only models whose public price is published as a plain per-million rate are
 * seeded. A model the board has never been told the price of stays unpriced
 * and shows up in Settings waiting for a number: inventing a price would be
 * worse than admitting there isn't one. That is why the subscription-only
 * entries of the CLI catalog ("auto" on Cursor and Copilot) and the models
 * with no published rate are absent instead of guessed.
 */
const SEED: SeedPrice[] = [
  // Claude
  p0("fable-5", 10, 50, 1),
  p0("opus-5", 5, 25, 0.5),
  p0("opus-4-8", 5, 25, 0.5),
  p0("sonnet-5", 3, 15, 0.3),
  p0("haiku-4-5", 1, 5, 0.1),
  // OpenAI, as Codex runs them
  p1("gpt-5-6-sol", 1.75, 14, 0.175),
  p1("gpt-5-6-terra", 1.25, 10, 0.125),
  p1("gpt-5-6-luna", 0.5, 4, 0.05),
  p1("gpt-5-5", 1.25, 10, 0.125),
  p1("gpt-5-4", 2.5, 15, 0.25),
  p1("gpt-5-4-mini", 0.25, 2, 0.025),
  // GPT-5.3-Codex-Spark is now published in the public Codex/API pricing path.
  // Values below are per million tokens, matching the source line in the current
  // Codex rate card: $1.75 input, $14 output, $0.175 cache read.
  p1("gpt-5-3-codex-spark", 1.75, 14, 0.175),
  // Gemini, and the Antigravity flash tiers that bill at the flash rate
  p1("3-1-pro", 1.25, 10, 0.125),
  p1("3-5-flash", 0.3, 2.5, 0.03),
  p1("3-flash", 0.15, 0.6, 0.015),
  p1("3-7-flash-high", 0.3, 2.5, 0.03),
  p1("3-7-flash-medium", 0.3, 2.5, 0.03),
  p1("3-7-flash-low", 0.3, 2.5, 0.03),
  // Kimi
  p1("k3", 0.6, 2.5, 0.06),
  p1("k3-256k", 1.2, 5, 0.12),
  p1("kimi-for-coding", 0.6, 2.5, 0.06),
  p1("kimi-for-coding-highspeed", 1.2, 5, 0.12),
  // Grok
  p1("grok-4-6", 3, 15, 0.75),
  p1("grok-4-5", 3, 15, 0.75),
  p1("grok-composer-2-5-fast", 1.5, 7.5, 0.375),
  // Free tiers. A published zero is a price, and it is not the same thing as
  // a model nobody priced: this row says the run really cost nothing.
  p1("deepseek-v4-flash-free", 0, 0, 0),
  p1("mimo-v2-5-free", 0, 0, 0),
  p1("hy3-free", 0, 0, 0),
  p1("laguna-s-2-1-free", 0, 0, 0),
  p1("nemotron-3-ultra-free", 0, 0, 0),
  p1("nemotron-3-5-lightning-free", 0, 0, 0),
];

/** The seeded price list, each row stamped with the date it was captured. */
export function factoryModelPrices(): ModelPriceRow[] {
  return SEED.map((price) => ({
    ...price,
    source: "seed" as const,
    updatedBy: null,
    updatedAt: null,
  }));
}

/**
 * One key for the many spellings of the same model. Agents send the binary's
 * name ("claude-opus-5"), the board's catalog says "opus-5", and a dated
 * snapshot adds a suffix; all three have to hit the same price row.
 */
export function normalizeModelKey(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  const aliased = MODEL_KEY_ALIASES[lowered] ?? lowered;
  const normalized = aliased
    .replace(/^[a-z0-9_.-]+\//, "")
    .replace(/-\d{8}$/, "")
    .replace(/\./g, "-")
    .replace(/^claude-/, "");
  return MODEL_KEY_ALIASES[normalized] ?? normalized;
}

/** The stored reason beside an attempt's frozen cost snapshot. */
export type CostStatus =
  | "computed"
  | "reported"
  | "estimated"
  | "unpriced"
  | "not_reported"
  | "zero_usage"
  | "suspect";

/** One model's contribution captured when deliver/update calculated cost. */
export type CostBreakdownSegment = {
  model: string | null;
  input: number;
  output: number;
  cache: number;
  cost_usd: number | null;
  priced: boolean;
};

/** Persistable result of evaluating an attempt at one point in time. */
export type CostAssessment = ResolvedCost & {
  status: CostStatus;
  unpricedModels: string[];
  breakdown: CostBreakdownSegment[];
  normalizedSegments: UsageSegment[];
};

/** The price for a model, or null when nobody has priced it yet. */
export function findModelPrice<T extends ModelPrice>(
  prices: readonly T[],
  model: string | null | undefined,
): T | null {
  if (!model) return null;
  const key = normalizeModelKey(model);
  if (!key) return null;
  return prices.find((price) => normalizeModelKey(price.model) === key) ?? null;
}

export type TokenCounts = {
  input?: number | null;
  output?: number | null;
  cache?: number | null;
};

/** Sum of the token counters, treating a missing counter as zero. */
export function totalTokens(tokens: TokenCounts): number {
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cache ?? 0);
}

/** Dollars for these tokens at this price, rounded to the stored precision. */
export function computeCostUsd(price: ModelPrice, tokens: TokenCounts): number {
  const cost =
    ((tokens.input ?? 0) * price.inputPerMtok +
      (tokens.output ?? 0) * price.outputPerMtok +
      (tokens.cache ?? 0) * price.cachePerMtok) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * Where a dollar figure came from:
 * - `computed`: the board multiplied reported tokens by the price table
 * - `reported`: the agent sent a cost and the board had no price to compute
 * - `estimated`: same, and the agent flagged its own numbers as a guess
 */
export type CostSource = "computed" | "reported" | "estimated";

export type AttemptUsage = {
  tokensIn?: number | null;
  tokensOut?: number | null;
  tokensCache?: number | null;
  /** What the agent volunteered. Only used when the table cannot price it. */
  costUsd?: number | null;
  usageEstimated?: boolean;
};

export type ResolvedCost = {
  /** Null when nothing can be said. Never a silent zero. */
  costUsd: number | null;
  source: CostSource | null;
};

/**
 * Calculates and snapshots the cost state written on an attempt.
 *
 * `tokensReported` is deliberately separate from the sum: explicit zero
 * counters mean "the executor reported zero", while no counters mean "the
 * executor did not report usage". A priced free tier can still produce a
 * genuine computed $0 because it has spending tokens and a real zero price.
 */
export function assessAttemptCost(
  segments: readonly UsageSegment[],
  prices: readonly ModelPrice[],
  options: {
    reportedCostUsd?: number | null;
    usageEstimated?: boolean;
    usageSuspect?: boolean;
    tokensReported: boolean;
  },
): CostAssessment {
  const normalizedSegments = segments.map((segment) => ({
    ...segment,
    model: segment.model ? normalizeModelKey(segment.model) : null,
  }));
  const spending = normalizedSegments.filter(
    (segment) => segmentTotalTokens(segment) > 0,
  );
  const unpricedModels = [
    ...new Set(
      spending
        .filter((segment) => findModelPrice(prices, segment.model) == null)
        .map((segment) => segment.model ?? "unknown"),
    ),
  ];
  const breakdown: CostBreakdownSegment[] = normalizedSegments.map((segment) => {
    const counts = segmentTokenCounts(segment);
    const price = findModelPrice(prices, segment.model);
    const hasTokens = segmentTotalTokens(segment) > 0;
    return {
      model: segment.model,
      input: counts.input,
      output: counts.output,
      cache: counts.cache,
      cost_usd: hasTokens && price ? computeCostUsd(price, counts) : null,
      priced: hasTokens && price != null,
    };
  });

  const fallback = (): Pick<CostAssessment, "costUsd" | "source"> =>
    options.reportedCostUsd != null
      ? {
          costUsd: Number(options.reportedCostUsd),
          source: options.usageEstimated ? "estimated" : "reported",
        }
      : { costUsd: null, source: null };

  if (!options.tokensReported) {
    return {
      ...fallback(),
      status: options.usageSuspect ? "suspect" : "not_reported",
      unpricedModels,
      breakdown,
      normalizedSegments,
    };
  }
  if (spending.length === 0) {
    return {
      ...fallback(),
      status: options.usageSuspect ? "suspect" : "zero_usage",
      unpricedModels,
      breakdown,
      normalizedSegments,
    };
  }
  if (unpricedModels.length > 0) {
    return {
      ...fallback(),
      status: options.usageSuspect
        ? "suspect"
        : options.usageEstimated
          ? "estimated"
          : "unpriced",
      unpricedModels,
      breakdown,
      normalizedSegments,
    };
  }

  const costUsd = Math.round(
    breakdown.reduce((sum, segment) => sum + (segment.cost_usd ?? 0), 0) * 1e6,
  ) / 1e6;
  return {
    costUsd,
    source: "computed",
    status: options.usageSuspect
      ? "suspect"
      : options.usageEstimated
        ? "estimated"
        : "computed",
    unpricedModels,
    breakdown,
    normalizedSegments,
  };
}

/**
 * The cost of one attempt and the label that has to travel with it. Tokens
 * plus a price beat the agent's own number every time: the board knows the
 * current prices, and no CLI reliably does.
 */
export function resolveAttemptCost(
  attempt: AttemptUsage,
  prices: readonly ModelPrice[],
  model: string | null | undefined,
): ResolvedCost {
  const tokens: TokenCounts = {
    input: attempt.tokensIn,
    output: attempt.tokensOut,
    cache: attempt.tokensCache,
  };
  if (totalTokens(tokens) > 0) {
    const price = findModelPrice(prices, model);
    if (price) {
      return { costUsd: computeCostUsd(price, tokens), source: "computed" };
    }
  }
  if (attempt.costUsd != null) {
    return {
      costUsd: Number(attempt.costUsd),
      source: attempt.usageEstimated ? "estimated" : "reported",
    };
  }
  return { costUsd: null, source: null };
}

/**
 * The cost of a run recorded in segments: every model priced at its own rate
 * and added up, which is the only honest answer once a run switched model. The
 * figure the agent volunteered is the fallback, used when the price table
 * cannot cover every model the run touched. Splitting that one figure across
 * models would be inventing numbers, so it is never divided.
 */
export function resolveSegmentedCost(
  segments: readonly UsageSegment[],
  prices: readonly ModelPrice[],
  fallback: { costUsd?: number | null; usageEstimated?: boolean },
): ResolvedCost {
  if (areSegmentsPriced(segments, prices)) {
    let sum = 0;
    for (const segment of segments) {
      const price = findModelPrice(prices, segment.model);
      if (price) sum += computeCostUsd(price, segmentTokenCounts(segment));
    }
    return { costUsd: Math.round(sum * 1e6) / 1e6, source: "computed" };
  }
  if (fallback.costUsd != null) {
    return {
      costUsd: Number(fallback.costUsd),
      source: fallback.usageEstimated ? "estimated" : "reported",
    };
  }
  return { costUsd: null, source: null };
}

/** True when every segment that carries tokens has a price to be read at. */
export function areSegmentsPriced(
  segments: readonly UsageSegment[],
  prices: readonly ModelPrice[],
): boolean {
  const spending = segments.filter((s) => segmentTotalTokens(s) > 0);
  return (
    spending.length > 0 &&
    spending.every((s) => findModelPrice(prices, s.model) != null)
  );
}

/**
 * The label for a set of costs added together. Mixed provenance is named as
 * such instead of borrowing the most flattering one.
 */
export function mergeCostSources(
  sources: readonly (CostSource | null)[],
): CostSource | "mixed" | null {
  const present = [...new Set(sources.filter((s): s is CostSource => s != null))];
  if (present.length === 0) return null;
  if (present.length === 1) return present[0] ?? null;
  return "mixed";
}
