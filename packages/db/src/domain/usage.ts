/**
 * Usage in segments: one entry per model that actually ran.
 *
 * A single run often switches model mid-conversation. One model plus one
 * bucket of tokens cannot say that, so it attributes everything to whichever
 * model happened to be recorded at claim time. A list of segments records what
 * happened: sonnet-5 read this many tokens, opus-5 wrote those.
 *
 * Everything here is pure so the web app, the MCP layer and the tests share
 * one answer.
 */

/** What one model spent inside a run. Counters absent when not reported. */
export type UsageSegment = {
  /** Null only when the executor never told the board which model ran. */
  model: string | null;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
};

/** The flat counters the usage contract carried before segments existed. */
export type FlatUsageTokens = {
  tokens_in?: number;
  tokens_out?: number;
  tokens_cache?: number;
};

/**
 * A usage block as it arrives over MCP: flat counters, segments, or both,
 * alongside the counters that are not about tokens and travel untouched.
 */
export type SegmentedUsage = FlatUsageTokens & {
  segments?: UsageSegment[];
  cost_usd?: number;
  duration_ms?: number;
  turns?: number;
  estimated?: boolean;
  reason?: string;
};

function counter(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The four buckets of one segment. Read and write stay apart: they price
 * differently on every provider that bills a cache write at all (Anthropic:
 * 1.25x-2x input to write, 0.1x to read), so a bucket that merged them could
 * never be priced correctly no matter what the price table said.
 */
export function segmentTokenCounts(segment: UsageSegment): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return {
    input: counter(segment.input),
    output: counter(segment.output),
    cacheRead: counter(segment.cache_read),
    cacheWrite: counter(segment.cache_write),
  };
}

/** Every token in one segment, whatever the bucket. */
export function segmentTotalTokens(segment: UsageSegment): number {
  const tokens = segmentTokenCounts(segment);
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/**
 * The flat counters a list of segments adds up to. `tokens_cache` merges read
 * and write back into one number: it is the legacy display total, never the
 * shape cost is computed from — that reads segments and prices each bucket
 * apart.
 */
export function flattenUsageSegments(
  segments: readonly UsageSegment[],
): Required<FlatUsageTokens> {
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCache = 0;
  for (const segment of segments) {
    const tokens = segmentTokenCounts(segment);
    tokensIn += tokens.input;
    tokensOut += tokens.output;
    tokensCache += tokens.cacheRead + tokens.cacheWrite;
  }
  return {
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokens_cache: tokensCache,
  };
}

function hasFlatTokens(usage: FlatUsageTokens): boolean {
  return (
    usage.tokens_in !== undefined ||
    usage.tokens_out !== undefined ||
    usage.tokens_cache !== undefined
  );
}

/**
 * The segments a usage block describes.
 *
 * Segments win when the executor sent them. The flat legacy shape is still
 * accepted and becomes a single segment for the model the attempt is running,
 * with `tokens_cache` landing on `cache_read`: that bucket is what a long
 * agent session is mostly made of, and it is the rate the price table seeds.
 * A usage block with no token counter at all produces no segments, because
 * inventing a zero would read as a run that spent nothing.
 */
export function normalizeUsageSegments(
  usage: SegmentedUsage | null | undefined,
  fallbackModel: string | null,
): UsageSegment[] {
  if (!usage) return [];
  if (usage.segments && usage.segments.length > 0) {
    return usage.segments.map((segment) => ({
      ...segment,
      model: segment.model ?? fallbackModel,
    }));
  }
  if (!hasFlatTokens(usage)) return [];
  const segment: UsageSegment = { model: fallbackModel };
  if (usage.tokens_in !== undefined) segment.input = usage.tokens_in;
  if (usage.tokens_out !== undefined) segment.output = usage.tokens_out;
  if (usage.tokens_cache !== undefined) segment.cache_read = usage.tokens_cache;
  return [segment];
}

/**
 * The usage block as the board stores it: the segments plus the flat totals
 * they add up to, so every reader written before segments keeps working and
 * keeps agreeing with the per-model truth.
 */
export function resolveUsageSegments<T extends SegmentedUsage>(
  usage: T,
  fallbackModel: string | null,
): T & { segments: UsageSegment[] } & FlatUsageTokens {
  const segments = normalizeUsageSegments(usage, fallbackModel);
  if (segments.length === 0) return { ...usage, segments };
  return { ...usage, segments, ...flattenUsageSegments(segments) };
}

/** The models a run touched, in order, without repeating one. */
export function segmentModels(
  segments: readonly UsageSegment[],
): Array<string | null> {
  const seen: Array<string | null> = [];
  for (const segment of segments) {
    if (!seen.includes(segment.model)) seen.push(segment.model);
  }
  return seen;
}

/**
 * "opus-5" for one model, "sonnet-5 to opus-5" for a run that switched. Null
 * when no segment names a model, so the caller shows nothing instead of a
 * label with a hole in it.
 */
export function modelChain(
  models: readonly (string | null)[],
): string | null {
  const named: string[] = [];
  for (const model of models) {
    if (model && !named.includes(model)) named.push(model);
  }
  if (named.length === 0) return null;
  return named.join(" to ");
}
