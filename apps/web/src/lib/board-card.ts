import {
  claimInactiveMinutes,
  harnessChain,
  isClaimStale,
  normalizeUsageSegments,
  readTranscriptRef,
  recomputeUsageCommand,
  resolveDuration,
  segmentModels,
  type CostSource,
  type ResolvedDuration,
  type UsageRecipeRow,
} from "@agent-board/db";
import type {
  BoardCard,
  DurationView,
  TelemetrySegment,
  TranscriptView,
} from "../app/home/board";
import { decodeExecutor, parseComoConfirmo } from "../mcp/map";
import type { BoardTaskRow } from "./board-tasks";
import {
  approx,
  formatDuration,
  formatElapsed,
  formatMoney,
  formatTokens,
} from "./format";
import type { Dict } from "./i18n";
import { bindUsageRecipe, recipeForCli } from "./recipes";

type TaskRow = BoardTaskRow;

/*
 * Number formatting lives in one place now (lib/format.ts, ux-v2.md §4).
 * What stays here is only the prose wrapper: the detail panel spells tokens
 * with their unit word, the card line spends it on numbers instead.
 */

/** The detail panel's prose spelling: the number with its unit word. */
function fmtTokensProse(n: number): string {
  return `${formatTokens(n)} tok`;
}

function fmtElapsed(from: Date, t: Dict): string {
  const m = Math.max(1, Math.round((Date.now() - from.getTime()) / 60000));
  if (m < 60) return t.board.minAgo(m);
  const h = Math.round(m / 60);
  if (h < 24) return t.board.hAgo(h);
  return t.board.dAgo(Math.round(h / 24));
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { day: "2-digit", month: "2-digit" });
}

function githubCommitUrl(
  repoUrl: string | null | undefined,
  commit: string | null | undefined,
): string | null {
  if (!repoUrl || !commit) return null;
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(repoUrl.trim());
  if (ssh?.[1] && ssh[2]) {
    return `https://github.com/${encodeURIComponent(ssh[1])}/${encodeURIComponent(ssh[2])}/commit/${encodeURIComponent(commit)}`;
  }
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
      return null;
    }
    if (parsed.username || parsed.password) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const repo = parts[1]?.replace(/\.git$/, "");
    if (!parts[0] || !repo) return null;
    return `https://github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(repo)}/commit/${encodeURIComponent(commit)}`;
  } catch {
    return null;
  }
}

/**
 * A duration on the card line always says which clock it read. The agent's own
 * number goes bare, because that one is work; the server measurement goes as
 * "open for 41h", because that one is only how long the card stayed claimed.
 */
function fmtResolvedDuration(duration: ResolvedDuration, tr: Dict): string {
  return duration.source === "reported"
    ? formatDuration(duration.ms)
    : tr.board.openFor(formatElapsed(duration.ms));
}

/**
 * The same duration for the one line: "5m" for work, "open 41h" for a card
 * that only sat claimed. The elapsed label keeps its word because a bare
 * number there would be the very confusion this line is trying to avoid.
 */
function fmtShortDuration(
  duration: ResolvedDuration,
  isEstimate: boolean,
  tr: Dict,
): string {
  return duration.source === "reported"
    ? approx(formatDuration(duration.ms), isEstimate)
    : tr.board.openShort(formatElapsed(duration.ms));
}

/** Both clocks for the detail panel, each one only when it was measured. */
function toDurationView(
  duration: ResolvedDuration | null,
): DurationView | null {
  if (!duration) return null;
  return {
    execution:
      duration.executionMs != null ? formatDuration(duration.executionMs) : null,
    elapsed:
      duration.elapsedMs != null ? formatElapsed(duration.elapsedMs) : null,
  };
}

/**
 * "~US$ 0,42 calculado": a dollar figure never travels without its source.
 * The tilde belongs to the source, not to money in general — a cost the agent
 * measured and reported is exact, one the board worked out from its price
 * table or an agent volunteered as an estimate is not.
 */
function isApproxCost(source: CostSource | null): boolean {
  return source === "computed" || source === "estimated";
}

function fmtCost(value: number, source: CostSource | null, tr: Dict): string {
  const label =
    source === "computed"
      ? tr.board.costComputed
      : source === "estimated"
        ? tr.board.costEstimated
        : tr.board.costReported;
  return `${approx(formatMoney(value, tr.lang), isApproxCost(source))} ${label}`;
}

/**
 * The transcript reference of an attempt, with the two commands that act on
 * it. Attempts claimed before the reference existed only ever recorded the
 * session id inside the executor blob, and still resolve here: what is
 * missing is the path, not the whole section.
 */
function toTranscriptView(
  attempt: TaskRow["attempts"][number] | undefined,
  recipes: readonly UsageRecipeRow[],
): TranscriptView | null {
  if (!attempt) return null;
  const executor = decodeExecutor(
    attempt.executor,
    attempt.model,
    attempt.modelSource,
  );
  const ref = readTranscriptRef(attempt.transcript, {
    cli: executor.cli,
    sessionId: executor.session_id,
  });
  if (!ref) return null;
  const recipe = bindUsageRecipe(recipeForCli(recipes, ref.cli), {
    sessionId: ref.sessionId,
    model: attempt.model,
    claimedAt: attempt.startedAt,
  });
  return {
    cli: ref.cli,
    sessionId: ref.sessionId,
    path: ref.path,
    resume: ref.resume,
    usageCommand: recomputeUsageCommand(recipe?.command, ref.path, recipe?.source),
  };
}

export function toBoardCard(
  t: TaskRow,
  tr: Dict,
  /** Money is opt-in: with it off the footer is tokens and time only. */
  pricingEnabled: boolean,
  recipes: readonly UsageRecipeRow[],
  /** Who is looking, so the card can tell whose review it waits on. */
  viewerId: string,
  /** Workspace lease: after this silence another executor may reclaim. */
  claimTimeoutMinutes: number,
): BoardCard {
  const devolve =
    t.devolveParaKind === "human"
      ? (t.reviewer?.email ?? "human")
      : t.devolveParaKind === "agent"
        ? (t.devolveParaAgentRef ?? "agent")
        : "workspace queue";

  const origem = t.createdBy?.email ?? t.origin?.agent ?? t.origin?.cli ?? "board";

  const latestAttempt = [...t.attempts].sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  )[0];
  // What the latest claim ran on (OCL-202): the board records the harness
  // that executed and never shows a plan. The planned value older cards still
  // carry in task.harness stays in the database, unread.
  const claimed = latestAttempt
    ? decodeExecutor(
        latestAttempt.executor,
        latestAttempt.model,
        latestAttempt.modelSource,
      )
    : null;
  const claimedModel = claimed?.model ?? null;
  const harness =
    [claimedModel, claimed?.effort].filter(Boolean).join(" · ") || null;
  const latestHandoff = [...t.handoffs].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];

  // Typed execution trace: executor swaps at claim, spawn failures from
  // orchestrators, and reports, oldest first.
  const comments = [...t.comments].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const timeline = comments
    .filter(
      (c) =>
        c.kind === "executor_swap" ||
        c.kind === "spawn_failure" ||
        c.kind === "report" ||
        c.kind === "comment" ||
        c.kind === "validation" ||
        c.kind === "claim_release" ||
        c.kind === "claim_stale",
    )
    .map((c) => ({
      kind: c.kind as
        | "executor_swap"
        | "spawn_failure"
        | "report"
        | "comment"
        | "validation"
        | "claim_release"
        | "claim_stale",
      body: c.body,
      author: c.authorAgentRef,
      at: fmtDate(c.createdAt),
    }));
  const reportsCount = comments.filter((c) => c.kind === "report").length;
  const claimInactive =
    t.status === "em_execucao" && latestAttempt
      ? tr.board.noActivityFor(
          claimInactiveMinutes(latestAttempt.lastActivityAt),
        )
      : null;
  const claimStale = Boolean(
    t.status === "em_execucao" &&
      latestAttempt &&
      isClaimStale(latestAttempt.lastActivityAt, claimTimeoutMinutes),
  );

  // Footer ladder: full usage > estimated usage (labeled) > server-measured
  // duration with "usage not reported". A delivered card never shows nothing.
  let telemetry: string | null = null;
  // The same numbers spelled for the one line the card has: no unit words, no
  // "estimated" at the end, a tilde on whatever is not exact.
  let telemetryLine: TelemetrySegment[] = [];
  let estimated = false;
  let costReason: string | null = null;
  // Execution and elapsed side by side, for the panel that has room for both.
  let duration: DurationView | null = null;
  // Which models actually ran, so the card can put the plan and the reality
  // side by side instead of spending a line on each.
  let ranModels: Array<string | null> = [];
  if (latestAttempt) {
    const parts: string[] = [];
    const tokens =
      (latestAttempt.tokensIn ?? 0) +
      (latestAttempt.tokensOut ?? 0) +
      (latestAttempt.tokensCache ?? 0);
    const hasUsage =
      tokens > 0 ||
      (latestAttempt.usageSegments?.length ?? 0) > 0 ||
      latestAttempt.costUsd != null ||
      latestAttempt.durationMs != null ||
      latestAttempt.turns != null;
    // What each model actually spent. Stored before segments existed, or with
    // no tokens at all, the attempt still reads as one segment for its model.
    const segments = latestAttempt.usageSegments?.length
      ? latestAttempt.usageSegments
      : (() => {
          const folded = normalizeUsageSegments(
            {
              tokens_in: latestAttempt.tokensIn ?? undefined,
              tokens_out: latestAttempt.tokensOut ?? undefined,
              tokens_cache: latestAttempt.tokensCache ?? undefined,
            },
            latestAttempt.model,
          );
          return folded.length > 0 ? folded : [{ model: latestAttempt.model }];
        })();
    ranModels = segmentModels(segments);
    // Which clock the card is reading, decided once for the line and the panel.
    const clock = resolveDuration(latestAttempt);
    duration = toDurationView(clock);
    if (hasUsage) {
      const isEstimate = latestAttempt.usageEstimated;
      if (clock) {
        parts.push(fmtResolvedDuration(clock, tr));
        telemetryLine.push({
          kind: "duration",
          text: fmtShortDuration(clock, isEstimate, tr),
        });
      }
      if (tokens > 0) {
        parts.push(fmtTokensProse(tokens));
        telemetryLine.push({
          kind: "tokens",
          text: approx(formatTokens(tokens), isEstimate),
        });
      }
      // Money only when the workspace asked for it. When it did, the board
      // reads the cost snapshot deliver/task_update stored. Price edits do not
      // rewrite history behind the card's back.
      if (pricingEnabled) {
        const costUsd =
          latestAttempt.costUsd != null ? Number(latestAttempt.costUsd) : null;
        if (costUsd != null) {
          parts.push(fmtCost(costUsd, latestAttempt.costSource, tr));
          // The card line keeps the tilde and drops the word behind it: the
          // detail panel still names the source, and the tilde only rides a
          // figure the board worked out or an agent estimated.
          telemetryLine.push({
            kind: "cost",
            text: approx(
              formatMoney(costUsd, tr.lang),
              isApproxCost(latestAttempt.costSource),
            ),
          });
        }
        const unpriced = latestAttempt.costUnpricedModels ?? [];
        if (unpriced.length > 0) {
          costReason = tr.board.costNoPrice(unpriced.join(", "));
        } else if (latestAttempt.costStatus === "zero_usage") {
          costReason = tr.board.costZeroUsage;
        } else if (latestAttempt.costStatus === "not_reported") {
          costReason = tr.board.usageNotReported;
        } else if (
          latestAttempt.costStatus === "estimated" &&
          costUsd == null
        ) {
          costReason = tr.board.costEstimatedUnavailable;
        }
      }
      telemetry = parts.join(" · ") || null;
      estimated = isEstimate;
    } else if (clock) {
      costReason = pricingEnabled ? tr.board.usageNotReported : null;
      telemetry = [
        fmtResolvedDuration(clock, tr),
        tr.board.usageNotReported,
      ].join(" · ");
      telemetryLine = [
        { kind: "duration", text: fmtShortDuration(clock, false, tr) },
        { kind: "note", text: tr.board.usageNotReported },
      ];
    }
  } else if (latestHandoff?.usage) {
    const u = latestHandoff.usage;
    const parts: string[] = [];
    const isEstimate = u.estimated ?? false;
    // No attempt behind it, so the only clock here is the agent's own.
    if (u.duration_ms != null) {
      parts.push(formatDuration(u.duration_ms));
      duration = { execution: formatDuration(u.duration_ms), elapsed: null };
      telemetryLine.push({
        kind: "duration",
        text: approx(formatDuration(u.duration_ms), isEstimate),
      });
    }
    const tokens = (u.tokens_in ?? 0) + (u.tokens_out ?? 0) + (u.tokens_cache ?? 0);
    if (tokens > 0) {
      parts.push(fmtTokensProse(tokens));
      telemetryLine.push({
        kind: "tokens",
        text: approx(formatTokens(tokens), isEstimate),
      });
    }
    ranModels = segmentModels(normalizeUsageSegments(u, null));
    // No attempt to price: this is the agent's own number, labeled as such.
    if (pricingEnabled && u.cost_usd != null) {
      const source: CostSource = u.estimated ? "estimated" : "reported";
      parts.push(fmtCost(u.cost_usd, source, tr));
      telemetryLine.push({
        kind: "cost",
        text: approx(formatMoney(u.cost_usd, tr.lang), isApproxCost(source)),
      });
    }
    telemetry = parts.join(" · ") || null;
    estimated = isEstimate;
  }
  // The words go on the panel's copy of the numbers only. On the card line the
  // tilde already carries "estimated", and one line is the whole point.
  if (telemetry && estimated) {
    telemetry += ` · ${tr.board.estimated}`;
  } else if (telemetry && t.telemetryIncomplete && !telemetry.includes(tr.board.usageNotReported)) {
    telemetry += ` · ${tr.board.telemetryIncomplete}`;
  }
  if (costReason && !telemetry) {
    telemetry = costReason;
    telemetryLine = [{ kind: "note", text: costReason }];
  } else if (costReason && telemetry && !telemetry.includes(costReason)) {
    telemetry += ` · ${costReason}`;
    telemetryLine.push({ kind: "note", text: costReason });
  }

  // The card line says what ran in one value: the claimed model, then any
  // other model the usage recorded. The detail panel keeps the claim, with
  // its effort, apart from what the usage measured.
  const ranChain = harnessChain(null, ranModels);
  const claimedChain = harnessChain(claimedModel);
  const executors = [
    ...new Set(
      t.attempts.flatMap((attempt) =>
        decodeExecutor(
          attempt.executor,
          attempt.model,
          attempt.modelSource,
        ).cli ?? [],
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));

  return {
    id: t.id,
    shortId: t.shortId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    title: t.title,
    tipo: t.tipo,
    priority: t.priority,
    status: t.status,
    supersedes: t.supersedes
      ? { id: t.supersedes.id, shortId: t.supersedes.shortId }
      : null,
    supersededBy: t.supersededBy
      ? { id: t.supersededBy.id, shortId: t.supersededBy.shortId }
      : null,
    isExample: t.isExample,
    oQue: t.oQue,
    porQue: t.porQue,
    comoConfirmo: parseComoConfirmo(t.comoConfirmo),
    validationTicks: t.validationTicks.map((tick) => ({
      index: tick.index,
      byEmail: tick.byEmail,
      at: tick.at,
    })),
    mission: t.mission?.title ?? null,
    harness,
    // The claim records the CLI as a plain name; older attempts only ever
    // wrote it inside the executor blob, which still answers here.
    ranCli:
      t.claimedByExecutor ??
      (latestAttempt
        ? (decodeExecutor(
            latestAttempt.executor,
            latestAttempt.model,
            latestAttempt.modelSource,
          ).cli ?? null)
        : null),
    executors,
    harnessChain: harnessChain(claimedModel, ranModels),
    harnessRan: ranChain && ranChain !== claimedChain ? ranChain : null,
    modelSource: latestAttempt?.modelSource ?? null,
    // The column already says "done · review". A chip only earns its place by
    // saying something the column cannot: that this one is waiting on you.
    awaitingMyReview:
      t.status === "feito" &&
      t.devolveParaKind === "human" &&
      t.devolveParaUserId === viewerId,
    devolve,
    origem: `${origem} · ${fmtDate(t.createdAt)}`,
    executor: t.claimedByExecutor ?? latestAttempt?.executor ?? null,
    elapsed: t.claimedAt ? fmtElapsed(t.claimedAt, tr) : null,
    claimInactive,
    claimStale,
    branch: t.branch ?? latestHandoff?.branch ?? null,
    commit: t.commitHash ?? latestHandoff?.commitHash ?? null,
    commitUrl: githubCommitUrl(
      t.project?.repoUrl,
      t.commitHash ?? latestHandoff?.commitHash ?? null,
    ),
    deliveryUnverified:
      t.deliveryUnverified || latestHandoff?.deliveryUnverified === true,
    deliveryVerification:
      t.deliveryVerification ?? latestHandoff?.deliveryVerification ?? null,
    deliveryWarning: t.deliveryWarning ?? latestHandoff?.deliveryWarning ?? null,
    resolvedIn: t.resolvedIn ?? null,
    reportsCount,
    timeline,
    telemetry,
    telemetryLine,
    duration,
    usageSuspect: latestAttempt?.usageSuspect ?? false,
    transcript: toTranscriptView(latestAttempt, recipes),
    handoff: latestHandoff?.summary ?? null,
    howToVerify: latestHandoff?.howToVerify ?? null,
    organizationId: t.project.organizationId,
    projectId: t.projectId,
    projectName: t.project?.name ?? t.projectId,
    missionId: t.missionId,
  };
}

/** What turning rows into cards needs to know about the workspace and the reader. */
export type BoardCardContext = {
  tr: Dict;
  pricingEnabled: boolean;
  recipes: readonly UsageRecipeRow[];
  viewerId: string;
  claimTimeoutMinutes: number;
};

export function toBoardCards(rows: TaskRow[], ctx: BoardCardContext): BoardCard[] {
  return rows.map((row) =>
    toBoardCard(
      row,
      ctx.tr,
      ctx.pricingEnabled,
      ctx.recipes,
      ctx.viewerId,
      ctx.claimTimeoutMinutes,
    ),
  );
}
