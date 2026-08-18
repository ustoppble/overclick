import { and, eq, isNotNull } from "drizzle-orm";
import {
  areSegmentsPriced,
  elapsedOnlyMs,
  executionAttempt,
  executionOnlyMs,
  findModelPrice,
  mergeCostSources,
  mission,
  normalizeModelKey,
  normalizeUsageSegments,
  project,
  resolveAttemptCost,
  resolveSegmentedCost,
  segmentModels,
  segmentTokenCounts,
  segmentTotalTokens,
  task,
  taskComment,
  type CostSource,
  type CostBreakdownSegment,
  type CostStatus,
  type Database,
  type ModelPrice,
  type ResolvedCost,
  type UsageSegment,
} from "@agent-board/db";

/** Postgres or PGlite drizzle client — the query surface insights needs. */
export type InsightsDb = Pick<Database, "select">;

export type InsightAttemptRow = {
  attemptId: string;
  taskId: string;
  taskShortId: string;
  taskTitle: string;
  taskIsExample: boolean;
  taskStatus: "aberto" | "em_execucao" | "feito" | "validado" | "descartado";
  tipo: "feature" | "bug" | "rfc";
  priority: "urgente" | "alta" | "media" | "baixa";
  projectId: string;
  projectName: string;
  missionId: string | null;
  missionTitle: string | null;
  model: string | null;
  executor: string | null;
  result: string | null;
  finishedAt: Date | null;
  /** Tokens by model. Null on attempts recorded before segments existed. */
  usageSegments: UsageSegment[] | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCache: number | null;
  costUsd: string | null;
  costSource: CostSource | null;
  costStatus: CostStatus | null;
  costUnpricedModels: string[] | null;
  costBreakdown: CostBreakdownSegment[] | null;
  durationMs: number | null;
  serverDurationMs: number | null;
  turns: number | null;
  usageEstimated: boolean;
  usageSuspect: boolean;
};

export type ReopenRow = {
  taskId: string;
  createdAt: Date;
};

/** Every execution attempt in the workspace, joined to its card, project and mission. */
export async function loadInsightAttemptRows(
  db: InsightsDb,
  workspaceId: string,
): Promise<InsightAttemptRow[]> {
  return db
    .select({
      attemptId: executionAttempt.id,
      taskId: task.id,
      taskShortId: task.shortId,
      taskTitle: task.title,
      taskIsExample: task.isExample,
      taskStatus: task.status,
      tipo: task.tipo,
      priority: task.priority,
      projectId: project.id,
      projectName: project.name,
      missionId: task.missionId,
      missionTitle: mission.title,
      model: executionAttempt.model,
      executor: executionAttempt.executor,
      result: executionAttempt.result,
      finishedAt: executionAttempt.finishedAt,
      usageSegments: executionAttempt.usageSegments,
      tokensIn: executionAttempt.tokensIn,
      tokensOut: executionAttempt.tokensOut,
      tokensCache: executionAttempt.tokensCache,
      costUsd: executionAttempt.costUsd,
      costSource: executionAttempt.costSource,
      costStatus: executionAttempt.costStatus,
      costUnpricedModels: executionAttempt.costUnpricedModels,
      costBreakdown: executionAttempt.costBreakdown,
      durationMs: executionAttempt.durationMs,
      serverDurationMs: executionAttempt.serverDurationMs,
      turns: executionAttempt.turns,
      usageEstimated: executionAttempt.usageEstimated,
      usageSuspect: executionAttempt.usageSuspect,
    })
    .from(executionAttempt)
    .innerJoin(task, eq(executionAttempt.taskId, task.id))
    .innerJoin(project, eq(task.projectId, project.id))
    .leftJoin(mission, eq(task.missionId, mission.id))
    .where(eq(project.workspaceId, workspaceId));
}

/**
 * Human-authored task comments in the workspace. Today the board writes a
 * human comment in exactly one place, the reopen action, so a comment with an
 * author user is the reopen signal insights needs.
 */
export async function loadReopenRows(
  db: InsightsDb,
  workspaceId: string,
): Promise<ReopenRow[]> {
  return db
    .select({
      taskId: taskComment.taskId,
      createdAt: taskComment.createdAt,
    })
    .from(taskComment)
    .innerJoin(task, eq(taskComment.taskId, task.id))
    .innerJoin(project, eq(task.projectId, project.id))
    .where(
      and(
        eq(project.workspaceId, workspaceId),
        isNotNull(taskComment.authorUserId),
      ),
    );
}

/**
 * Narrows attempt rows to a period by when the attempt finished. Only the
 * attempts are narrowed: a reopen that lands after the window still means that
 * delivery was reopened, so the reopen rows stay whole.
 */
export function filterAttemptsByPeriod(
  rows: InsightAttemptRow[],
  period: { since?: Date; until?: Date },
): InsightAttemptRow[] {
  if (!period.since && !period.until) return rows;
  return rows.filter((row) => {
    if (!row.finishedAt) return false;
    const at = row.finishedAt.getTime();
    if (period.since && at < period.since.getTime()) return false;
    if (period.until && at > period.until.getTime()) return false;
    return true;
  });
}

/** "2 estimated · 1 usage not reported", or the all-clear. Never a silent sum. */
export function usageHonestyNote(totals: UsageTotals): string {
  const parts: string[] = [];
  if (totals.estimated > 0) parts.push(`${totals.estimated} estimated`);
  if (totals.missing > 0) parts.push(`${totals.missing} usage not reported`);
  if (totals.zeroUsage > 0) parts.push(`${totals.zeroUsage} reported zero usage`);
  if (totals.suspect > 0) {
    parts.push(
      `${totals.suspect} suspect · ${totals.suspectTokens} tokens kept separate`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "all usage reported";
}

/**
 * "3 computed · 1 agent reported · 2 unpriced model": where the dollars in a
 * sum came from. A total that mixes arithmetic with an agent's own guess says
 * so instead of presenting one number as if it were all the same kind.
 */
export function costSourceNote(totals: UsageTotals): string {
  const parts: string[] = [];
  if (totals.costComputed > 0) parts.push(`${totals.costComputed} computed`);
  if (totals.costReported > 0) parts.push(`${totals.costReported} agent reported`);
  if (totals.costEstimated > 0) parts.push(`${totals.costEstimated} estimated`);
  if (totals.costUnpriced > 0) parts.push(`${totals.costUnpriced} unpriced model`);
  return parts.length > 0 ? parts.join(" · ") : "no cost to attribute";
}

export type UsageTotals = {
  /**
   * Sum of the costs the board could establish, or null when it could not
   * establish a single one. Never a zero standing in for an unknown: a model
   * nobody priced would read as free work and quietly shrink every total it
   * lands in.
   */
  costUsd: number | null;
  /** Attempts whose cost the board computed from the price table. */
  costComputed: number;
  /** Attempts that contributed the cost figure the agent sent. */
  costReported: number;
  /** Same, where the agent flagged its own numbers as an estimate. */
  costEstimated: number;
  /** Attempts with tokens the board could not price: no row for the model. */
  costUnpriced: number;
  /**
   * Tokens counted apart, spent by models with no price row. They are inside
   * `tokens`, which is a fact, and outside `costUsd`, which cannot be computed
   * for them: the pair is how the screen says how much of a total is missing.
   */
  unpricedTokens: number;
  /** tokens_in + tokens_out + tokens_cache across attempts that reported them. */
  tokens: number;
  /**
   * Execution time only: the sum of the durations agents reported working.
   * Attempts that reported none add nothing here, so this total is never
   * inflated by a claim that sat open all weekend.
   */
  durationMs: number;
  /**
   * Claim to deliver on the attempts that reported no execution time. It is
   * counted apart, never folded into `durationMs`: the two are different
   * clocks and no attempt lands in both.
   */
  elapsedMs: number;
  /** How many attempts contributed to `elapsedMs` instead of `durationMs`. */
  elapsedOnly: number;
  /** Finished attempts aggregated here. */
  attempts: number;
  /** How many of those attempts carry usage the executor flagged as estimated. */
  estimated: number;
  /** How many finished with no usage numbers at all. */
  missing: number;
  /** Attempts that explicitly reported token counters whose sum is zero. */
  zeroUsage: number;
  /** Attempts whose usage is intentionally outside the trusted sums. */
  suspect: number;
  suspectTokens: number;
  suspectDurationMs: number;
  suspectCostUsd: number | null;
};

export type GroupInsight = UsageTotals & {
  key: string;
  /** null when the dimension is absent (card without mission, model not reported). */
  label: string | null;
  /**
   * Only on byModel: attempts in this group that also ran another model. Their
   * tokens are split per segment, but nothing records how the wall clock split,
   * so the whole duration lands in every model the run touched. Non-zero means
   * the durations across models overlap instead of adding up to the total.
   */
  sharedAttempts?: number;
};

/** A group while it is being summed, before its cost is sealed. */
type RunningGroup = RunningTotals & {
  key: string;
  label: string | null;
  sharedAttempts?: number;
};

export type ModelReopenInsight = {
  /** null when the attempt never reported a model. */
  model: string | null;
  deliveries: number;
  reopened: number;
  /** reopened / deliveries, 0..1. */
  rate: number;
};

export type CardInsight = {
  taskId: string;
  shortId: string;
  title: string;
  projectName: string;
  missionTitle: string | null;
  models: string[];
  /** null when no attempt on the card has a cost. Distinct from a real $0. */
  costUsd: number | null;
  /** Where that figure came from, "mixed" when the attempts disagree. */
  costSource: CostSource | "mixed" | null;
  /**
   * Tokens on this card spent by a model with no price row. Non-zero means the
   * cost beside it is short by whatever those tokens were worth, which is why
   * the table says "no price" instead of showing a total that looks complete.
   */
  unpricedTokens: number;
  /** Canonical model keys that had tokens but no price when cost was frozen. */
  unpricedModels: string[];
  tokens: number;
  /** Execution time the agents reported on this card. */
  durationMs: number;
  /** Claim to deliver, on the attempts of this card that reported no time. */
  elapsedMs: number;
  attempts: number;
  estimated: boolean;
  missing: boolean;
  zeroUsage: boolean;
  suspect: boolean;
  suspectTokens: number;
  suspectDurationMs: number;
  suspectCostUsd: number | null;
};

export type Insights = {
  totals: UsageTotals;
  /** Abandoned attempts on discarded cards, deliberately outside success totals. */
  discarded: {
    totals: UsageTotals;
    byExecutor: GroupInsight[];
    byMission: GroupInsight[];
    byModel: GroupInsight[];
  };
  /**
   * Finished attempts that ran more than one model. Each of them appears in
   * several byModel groups, so this is the count the screen can name without
   * double counting.
   */
  switchedRuns: number;
  byProject: GroupInsight[];
  byMission: GroupInsight[];
  byModel: GroupInsight[];
  reopensByModel: ModelReopenInsight[];
  perCard: CardInsight[];
};

const NO_MISSION = "__none__";
const NO_MODEL = "__unknown__";

function executorLabel(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { cli?: unknown; agent?: unknown };
    if (typeof parsed.cli === "string" && parsed.cli) return parsed.cli;
    if (typeof parsed.agent === "string" && parsed.agent) return parsed.agent;
  } catch {
    // Older rows stored the executor label directly.
  }
  return raw;
}

/**
 * Totals while they are being summed. The running cost is a number here and
 * only becomes null at the end, when it turns out nothing fed it.
 */
type RunningTotals = Omit<UsageTotals, "costUsd" | "suspectCostUsd"> & {
  costUsd: number;
  suspectCostUsd: number;
  suspectCostKnown: boolean;
};

function emptyTotals(): RunningTotals {
  return {
    costUsd: 0,
    costComputed: 0,
    costReported: 0,
    costEstimated: 0,
    costUnpriced: 0,
    unpricedTokens: 0,
    tokens: 0,
    durationMs: 0,
    elapsedMs: 0,
    elapsedOnly: 0,
    attempts: 0,
    estimated: 0,
    missing: 0,
    zeroUsage: 0,
    suspect: 0,
    suspectTokens: 0,
    suspectDurationMs: 0,
    suspectCostUsd: 0,
    suspectCostKnown: false,
  };
}

function attemptTokens(a: InsightAttemptRow): number {
  return (a.tokensIn ?? 0) + (a.tokensOut ?? 0) + (a.tokensCache ?? 0);
}

/**
 * The models an attempt actually ran, as segments. Attempts stored before
 * segments existed fold their flat counters into one segment for the model
 * recorded at claim time; an attempt that reported no tokens at all still
 * yields one empty segment so it keeps showing up under its model instead of
 * vanishing from the per-model view.
 */
function attemptSegments(a: InsightAttemptRow): UsageSegment[] {
  const stored = a.usageSegments?.length
    ? a.usageSegments
    : normalizeUsageSegments(
        {
          tokens_in: a.tokensIn ?? undefined,
          tokens_out: a.tokensOut ?? undefined,
          tokens_cache: a.tokensCache ?? undefined,
        },
        a.model,
      );
  return stored.length > 0 ? stored : [{ model: a.model }];
}

/** Same ladder the board uses: any number counts as reported usage. */
function hasReportedUsage(a: InsightAttemptRow): boolean {
  if (a.costStatus === "not_reported") return false;
  if (a.costStatus != null) return true;
  return (
    attemptTokens(a) > 0 ||
    a.costUsd != null ||
    a.durationMs != null ||
    a.turns != null
  );
}

function isZeroUsage(a: InsightAttemptRow): boolean {
  return a.costStatus === "zero_usage";
}

function hasStoredCostAssessment(a: InsightAttemptRow): boolean {
  return (
    a.costStatus != null ||
    a.costSource != null ||
    a.costUnpricedModels != null ||
    a.costBreakdown != null
  );
}

function storedUnpricedModels(a: InsightAttemptRow): string[] | null {
  return a.costUnpricedModels?.map(normalizeModelKey) ?? null;
}

function isAttemptPriced(
  a: InsightAttemptRow,
  segments: readonly UsageSegment[],
  prices: readonly ModelPrice[],
): boolean {
  const stored = storedUnpricedModels(a);
  if (stored) return attemptTokens(a) > 0 && stored.length === 0;
  return areSegmentsPriced(segments, prices);
}

function isSegmentPriced(
  a: InsightAttemptRow,
  segment: UsageSegment,
  prices: readonly ModelPrice[],
): boolean {
  const normalized = segment.model ? normalizeModelKey(segment.model) : "unknown";
  const stored = storedUnpricedModels(a);
  if (stored) {
    return segmentTotalTokens(segment) > 0 && !stored.includes(normalized);
  }
  return findModelPrice(prices, segment.model) != null;
}

/**
 * The two clocks of one attempt, added to a total that keeps them apart. Work
 * is what the agent reported; the server measurement is elapsed time and only
 * counts when there is no reported work to count instead.
 */
function addDurations(totals: UsageTotals, a: InsightAttemptRow): void {
  totals.durationMs += executionOnlyMs(a);
  const elapsed = elapsedOnlyMs(a);
  totals.elapsedMs += elapsed;
  if (elapsed > 0) totals.elapsedOnly += 1;
}

/** The cost of one attempt, every segment priced at its own model's rate. */
function attemptCost(
  a: InsightAttemptRow,
  segments: readonly UsageSegment[],
  prices: readonly ModelPrice[],
): ResolvedCost {
  if (hasStoredCostAssessment(a)) {
    return {
      costUsd: a.costUsd != null ? Number(a.costUsd) : null,
      source: a.costSource,
    };
  }
  return resolveSegmentedCost(segments, prices, {
    costUsd: a.costUsd != null ? Number(a.costUsd) : null,
    usageEstimated: a.usageEstimated,
  });
}

/**
 * The cost of one segment. A run with a single segment keeps the whole ladder,
 * agent-reported dollars included; a run that switched model does not, because
 * splitting one volunteered figure across models would be inventing numbers.
 */
function segmentCost(
  a: InsightAttemptRow,
  segment: UsageSegment,
  prices: readonly ModelPrice[],
  allowReportedFallback: boolean,
): ResolvedCost {
  if (hasStoredCostAssessment(a)) {
    const counts = segmentTokenCounts(segment);
    const model = segment.model ? normalizeModelKey(segment.model) : null;
    const frozen = a.costBreakdown?.find(
      (item) =>
        item.model === model &&
        item.input === counts.input &&
        item.output === counts.output &&
        item.cache === counts.cache,
    );
    if (frozen) {
      return {
        costUsd: frozen.cost_usd,
        source: frozen.priced ? "computed" : null,
      };
    }
    if (allowReportedFallback) {
      return {
        costUsd: a.costUsd != null ? Number(a.costUsd) : null,
        source: a.costSource,
      };
    }
    return { costUsd: null, source: null };
  }
  const tokens = segmentTokenCounts(segment);
  return resolveAttemptCost(
    {
      tokensIn: tokens.input,
      tokensOut: tokens.output,
      tokensCache: tokens.cache,
      costUsd:
        allowReportedFallback && a.costUsd != null ? Number(a.costUsd) : null,
      usageEstimated: a.usageEstimated,
    },
    prices,
    segment.model,
  );
}

function addAttempt(
  totals: RunningTotals,
  a: InsightAttemptRow,
  cost: { costUsd: number | null; source: CostSource | null },
  priced: boolean,
): void {
  totals.attempts += 1;
  if (a.usageSuspect) {
    totals.suspect += 1;
    totals.suspectTokens += attemptTokens(a);
    totals.suspectDurationMs += executionOnlyMs(a);
    if (cost.costUsd != null) {
      totals.suspectCostUsd += cost.costUsd;
      totals.suspectCostKnown = true;
    }
    return;
  }
  totals.tokens += attemptTokens(a);
  addDurations(totals, a);
  if (cost.costUsd != null) totals.costUsd += cost.costUsd;
  if (cost.source === "computed") totals.costComputed += 1;
  if (cost.source === "reported") totals.costReported += 1;
  if (cost.source === "estimated") totals.costEstimated += 1;
  if (attemptTokens(a) > 0 && !priced) {
    totals.costUnpriced += 1;
    totals.unpricedTokens += attemptTokens(a);
  }
  if (!hasReportedUsage(a)) totals.missing += 1;
  if (isZeroUsage(a)) totals.zeroUsage += 1;
  if (hasReportedUsage(a) && a.usageEstimated) totals.estimated += 1;
}

/**
 * One model's slice of an attempt, for the per-model view. Tokens and cost are
 * the segment's; duration and the honesty counters belong to the whole run, so
 * they land on every model that ran in it.
 */
function addSegment(
  totals: RunningGroup,
  a: InsightAttemptRow,
  segment: UsageSegment,
  cost: ResolvedCost,
  priced: boolean,
  shared: boolean,
): void {
  const tokens = segmentTotalTokens(segment);
  totals.attempts += 1;
  if (a.usageSuspect) {
    totals.suspect += 1;
    totals.suspectTokens += tokens;
    totals.suspectDurationMs += executionOnlyMs(a);
    if (cost.costUsd != null) {
      totals.suspectCostUsd += cost.costUsd;
      totals.suspectCostKnown = true;
    }
    if (shared) totals.sharedAttempts = (totals.sharedAttempts ?? 0) + 1;
    return;
  }
  totals.tokens += tokens;
  addDurations(totals, a);
  if (cost.costUsd != null) totals.costUsd += cost.costUsd;
  if (cost.source === "computed") totals.costComputed += 1;
  if (cost.source === "reported") totals.costReported += 1;
  if (cost.source === "estimated") totals.costEstimated += 1;
  if (tokens > 0 && !priced) {
    totals.costUnpriced += 1;
    totals.unpricedTokens += tokens;
  }
  if (!hasReportedUsage(a)) totals.missing += 1;
  if (isZeroUsage(a)) totals.zeroUsage += 1;
  if (hasReportedUsage(a) && a.usageEstimated) totals.estimated += 1;
  if (shared) totals.sharedAttempts = (totals.sharedAttempts ?? 0) + 1;
}

/**
 * Closes a running total. A sum nothing ever fed is not zero dollars, it is no
 * answer, and it says so: with the money layer on and an unpriced model in the
 * rows, a zero would be read as free work.
 */
function sealTotals<T extends RunningTotals>(
  totals: T,
): Omit<T, "costUsd" | "suspectCostUsd" | "suspectCostKnown"> & {
  costUsd: number | null;
  suspectCostUsd: number | null;
} {
  const established =
    totals.costComputed + totals.costReported + totals.costEstimated;
  const { suspectCostKnown, costUsd, suspectCostUsd, ...rest } = totals;
  return {
    ...rest,
    costUsd: established > 0 ? costUsd : null,
    suspectCostUsd: suspectCostKnown ? suspectCostUsd : null,
  };
}

/** Groups sort by what they cost; a group with no figure sorts below a real $0. */
function sortGroups(groups: GroupInsight[]): GroupInsight[] {
  return groups.sort(
    (a, b) =>
      (b.costUsd ?? -1) - (a.costUsd ?? -1) ||
      b.tokens - a.tokens ||
      b.attempts - a.attempts,
  );
}

/**
 * Pure aggregation over attempt rows. Only finished attempts count: a running
 * attempt has nothing honest to sum yet. Example cards stay out so demo data
 * never inflates real cost. Costs come from the price table whenever the
 * attempt reported tokens; the agent's own figure is the fallback, not the
 * default.
 */
export function computeInsights(
  rows: InsightAttemptRow[],
  reopens: ReopenRow[],
  prices: readonly ModelPrice[] = [],
): Insights {
  const finished = rows.filter((r) => !r.taskIsExample && r.finishedAt != null);
  const successful = finished.filter((r) => r.result === "success");
  const abandoned = finished.filter(
    (r) => r.result === "abandoned" && r.taskStatus === "descartado",
  );

  const totals = emptyTotals();
  let switchedRuns = 0;
  const byProject = new Map<string, RunningGroup>();
  const byMission = new Map<string, RunningGroup>();
  const byModel = new Map<string, RunningGroup>();
  const byCard = new Map<
    string,
    Omit<CardInsight, "costUsd"> & {
      costUsd: number;
      hasCost: boolean;
      sources: (CostSource | null)[];
    }
  >();

  const group = (
    map: Map<string, RunningGroup>,
    key: string,
    label: string | null,
  ): RunningGroup => {
    let entry = map.get(key);
    if (!entry) {
      entry = { key, label, ...emptyTotals() };
      map.set(key, entry);
    }
    return entry;
  };

  for (const a of successful) {
    const segments = attemptSegments(a);
    const cost = attemptCost(a, segments, prices);
    const priced = isAttemptPriced(a, segments, prices);
    const frozenUnpriced = storedUnpricedModels(a);
    const unpricedModels = frozenUnpriced ?? [
      ...new Set(
        segments
          .filter(
            (segment) =>
              segmentTotalTokens(segment) > 0 &&
              findModelPrice(prices, segment.model) == null,
          )
          .map((segment) =>
            segment.model ? normalizeModelKey(segment.model) : "unknown",
          ),
      ),
    ];
    addAttempt(totals, a, cost, priced);
    addAttempt(group(byProject, a.projectId, a.projectName), a, cost, priced);
    addAttempt(
      group(byMission, a.missionId ?? NO_MISSION, a.missionTitle),
      a,
      cost,
      priced,
    );
    // Per model, from the segments: a run that switched model lands in both
    // groups with the tokens each one actually spent.
    const shared = segments.length > 1;
    if (shared) switchedRuns += 1;
    for (const segment of segments) {
      addSegment(
        group(byModel, segment.model ?? NO_MODEL, segment.model),
        a,
        segment,
        segmentCost(a, segment, prices, !shared),
        isSegmentPriced(a, segment, prices),
        shared,
      );
    }

    let card = byCard.get(a.taskId);
    if (!card) {
      card = {
        taskId: a.taskId,
        shortId: a.taskShortId,
        title: a.taskTitle,
        projectName: a.projectName,
        missionTitle: a.missionTitle,
        models: [],
        costUsd: 0,
        costSource: null,
        unpricedTokens: 0,
        unpricedModels: [],
        tokens: 0,
        durationMs: 0,
        elapsedMs: 0,
        attempts: 0,
        estimated: false,
        missing: false,
        zeroUsage: false,
        suspect: false,
        suspectTokens: 0,
        suspectDurationMs: 0,
        suspectCostUsd: null,
        hasCost: false,
        sources: [],
      };
      byCard.set(a.taskId, card);
    }
    card.attempts += 1;
    if (a.usageSuspect) {
      card.suspect = true;
      card.suspectTokens += attemptTokens(a);
      card.suspectDurationMs += executionOnlyMs(a);
      if (cost.costUsd != null) {
        card.suspectCostUsd = (card.suspectCostUsd ?? 0) + cost.costUsd;
      }
    } else {
      card.tokens += attemptTokens(a);
      card.durationMs += executionOnlyMs(a);
      card.elapsedMs += elapsedOnlyMs(a);
    }
    // Tokens this card spent on a model nobody priced. Counted apart from the
    // dollars beside them, never folded in at zero.
    if (!a.usageSuspect) {
      for (const segment of segments) {
        const spent = segmentTotalTokens(segment);
        const model = segment.model ? normalizeModelKey(segment.model) : "unknown";
        if (spent > 0 && unpricedModels.includes(model)) {
          card.unpricedTokens += spent;
        }
      }
      for (const model of unpricedModels) {
        if (!card.unpricedModels.includes(model)) card.unpricedModels.push(model);
      }
    }
    // Every model the card ran, in the order it ran them: the footer reads
    // "sonnet-5 to opus-5" off this list.
    for (const segment of segments) {
      if (segment.model && !card.models.includes(segment.model)) {
        card.models.push(segment.model);
      }
    }
    if (!a.usageSuspect && cost.costUsd != null) {
      card.hasCost = true;
      card.costUsd = (card.costUsd ?? 0) + cost.costUsd;
      card.sources.push(cost.source);
    }
    if (!a.usageSuspect) {
      if (!hasReportedUsage(a)) card.missing = true;
      if (isZeroUsage(a)) card.zeroUsage = true;
      if (hasReportedUsage(a) && a.usageEstimated) card.estimated = true;
    }
  }

  // Reopened rate: a delivery counts as reopened when a human comment landed
  // on its card after that delivery finished.
  const reopensByTask = new Map<string, Date[]>();
  for (const r of reopens) {
    const list = reopensByTask.get(r.taskId) ?? [];
    list.push(r.createdAt);
    reopensByTask.set(r.taskId, list);
  }
  const reopenAgg = new Map<string, ModelReopenInsight>();
  for (const a of successful) {
    if (a.result !== "success" || !a.finishedAt) continue;
    // A delivery a run produced with two models counts for both: neither can
    // be cleared of a reopen the pair earned together.
    for (const model of segmentModels(attemptSegments(a))) {
      const key = model ?? NO_MODEL;
      let entry = reopenAgg.get(key);
      if (!entry) {
        entry = { model, deliveries: 0, reopened: 0, rate: 0 };
        reopenAgg.set(key, entry);
      }
      entry.deliveries += 1;
      const finishedAt = a.finishedAt;
      const wasReopened = (reopensByTask.get(a.taskId) ?? []).some(
        (at) => at.getTime() > finishedAt.getTime(),
      );
      if (wasReopened) entry.reopened += 1;
    }
  }
  const reopensByModel = [...reopenAgg.values()]
    .map((e) => ({ ...e, rate: e.deliveries > 0 ? e.reopened / e.deliveries : 0 }))
    .sort((a, b) => b.rate - a.rate || b.deliveries - a.deliveries);

  const perCard: CardInsight[] = [...byCard.values()]
    .map(({ hasCost, sources, ...card }) => ({
      ...card,
      costUsd: hasCost ? card.costUsd : null,
      costSource: mergeCostSources(sources),
    }))
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens);

  const seal = (map: Map<string, RunningGroup>): GroupInsight[] =>
    sortGroups([...map.values()].map(sealTotals));

  const discardedTotals = emptyTotals();
  const discardedByExecutor = new Map<string, RunningGroup>();
  const discardedByMission = new Map<string, RunningGroup>();
  const discardedByModel = new Map<string, RunningGroup>();
  for (const a of abandoned) {
    const segments = attemptSegments(a);
    const cost = attemptCost(a, segments, prices);
    const priced = isAttemptPriced(a, segments, prices);
    addAttempt(discardedTotals, a, cost, priced);
    addAttempt(
      group(
        discardedByExecutor,
        executorLabel(a.executor) ?? NO_MODEL,
        executorLabel(a.executor),
      ),
      a,
      cost,
      priced,
    );
    addAttempt(
      group(discardedByMission, a.missionId ?? NO_MISSION, a.missionTitle),
      a,
      cost,
      priced,
    );
    for (const segment of segments) {
      addSegment(
        group(discardedByModel, segment.model ?? NO_MODEL, segment.model),
        a,
        segment,
        segmentCost(a, segment, prices, segments.length === 1),
        isSegmentPriced(a, segment, prices),
        segments.length > 1,
      );
    }
  }

  return {
    totals: sealTotals(totals),
    discarded: {
      totals: sealTotals(discardedTotals),
      byExecutor: seal(discardedByExecutor),
      byMission: seal(discardedByMission),
      byModel: seal(discardedByModel),
    },
    switchedRuns,
    byProject: seal(byProject),
    byMission: seal(byMission),
    byModel: seal(byModel),
    reopensByModel,
    perCard,
  };
}
