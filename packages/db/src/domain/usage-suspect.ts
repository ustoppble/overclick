import type { SegmentedUsage } from "./usage";

/**
 * A claim can legitimately read a large cached prompt very quickly, but it
 * cannot produce an unbounded number of tokens. These ceilings are purposely
 * generous: they catch a whole-session total without second-guessing ordinary
 * runs. The one-minute floor keeps very fast integration/delivery round trips
 * from being flagged just because the server window is only a few milliseconds.
 */
export const MIN_USAGE_WINDOW_MS = 60_000;
export const MAX_TOTAL_TOKENS_PER_SECOND = 50_000;
export const MAX_OUTPUT_TOKENS_PER_SECOND = 2_000;

export type UsageWindowCheck = {
  suspect: boolean;
  totalTokens: number;
  outputTokens: number;
  windowMs: number;
};

function counter(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The tokens the machine had to process: input, output and the writes that
 * built the cache. Cache READS are left out on purpose — a read is a prefix
 * that already exists being handed back, so it scales with how many requests
 * a run makes, not with how long the run had to work. Counting it made the
 * ceiling meaningless: measured over 1035 attempts, the per-second rate with
 * reads has a median of 11,944 and a p90 of 41,104, which put the 50,000
 * ceiling at the 91st percentile and marked 29% of the board suspect. The
 * same measure without reads has a median of 384 and a p90 of 1,020.
 *
 * Falls back to the flat counters when a run has no segments: `tokens_cache`
 * merges reads and writes into one field, so there the old behaviour stands
 * rather than a guess about which half it was.
 */
function processedTokens(usage: SegmentedUsage): number {
  const segments = usage.segments;
  if (!segments || segments.length === 0) {
    return (
      counter(usage.tokens_in) +
      counter(usage.tokens_out) +
      counter(usage.tokens_cache)
    );
  }
  let processed = 0;
  for (const segment of segments) {
    processed +=
      counter(segment.input) +
      counter(segment.output) +
      counter(segment.cache_write);
  }
  return processed;
}

/**
 * Tests whether the reported counters could fit between claim and delivery.
 * The resolved usage shape already mirrors segments into the flat counters,
 * so reading the flat values avoids counting the same tokens twice.
 */
export function checkUsageWindow(
  usage: SegmentedUsage | null | undefined,
  measuredWindowMs: number,
): UsageWindowCheck {
  const windowMs = Math.max(MIN_USAGE_WINDOW_MS, measuredWindowMs, 0);
  const totalTokens = usage ? processedTokens(usage) : 0;
  const outputTokens = counter(usage?.tokens_out);
  const seconds = windowMs / 1_000;
  const suspect =
    totalTokens > seconds * MAX_TOTAL_TOKENS_PER_SECOND ||
    outputTokens > seconds * MAX_OUTPUT_TOKENS_PER_SECOND;

  return { suspect, totalTokens, outputTokens, windowMs };
}
