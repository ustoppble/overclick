import { and, eq, isNotNull } from "drizzle-orm";
import * as BoardDb from "@agent-board/db";
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
  type AttemptModelSource,
  type ModelPrice,
  type ResolvedCost,
  type UsageSegment,
} from "@agent-board/db";

/** Postgres or PGlite drizzle client — the query surface insights needs. */
export type InsightsDb = Pick<Database, "select">;

/** Fields shared by card and mission attempts. */
export type InsightUsageRow = {
  attemptId: string;
  projectId: string | null;
  projectName: string | null;
  missionId: string | null;
  missionTitle: string | null;
  model: string | null;
  executor: string | null;
  modelSource: AttemptModelSource | null;
  /** The lifecycle status is present on mission attempts; cards use result. */
  status?: string | null;
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
  usageSuspectReason?: string | null;
  /** A delivery accepted without a verified commit on the project remote. */
  deliveryUnverified?: boolean;
};

export type InsightAttemptRow = InsightUsageRow & {
  /** The business the card's project belongs to, which the board filters by. */
  organizationId: string;
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
  resolvedIn: string | null;
};

/** A mission attempt is deliberately not a card and therefore has no task fields. */
export type MissionAttemptInsightRow = InsightUsageRow & {
  /** A mission belongs to a business of its own, not to its project's. */
  organizationId: string;
  missionTitle: string;
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
      organizationId: project.organizationId,
      projectId: project.id,
      projectName: project.name,
      missionId: task.missionId,
      missionTitle: mission.title,
      resolvedIn: task.resolvedIn,
      model: executionAttempt.model,
      executor: executionAttempt.executor,
      modelSource: executionAttempt.modelSource,
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
      deliveryUnverified: executionAttempt.deliveryUnverified,
    })
    .from(executionAttempt)
    .innerJoin(task, eq(executionAttempt.taskId, task.id))
    .innerJoin(project, eq(task.projectId, project.id))
    .leftJoin(mission, eq(task.missionId, mission.id))
    .where(eq(project.workspaceId, workspaceId));
}

/**
 * Mission attempts are added by the lifecycle card. Keeping the lookup here
 * means the page, the MCP tool and the board totals all consume one source.
 * The optional runtime lookup keeps this card composable while that schema is
 * being merged: an older database has no mission-attempt table and therefore
 * has no orchestration rows to aggregate.
 */
type MissionAttemptTable = Record<string, any>;

export async function loadMissionAttemptRows(
  db: InsightsDb,
  workspaceId: string,
): Promise<MissionAttemptInsightRow[]> {
  const missionAttempt = (
    BoardDb as unknown as { missionAttempt?: MissionAttemptTable }
  ).missionAttempt;
  if (!missionAttempt) return [];

  const rows = await db
    .select({
      attemptId: missionAttempt.id,
      organizationId: mission.organizationId,
      projectId: missionAttempt.projectId,
      projectName: project.name,
      missionId: missionAttempt.missionId,
      missionTitle: mission.title,
      model: missionAttempt.model,
      executor: missionAttempt.executor,
      modelSource: missionAttempt.modelSource,
      status: missionAttempt.status,
      result: missionAttempt.result,
      finishedAt: missionAttempt.finishedAt,
      usageSegments: missionAttempt.usageSegments,
      tokensIn: missionAttempt.tokensIn,
      tokensOut: missionAttempt.tokensOut,
      tokensCache: missionAttempt.tokensCache,
      costUsd: missionAttempt.costUsd,
      costSource: missionAttempt.costSource,
      costStatus: missionAttempt.costStatus,
      costUnpricedModels: missionAttempt.costUnpricedModels,
      costBreakdown: missionAttempt.costBreakdown,
      durationMs: missionAttempt.durationMs,
      serverDurationMs: missionAttempt.serverDurationMs,
      turns: missionAttempt.turns,
      usageEstimated: missionAttempt.usageEstimated,
      usageSuspect: missionAttempt.usageSuspect,
      usageSuspectReason: missionAttempt.usageSuspectReason,
    })
    .from(missionAttempt as any)
    .innerJoin(mission, eq(missionAttempt.missionId, mission.id))
    .leftJoin(project, eq(missionAttempt.projectId, project.id))
    .where(eq(mission.workspaceId, workspaceId));

  return rows as MissionAttemptInsightRow[];
}

/** Apply the project/mission part of the board filter to mission work. */
export function filterMissionAttempts<
  T extends Pick<InsightUsageRow, "projectId" | "missionId"> & {
    organizationId?: string;
  },
>(
  rows: T[],
  filter: {
    organizationIds?: string[];
    projectIds: string[];
    missionId: string | null;
    types?: readonly unknown[];
    priorities?: readonly unknown[];
    resolvedIn?: string | null;
  },
): T[] {
  return rows.filter((row) => {
    // Mission attempts have no card type, priority or release. A facet on
    // those fields is therefore a card-only view, not an excuse to invent an
    // allocation for orchestration.
    if (
      (filter.types && filter.types.length > 0) ||
      (filter.priorities && filter.priorities.length > 0) ||
      filter.resolvedIn !== undefined
    ) {
      return false;
    }
    // A mission carries its own organization, so orchestration is narrowed by
    // business even when the mission ran against no project at all.
    if (
      filter.organizationIds &&
      filter.organizationIds.length > 0 &&
      (!row.organizationId ||
        !filter.organizationIds.includes(row.organizationId))
    ) {
      return false;
    }
    if (filter.projectIds.length > 0 && (!row.projectId || !filter.projectIds.includes(row.projectId))) {
      return false;
    }
    if (filter.missionId === "none") return false;
    return !filter.missionId || row.missionId === filter.missionId;
  });
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
export function filterAttemptsByPeriod<T extends Pick<InsightUsageRow, "finishedAt">>(
  rows: T[],
  period: { since?: Date; until?: Date },
): T[] {
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
  if (totals.deliveryUnverified > 0) {
    parts.push(`${totals.deliveryUnverified} delivery commit unverified`);
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
  /** Deliveries accepted without a verified remote commit. */
  deliveryUnverified: number;
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
  /** Origin of each current attempt model, for labels such as "via harness". */
  modelOrigins: Array<{ model: string; source: AttemptModelSource }>;
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
  deliveryUnverified: boolean;
};

export type InsightGroupSet = {
  byProject: GroupInsight[];
  byMission: GroupInsight[];
  byModel: GroupInsight[];
};

/** One dimension with the source subtotals and their non-duplicating sum. */
export type CombinedGroupInsight = {
  key: string;
  label: string | null;
  execution: GroupInsight;
  orchestration: GroupInsight;
  total: GroupInsight;
};

export type CombinedGroupSet = {
  byProject: CombinedGroupInsight[];
  byMission: CombinedGroupInsight[];
  byModel: CombinedGroupInsight[];
};

export type Insights = {
  /** Card-only subtotal, preserved for existing readers. */
  executionTotals: UsageTotals;
  /** Successful, finished mission-attempt subtotal. */
  orchestrationTotals: UsageTotals;
  totals: UsageTotals;
  /** Abandoned attempts on discarded cards, deliberately outside success totals. */
  discarded: {
    totals: UsageTotals;
    byExecutor: GroupInsight[];
    byMission: GroupInsight[];
    byModel: GroupInsight[];
    /** Abandoned mission attempts, kept outside the trusted total. */
    orchestration: UsageTotals;
  };
  /**
   * Finished attempts that ran more than one model. Each of them appears in
   * several byModel groups, so this is the count the screen can name without
   * double counting.
   */
  switchedRuns: number;
  byProject: GroupInsight[];
  byMission: GroupInsight[];
  byRelease: GroupInsight[];
  byExecutor: GroupInsight[];
  byModel: GroupInsight[];
  /** Mission-attempt groups, separate from the legacy card groups above. */
  orchestrationGroups: InsightGroupSet;
  /** Each group carries execution, orchestration and total lines. */
  combinedGroups: CombinedGroupSet;
  reopensByModel: ModelReopenInsight[];
  perCard: CardInsight[];
};

const NO_MISSION = "__none__";
const NO_RELEASE = "__no_release__";
const NO_MODEL = "__unknown__";
const CROSS_PROJECT = "__cross_project__";

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
    deliveryUnverified: 0,
    suspectCostKnown: false,
  };
}

function attemptTokens(a: InsightUsageRow): number {
  const hasFlatCounter =
    a.tokensIn != null || a.tokensOut != null || a.tokensCache != null;
  if (hasFlatCounter) {
    return (a.tokensIn ?? 0) + (a.tokensOut ?? 0) + (a.tokensCache ?? 0);
  }
  return (a.usageSegments ?? []).reduce(
    (sum, segment) => sum + segmentTotalTokens(segment),
    0,
  );
}

/**
 * The models an attempt actually ran, as segments. Attempts stored before
 * segments existed fold their flat counters into one segment for the model
 * recorded at claim time; an attempt that reported no tokens at all still
 * yields one empty segment so it keeps showing up under its model instead of
 * vanishing from the per-model view.
 */
function attemptSegments(a: InsightUsageRow): UsageSegment[] {
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
function hasReportedUsage(a: InsightUsageRow): boolean {
  if (a.costStatus === "not_reported") return false;
  if (a.costStatus != null) return true;
  return (
    attemptTokens(a) > 0 ||
    a.costUsd != null ||
    a.durationMs != null ||
    a.turns != null
  );
}

function isZeroUsage(a: InsightUsageRow): boolean {
  return a.costStatus === "zero_usage";
}

function hasStoredCostAssessment(a: InsightUsageRow): boolean {
  return (
    a.costStatus != null ||
    a.costSource != null ||
    a.costUnpricedModels != null ||
    a.costBreakdown != null
  );
}

function storedUnpricedModels(a: InsightUsageRow): string[] | null {
  return a.costUnpricedModels?.map(normalizeModelKey) ?? null;
}

function isAttemptPriced(
  a: InsightUsageRow,
  segments: readonly UsageSegment[],
  prices: readonly ModelPrice[],
): boolean {
  const stored = storedUnpricedModels(a);
  if (stored) return attemptTokens(a) > 0 && stored.length === 0;
  return areSegmentsPriced(segments, prices);
}

function isSegmentPriced(
  a: InsightUsageRow,
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
function addDurations(totals: UsageTotals, a: InsightUsageRow): void {
  totals.durationMs += executionOnlyMs(a);
  const elapsed = elapsedOnlyMs(a);
  totals.elapsedMs += elapsed;
  if (elapsed > 0) totals.elapsedOnly += 1;
}

/** The cost of one attempt, every segment priced at its own model's rate. */
function attemptCost(
  a: InsightUsageRow,
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
  a: InsightUsageRow,
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
  a: InsightUsageRow,
  cost: { costUsd: number | null; source: CostSource | null },
  priced: boolean,
): void {
  totals.attempts += 1;
  if (a.deliveryUnverified) totals.deliveryUnverified += 1;
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
  a: InsightUsageRow,
  segment: UsageSegment,
  cost: ResolvedCost,
  priced: boolean,
  shared: boolean,
): void {
  const tokens = segmentTotalTokens(segment);
  totals.attempts += 1;
  if (a.deliveryUnverified) totals.deliveryUnverified += 1;
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

function attemptResult(
  row: Pick<InsightUsageRow, "result"> & { status?: string | null },
): "success" | "abandoned" | null {
  if (row.result === "success") return "success";
  if (row.result === "abandoned") return "abandoned";
  if (row.result != null) return null;
  if (row.status === "sucesso" || row.status === "success") return "success";
  if (row.status === "abandonado" || row.status === "abandoned") {
    return "abandoned";
  }
  return null;
}

function combineTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const costUsd =
    a.costUsd == null
      ? b.costUsd
      : b.costUsd == null
        ? a.costUsd
        : a.costUsd + b.costUsd;
  return {
    costUsd,
    costComputed: a.costComputed + b.costComputed,
    costReported: a.costReported + b.costReported,
    costEstimated: a.costEstimated + b.costEstimated,
    costUnpriced: a.costUnpriced + b.costUnpriced,
    unpricedTokens: a.unpricedTokens + b.unpricedTokens,
    tokens: a.tokens + b.tokens,
    durationMs: a.durationMs + b.durationMs,
    elapsedMs: a.elapsedMs + b.elapsedMs,
    elapsedOnly: a.elapsedOnly + b.elapsedOnly,
    attempts: a.attempts + b.attempts,
    estimated: a.estimated + b.estimated,
    missing: a.missing + b.missing,
    zeroUsage: a.zeroUsage + b.zeroUsage,
    suspect: a.suspect + b.suspect,
    suspectTokens: a.suspectTokens + b.suspectTokens,
    suspectDurationMs: a.suspectDurationMs + b.suspectDurationMs,
    suspectCostUsd:
      a.suspectCostUsd == null
        ? b.suspectCostUsd
        : b.suspectCostUsd == null
          ? a.suspectCostUsd
          : a.suspectCostUsd + b.suspectCostUsd,
    deliveryUnverified: a.deliveryUnverified + b.deliveryUnverified,
  };
}

function emptyGroup(key: string, label: string | null): GroupInsight {
  return { key, label, ...sealTotals(emptyTotals()) };
}

function mergeGroups(
  key: string,
  label: string | null,
  execution: GroupInsight,
  orchestration: GroupInsight,
): GroupInsight {
  const total = combineTotals(execution, orchestration);
  const sharedAttempts =
    (execution.sharedAttempts ?? 0) + (orchestration.sharedAttempts ?? 0);
  return {
    key,
    label,
    ...total,
    ...(sharedAttempts > 0 ? { sharedAttempts } : {}),
  };
}

function combinedDimension(
  execution: GroupInsight[],
  orchestration: GroupInsight[],
): CombinedGroupInsight[] {
  const executionByKey = new Map(execution.map((row) => [row.key, row]));
  const orchestrationByKey = new Map(
    orchestration.map((row) => [row.key, row]),
  );
  const keys = new Set([...executionByKey.keys(), ...orchestrationByKey.keys()]);
  return [...keys]
    .map((key) => {
      const executionRow = executionByKey.get(key) ?? null;
      const orchestrationRow = orchestrationByKey.get(key) ?? null;
      const label = executionRow?.label ?? orchestrationRow?.label ?? null;
      const executionLine = executionRow ?? emptyGroup(key, label);
      const orchestrationLine = orchestrationRow ?? emptyGroup(key, label);
      return {
        key,
        label,
        execution: executionLine,
        orchestration: orchestrationLine,
        total: mergeGroups(key, label, executionLine, orchestrationLine),
      };
    })
    .sort(
      (a, b) =>
        (b.total.costUsd ?? -1) - (a.total.costUsd ?? -1) ||
        b.total.tokens - a.total.tokens ||
        b.total.attempts - a.total.attempts,
    );
}

function buildCombinedGroups(
  execution: InsightGroupSet,
  orchestration: InsightGroupSet,
): CombinedGroupSet {
  return {
    byProject: combinedDimension(execution.byProject, orchestration.byProject),
    byMission: combinedDimension(execution.byMission, orchestration.byMission),
    byModel: combinedDimension(execution.byModel, orchestration.byModel),
  };
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
  missionAttemptRows: MissionAttemptInsightRow[] = [],
): Insights {
  const finished = rows.filter((r) => !r.taskIsExample && r.finishedAt != null);
  const successful = finished.filter((r) => attemptResult(r) === "success");
  const abandoned = finished.filter(
    (r) => attemptResult(r) === "abandoned" && r.taskStatus === "descartado",
  );
  const finishedMissionAttempts = missionAttemptRows.filter(
    (r) => r.finishedAt != null,
  );
  const successfulMissionAttempts = finishedMissionAttempts.filter(
    (r) => attemptResult(r) === "success",
  );
  const abandonedMissionAttempts = finishedMissionAttempts.filter(
    (r) => attemptResult(r) === "abandoned",
  );

  const totals = emptyTotals();
  let switchedRuns = 0;
  const byProject = new Map<string, RunningGroup>();
  const byMission = new Map<string, RunningGroup>();
  const byRelease = new Map<string, RunningGroup>();
  const byExecutor = new Map<string, RunningGroup>();
  const byModel = new Map<string, RunningGroup>();
  const byCard = new Map<
    string,
    Omit<CardInsight, "costUsd"> & {
      costUsd: number;
      hasCost: boolean;
      sources: (CostSource | null)[];
    }
  >();

  const orchestrationTotals = emptyTotals();
  const orchestrationByProject = new Map<string, RunningGroup>();
  const orchestrationByMission = new Map<string, RunningGroup>();
  const orchestrationByModel = new Map<string, RunningGroup>();

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
    addAttempt(
      group(byRelease, a.resolvedIn ?? NO_RELEASE, a.resolvedIn),
      a,
      cost,
      priced,
    );
    addAttempt(
      group(
        byExecutor,
        executorLabel(a.executor) ?? NO_MODEL,
        executorLabel(a.executor),
      ),
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
        modelOrigins: [],
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
        deliveryUnverified: false,
        hasCost: false,
        sources: [],
      };
      byCard.set(a.taskId, card);
    }
    card.attempts += 1;
    if (a.deliveryUnverified) card.deliveryUnverified = true;
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
    if (a.model && a.modelSource) {
      const model = normalizeModelKey(a.model);
      if (
        model &&
        !card.modelOrigins.some(
          (origin) => origin.model === model && origin.source === a.modelSource,
        )
      ) {
        card.modelOrigins.push({ model, source: a.modelSource });
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

  // Mission attempts are a second source, never a synthetic card. They use
  // the same pricing, duration and honesty helpers, but only their final
  // successful snapshot enters the trusted orchestration subtotal.
  for (const a of successfulMissionAttempts) {
    const segments = attemptSegments(a);
    const cost = attemptCost(a, segments, prices);
    const priced = isAttemptPriced(a, segments, prices);
    addAttempt(orchestrationTotals, a, cost, priced);
    const projectKey = a.projectId ?? CROSS_PROJECT;
    const projectLabel = a.projectName ?? "cross-project";
    addAttempt(
      group(orchestrationByProject, projectKey, projectLabel),
      a,
      cost,
      priced,
    );
    addAttempt(
      group(orchestrationByMission, a.missionId ?? NO_MISSION, a.missionTitle),
      a,
      cost,
      priced,
    );
    const shared = segments.length > 1;
    if (shared) switchedRuns += 1;
    for (const segment of segments) {
      addSegment(
        group(orchestrationByModel, segment.model ?? NO_MODEL, segment.model),
        a,
        segment,
        segmentCost(a, segment, prices, !shared),
        isSegmentPriced(a, segment, prices),
        shared,
      );
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
  const discardedOrchestrationTotals = emptyTotals();
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

  for (const a of abandonedMissionAttempts) {
    const segments = attemptSegments(a);
    const cost = attemptCost(a, segments, prices);
    const priced = isAttemptPriced(a, segments, prices);
    addAttempt(discardedOrchestrationTotals, a, cost, priced);
  }

  const executionTotals = sealTotals(totals);
  const orchestrationTotalsSealed = sealTotals(orchestrationTotals);
  const executionGroups: InsightGroupSet = {
    byProject: seal(byProject),
    byMission: seal(byMission),
    byModel: seal(byModel),
  };
  const orchestrationGroups: InsightGroupSet = {
    byProject: seal(orchestrationByProject),
    byMission: seal(orchestrationByMission),
    byModel: seal(orchestrationByModel),
  };

  return {
    executionTotals,
    orchestrationTotals: orchestrationTotalsSealed,
    totals: combineTotals(executionTotals, orchestrationTotalsSealed),
    discarded: {
      totals: sealTotals(discardedTotals),
      byExecutor: seal(discardedByExecutor),
      byMission: seal(discardedByMission),
      byModel: seal(discardedByModel),
      orchestration: sealTotals(discardedOrchestrationTotals),
    },
    switchedRuns,
    byProject: executionGroups.byProject,
    byMission: executionGroups.byMission,
    byRelease: seal(byRelease),
    byExecutor: seal(byExecutor),
    byModel: executionGroups.byModel,
    orchestrationGroups,
    combinedGroups: buildCombinedGroups(executionGroups, orchestrationGroups),
    reopensByModel,
    perCard,
  };
}
