import { asc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import {
  claimInactiveMinutes,
  harnessChain,
  isClaimStale,
  mission,
  normalizeUsageSegments,
  project,
  readTranscriptRef,
  recomputeUsageCommand,
  resolveDuration,
  segmentModels,
  task,
  user,
  type CostSource,
  type ResolvedDuration,
  type UsageRecipeRow,
} from "@agent-board/db";
import { NebulaAtmosphere } from "../../components/nebula-atmosphere";
import { UpdateBanner } from "../../components/update-banner";
import { resolveBoardFilter } from "../../lib/board-filter";
import { loadBoardTotals } from "../../lib/board-totals-query";
import { getSession } from "../../lib/cookies";
import { db } from "../../lib/db";
import { dict, type Dict } from "../../lib/i18n";
import { loadModelPrices } from "../../lib/prices";
import {
  bindUsageRecipe,
  loadUsageRecipes,
  recipeForCli,
} from "../../lib/recipes";
import { detectRuntime } from "../../lib/runtime";
import { scheduledUpdateCheck } from "../../lib/update-scheduler";
import { readUpdaterState } from "../../lib/updates";
import { decodeExecutor, parseComoConfirmo } from "../../mcp/map";
import type {
  BoardCard,
  DurationView,
  TelemetrySegment,
  TranscriptView,
} from "./board";
import { HomeShell } from "./home-shell";

export const dynamic = "force-dynamic";

function fmtDurationMs(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

/**
 * Elapsed time, rounded to the unit it can honestly claim. A claim that sat
 * open all weekend is not precise to the minute, and "41h03" printed to the
 * minute is exactly what makes waiting read as work.
 */
function fmtElapsedMs(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 72) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1).replace(".0", "");
    return `${v}M tok`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k tok`;
  return `${n} tok`;
}

/*
 * The card line is three lines of card and one of them is this one. Every
 * character it spends on a unit or on a word is a character it does not have
 * for the numbers, so the compact spellings below drop both: "5m" not "5 min",
 * "155k" not "155k tok", "$1.21" not "~US$ 1.21 computed". Nothing is lost,
 * the detail panel still prints the whole thing in words.
 */

function fmtDurationShort(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

function fmtTokensShort(n: number): string {
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1).replace(".0", "");
    return `${v}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

function fmtCostShort(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * The tilde says the number is not exact: an estimate the agent volunteered,
 * or a price the board worked out from a table. One symbol replaces the word
 * "estimated" the line used to carry at the end.
 */
function approx(text: string, isApprox: boolean): string {
  return isApprox ? `~${text}` : text;
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

type TaskRow = Awaited<ReturnType<typeof loadTasks>>[number];

async function loadTasks(projectIds: string[]) {
  if (projectIds.length === 0) return [];
  return db().query.task.findMany({
    where: inArray(task.projectId, projectIds),
    orderBy: asc(task.createdAt),
    with: {
      mission: { columns: { id: true, title: true } },
      createdBy: { columns: { email: true } },
      reviewer: { columns: { email: true } },
      attempts: true,
      handoffs: true,
      comments: true,
    },
  });
}

/**
 * A duration on the card line always says which clock it read. The agent's own
 * number goes bare, because that one is work; the server measurement goes as
 * "open for 41h", because that one is only how long the card stayed claimed.
 */
function fmtResolvedDuration(duration: ResolvedDuration, tr: Dict): string {
  return duration.source === "reported"
    ? fmtDurationMs(duration.ms)
    : tr.board.openFor(fmtElapsedMs(duration.ms));
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
    ? approx(fmtDurationShort(duration.ms), isEstimate)
    : tr.board.openShort(fmtElapsedMs(duration.ms));
}

/** Both clocks for the detail panel, each one only when it was measured. */
function toDurationView(
  duration: ResolvedDuration | null,
): DurationView | null {
  if (!duration) return null;
  return {
    execution:
      duration.executionMs != null ? fmtDurationMs(duration.executionMs) : null,
    elapsed:
      duration.elapsedMs != null ? fmtElapsedMs(duration.elapsedMs) : null,
  };
}

/** "~US$ 0.42 computed": a dollar figure never travels without its source. */
function fmtCost(value: number, source: CostSource | null, tr: Dict): string {
  const label =
    source === "computed"
      ? tr.board.costComputed
      : source === "estimated"
        ? tr.board.costEstimated
        : tr.board.costReported;
  return `~US$ ${value.toFixed(2)} ${label}`;
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
  const executor = decodeExecutor(attempt.executor, attempt.model);
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
    usageCommand: recomputeUsageCommand(recipe?.command, ref.path),
  };
}

function toBoardCard(
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
  const h = t.harness;
  const plannedModel = h?.model ?? h?.modelTier ?? null;
  const harness = [plannedModel, h?.effort].filter(Boolean).join(" · ") || null;

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
        c.kind === "claim_release" ||
        c.kind === "claim_stale",
    )
    .map((c) => ({
      kind: c.kind as
        | "executor_swap"
        | "spawn_failure"
        | "report"
        | "comment"
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
        parts.push(fmtTokens(tokens));
        telemetryLine.push({
          kind: "tokens",
          text: approx(fmtTokensShort(tokens), isEstimate),
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
          // A price off a table is approximate whatever fed it, so the tilde
          // stays; what goes is the word saying where the figure came from.
          telemetryLine.push({
            kind: "cost",
            text: approx(fmtCostShort(costUsd), true),
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
      parts.push(fmtDurationMs(u.duration_ms));
      duration = { execution: fmtDurationMs(u.duration_ms), elapsed: null };
      telemetryLine.push({
        kind: "duration",
        text: approx(fmtDurationShort(u.duration_ms), isEstimate),
      });
    }
    const tokens = (u.tokens_in ?? 0) + (u.tokens_out ?? 0) + (u.tokens_cache ?? 0);
    if (tokens > 0) {
      parts.push(fmtTokens(tokens));
      telemetryLine.push({
        kind: "tokens",
        text: approx(fmtTokensShort(tokens), isEstimate),
      });
    }
    ranModels = segmentModels(normalizeUsageSegments(u, null));
    // No attempt to price: this is the agent's own number, labeled as such.
    if (pricingEnabled && u.cost_usd != null) {
      parts.push(fmtCost(u.cost_usd, u.estimated ? "estimated" : "reported", tr));
      telemetryLine.push({
        kind: "cost",
        text: approx(fmtCostShort(u.cost_usd), true),
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

  // The board says the plan and the reality in one value; the detail panel
  // still names what ran on its own, next to the effort the card asked for.
  const ranChain = harnessChain(null, ranModels);
  const plannedChain = harnessChain(plannedModel);

  return {
    id: t.id,
    shortId: t.shortId,
    title: t.title,
    tipo: t.tipo,
    priority: t.priority,
    status: t.status,
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
    plannedCli: h?.cli ?? null,
    // The claim records the CLI as a plain name; older attempts only ever
    // wrote it inside the executor blob, which still answers here.
    ranCli:
      t.claimedByExecutor ??
      (latestAttempt
        ? (decodeExecutor(latestAttempt.executor, latestAttempt.model).cli ?? null)
        : null),
    harnessChain: harnessChain(plannedModel, ranModels),
    harnessRan: ranChain && ranChain !== plannedChain ? ranChain : null,
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
    projectId: t.projectId,
    missionId: t.missionId,
  };
}

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const ws = await db().query.workspace.findFirst();
  if (!ws) redirect("/setup");
  const projects = await db().query.project.findMany({
    where: eq(project.workspaceId, ws.id),
    orderBy: asc(project.createdAt),
    columns: { id: true, name: true },
  });
  if (projects.length === 0) redirect("/setup");

  const missions = await db().query.mission.findMany({
    where: eq(mission.workspaceId, ws.id),
    orderBy: asc(mission.createdAt),
    columns: { id: true, title: true },
  });

  const [me] = await db()
    .select({
      boardProjectId: user.boardProjectId,
      boardMissionId: user.boardMissionId,
      boardTaskTypes: user.boardTaskTypes,
      boardPriorities: user.boardPriorities,
    })
    .from(user)
    .where(eq(user.id, session.userId))
    .limit(1);

  const t = dict(ws.language);
  // Opt-in only: in the default mode this instance makes zero outbound calls.
  // In automatic it also starts the update here, without holding the render.
  const release = await scheduledUpdateCheck(ws);
  // Only a live sidecar makes the banner's button do anything. Read it just
  // when there is a banner to draw.
  const updater = release ? await readUpdaterState() : null;
  const rows = await loadTasks(projects.map((item) => item.id));
  // Same rule as the Insights page: no money layer, no price table to read.
  const prices = ws.pricingEnabled ? await loadModelPrices(db(), ws.id) : [];
  // The same recipes the briefing hands agents, so the card's recompute
  // command is the one that measured the run, pinned to its transcript.
  const recipes = await loadUsageRecipes(db(), ws.id);
  const cards = rows.map((row) =>
    toBoardCard(
      row,
      t,
      ws.pricingEnabled,
      recipes,
      session.userId,
      ws.claimTimeoutMinutes,
    ),
  );
  const initialFilter = resolveBoardFilter(
    {
      projectId: me?.boardProjectId ?? null,
      missionId: me?.boardMissionId ?? null,
      types: me?.boardTaskTypes ?? null,
      priorities: me?.boardPriorities ?? null,
    },
    projects,
    missions,
  );
  // The topbar total, aggregated by the same code the Insights page runs so
  // the board and the page can only report the same numbers for one filter.
  const initialTotals = await loadBoardTotals(
    db(),
    ws.id,
    ws.pricingEnabled,
    prices,
    initialFilter,
  );

  return (
    <div className="nb nebula-surface">
      <NebulaAtmosphere />

      {release ? (
        <UpdateBanner
          version={release.version}
          changelog={release.changelog}
          url={release.url}
          helper={updater?.running ?? false}
          runtime={detectRuntime()}
          lang={ws.language}
        />
      ) : null}

      <HomeShell
        lang={ws.language}
        projects={projects}
        missions={missions}
        cards={cards}
        initialFilter={initialFilter}
        initialTotals={initialTotals}
      />

      <div className="nebula-glass-fade viewport-fade" aria-hidden="true" />
    </div>
  );
}
