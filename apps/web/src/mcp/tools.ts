import {
  assessAttemptCost,
  canNestUnder,
  cardapioEntry,
  checkUsageWindow,
  claimExpiresAt,
  derivePrefix,
  executionAttempt,
  factoryCardapioPolicy,
  handoff,
  isValidPrefix,
  isClaimStale,
  mergeTranscriptRef,
  mission,
  nextShortId,
  normalizeModelKey,
  normalizeShortId,
  project,
  readTranscriptRef,
  resolveUsageSegments,
  task,
  taskComment,
  transcriptRef,
  workspace,
  type ExecutorConfig,
  type UsageSegment,
  type UsageReport,
} from "@agent-board/db";
import {
  applyTransition,
  branchConvention,
  err,
  evaluateClaim,
  isMcpCoreError,
  isTelemetryIncomplete,
  lookupCardapioPolicy,
  MCP_TOOL_NAMES,
  ok,
  policyChain,
  recommendHarness,
  toolContracts,
  type CardapioPolicyEntry,
  type CardapioTaskType,
  type CardStatus,
  type EffortLevel,
  type Harness,
  type McpToolName,
  type ProjectMove,
  type Result,
  type Reviewer,
  type Task,
  type TranscriptRefWire,
  type Usage,
} from "@agent-board/mcp-core";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { applyExecutorUpdate, isPairInConfig } from "../lib/executors";
import {
  computeInsights,
  costSourceNote,
  filterAttemptsByPeriod,
  loadInsightAttemptRows,
  loadReopenRows,
  usageHonestyNote,
  type InsightsDb,
} from "../lib/insights";
import { loadModelPrices, type PricesDb } from "../lib/prices";
import {
  bindUsageRecipe,
  loadUsageRecipes,
  recipeForCli,
  type RecipesDb,
} from "../lib/recipes";
import { renderBriefingMarkdown } from "./briefing";
import {
  isExecutorPairConfigured,
  normalizeClaimCli,
  normalizeObservedExecutor,
  resolveClaimExecutor,
} from "./executor-identity";
import {
  decodeExecutor,
  emptyCardCounts,
  encodeExecutor,
  executorsFromWorkspace,
  harnessToDb,
  iso,
  looksLikeUuid,
  mapMission,
  mapProject,
  mapProjectDetail,
  mapTask,
  originToDb,
  parseComoConfirmo,
  reviewerFromRow,
  reviewerToColumns,
  serializeComoConfirmo,
  transcriptToWire,
  type ProjectRow,
  type TaskRow,
} from "./map";
import type { AuthContext, McpDatabase } from "./types";

type Tx = McpDatabase;

/**
 * Cards task_list returns when the caller names no limit. The answer lands
 * whole in an agent's context, so the default is a page, not a board.
 */
const DEFAULT_TASK_LIST_LIMIT = 50;

/**
 * Ends the active run without erasing its telemetry and links the old and new
 * cards. The caller holds a row lock on `original`, so create + discard can
 * live in one transaction without a zombie window.
 */
async function discardSupersededTask(
  tx: Tx,
  original: TaskRow,
  continuation: TaskRow | null,
  reason: string,
) {
  const [attempt] = await tx
    .select()
    .from(executionAttempt)
    .where(
      and(
        eq(executionAttempt.taskId, original.id),
        isNull(executionAttempt.finishedAt),
      ),
    )
    .orderBy(desc(executionAttempt.startedAt))
    .limit(1);
  const finishedAt = new Date();
  const hasUsage = Boolean(
    attempt &&
      ((attempt.usageSegments?.length ?? 0) > 0 ||
        attempt.tokensIn != null ||
        attempt.tokensOut != null ||
        attempt.tokensCache != null ||
        attempt.durationMs != null ||
        attempt.turns != null ||
        attempt.reportedCostUsd != null),
  );

  if (attempt) {
    await tx
      .update(executionAttempt)
      .set({
        finishedAt,
        result: "abandoned",
        resultNote: reason,
        serverDurationMs: Math.max(
          0,
          finishedAt.getTime() - attempt.startedAt.getTime(),
        ),
        ...(!hasUsage ? { costStatus: "not_reported" as const } : {}),
      })
      .where(eq(executionAttempt.id, attempt.id));
  }

  if (continuation) {
    await tx
      .update(task)
      .set({ supersedesId: original.id })
      .where(eq(task.id, continuation.id));
  }

  const [discarded] = await tx
    .update(task)
    .set({
      status: "descartado",
      supersededById: continuation?.id ?? null,
      claimedAt: null,
      claimedByTokenId: null,
      claimedByExecutor: null,
      telemetryIncomplete: attempt ? !hasUsage : original.telemetryIncomplete,
    })
    .where(eq(task.id, original.id))
    .returning();
  if (!discarded) throw new Error("failed to discard superseded task");
  return ok(discarded);
}

/** Last model in measured segment order, plus the full chain for the trace. */
function measuredModelIdentity(
  segments: readonly UsageSegment[] | null | undefined,
): { model: string; chain: string } | null {
  const models: string[] = [];
  for (const segment of segments ?? []) {
    if (!segment.model) continue;
    const model = normalizeModelKey(segment.model);
    if (model && !models.includes(model)) models.push(model);
  }
  const model = models.at(-1);
  return model ? { model, chain: models.join(" to ") } : null;
}

/** Distinguishes explicit zero counters from a delivery that sent no tokens. */
function tokenCountersReported(usage: UsageReport | undefined): boolean {
  return (
    (usage?.segments?.length ?? 0) > 0 ||
    usage?.tokens_in !== undefined ||
    usage?.tokens_out !== undefined ||
    usage?.tokens_cache !== undefined
  );
}

/** Canonical attempt wire shape shared by claim and release responses. */
function mapExecutionAttempt(row: typeof executionAttempt.$inferSelect) {
  const hasUsage =
    (row.usageSegments?.length ?? 0) > 0 ||
    row.tokensIn != null ||
    row.tokensOut != null ||
    row.tokensCache != null ||
    row.reportedCostUsd != null ||
    row.durationMs != null ||
    row.turns != null;
  const usage: Usage | null = hasUsage
    ? {
        ...(row.usageSegments?.length
          ? { segments: row.usageSegments }
          : {}),
        ...(row.tokensIn != null ? { tokens_in: row.tokensIn } : {}),
        ...(row.tokensOut != null ? { tokens_out: row.tokensOut } : {}),
        ...(row.tokensCache != null ? { tokens_cache: row.tokensCache } : {}),
        ...(row.reportedCostUsd != null
          ? { cost_usd: Number(row.reportedCostUsd) }
          : {}),
        ...(row.durationMs != null ? { duration_ms: row.durationMs } : {}),
        ...(row.turns != null ? { turns: row.turns } : {}),
        estimated: row.usageEstimated,
      }
    : null;
  return {
    id: row.id,
    task_id: row.taskId,
    executor: decodeExecutor(row.executor, row.model, row.modelSource),
    started_at: iso(row.startedAt),
    last_activity_at: iso(row.lastActivityAt),
    finished_at: row.finishedAt ? iso(row.finishedAt) : null,
    usage,
    usage_suspect: row.usageSuspect,
    usage_suspect_reason: row.usageSuspectReason,
    result: row.result as "success" | "failure" | "abandoned" | null,
    result_note: row.resultNote,
    transcript: transcriptToWire(row.transcript),
  };
}

export async function invokeTool(
  db: McpDatabase,
  ctx: AuthContext,
  name: McpToolName,
  args: unknown,
): Promise<Result<unknown>> {
  const contract = toolContracts[name];
  const parsed = contract.input.safeParse(args ?? {});
  if (!parsed.success) {
    return err(
      "INVALID_ARGUMENT",
      parsed.error.issues[0]?.message ?? "invalid arguments",
      parsed.error.flatten(),
    );
  }

  let value: unknown;
  try {
    value = await dispatchTool(db, ctx, name, parsed.data);
  } catch (error) {
    // Nothing below this layer may reach the agent raw: a thrown driver error
    // carries the failed SQL in its message.
    if (isMcpCoreError(error)) {
      return { ok: false, error };
    }
    console.error(`[mcp] ${name} threw`, error);
    return err(
      "INTERNAL",
      `Unexpected server error while running ${name}. Check the ids and values you passed and try again; the server logs have the details.`,
    );
  }

  if (value && typeof value === "object" && "ok" in value && (value as Result<unknown>).ok === false) {
    return value as Result<unknown>;
  }

  const output = contract.output.safeParse(value);
  if (!output.success) {
    return err(
      "INVALID_ARGUMENT",
      `invalid response from ${name}: ${output.error.issues[0]?.message ?? "schema"}`,
      output.error.flatten(),
    );
  }
  return ok(output.data);
}

async function dispatchTool(
  db: McpDatabase,
  ctx: AuthContext,
  name: McpToolName,
  data: unknown,
): Promise<unknown> {
  let value: unknown;
  switch (name) {
    case "project_list":
      value = await projectList(db, ctx);
      break;
    case "project_get":
      value = await projectGet(
        db,
        ctx,
        data as Parameters<typeof projectGet>[2],
      );
      break;
    case "project_create":
      value = await projectCreate(
        db,
        ctx,
        data as Parameters<typeof projectCreate>[2],
      );
      break;
    case "project_update":
      value = await projectUpdate(
        db,
        ctx,
        data as Parameters<typeof projectUpdate>[2],
      );
      break;
    case "project_delete":
      value = await projectDelete(
        db,
        ctx,
        data as Parameters<typeof projectDelete>[2],
      );
      break;
    case "mission_list":
      value = await missionList(db, ctx, data as Parameters<typeof missionList>[2]);
      break;
    case "mission_get":
      value = await missionGet(db, ctx, data as Parameters<typeof missionGet>[2]);
      break;
    case "mission_create":
      value = await missionCreate(
        db,
        ctx,
        data as Parameters<typeof missionCreate>[2],
      );
      break;
    case "mission_update":
      value = await missionUpdate(
        db,
        ctx,
        data as Parameters<typeof missionUpdate>[2],
      );
      break;
    case "mission_delete":
      value = await missionDelete(
        db,
        ctx,
        data as Parameters<typeof missionDelete>[2],
      );
      break;
    case "task_list":
      value = await taskList(db, ctx, data as Parameters<typeof taskList>[2]);
      break;
    case "task_get":
      value = await taskGet(db, ctx, data as Parameters<typeof taskGet>[2]);
      break;
    case "task_search":
      value = await taskSearch(db, ctx, data as Parameters<typeof taskSearch>[2]);
      break;
    case "task_create":
      value = await taskCreate(db, ctx, data as Parameters<typeof taskCreate>[2]);
      break;
    case "task_claim":
      value = await taskClaim(db, ctx, data as Parameters<typeof taskClaim>[2]);
      break;
    case "task_release":
      value = await taskRelease(db, ctx, data as Parameters<typeof taskRelease>[2]);
      break;
    case "task_heartbeat":
      value = await taskHeartbeat(
        db,
        ctx,
        data as Parameters<typeof taskHeartbeat>[2],
      );
      break;
    case "task_update":
      value = await taskUpdate(db, ctx, data as Parameters<typeof taskUpdate>[2]);
      break;
    case "task_deliver":
      value = await taskDeliver(db, ctx, data as Parameters<typeof taskDeliver>[2]);
      break;
    case "task_delete":
      value = await taskDelete(db, ctx, data as Parameters<typeof taskDelete>[2]);
      break;
    case "branch_register":
      value = await branchRegister(db, ctx, data as Parameters<typeof branchRegister>[2]);
      break;
    case "harness_recommend":
      value = await harnessRecommend(
        db,
        ctx,
        data as Parameters<typeof harnessRecommend>[2],
      );
      break;
    case "harness_list":
      value = await harnessList(db, ctx);
      break;
    case "harness_set":
      value = await harnessSet(db, ctx, data as Parameters<typeof harnessSet>[2]);
      break;
    case "insights_query":
      value = await insightsQuery(
        db,
        ctx,
        data as Parameters<typeof insightsQuery>[2],
      );
      break;
    case "executors_update":
      value = await executorsUpdate(
        db,
        ctx,
        data as Parameters<typeof executorsUpdate>[2],
      );
      break;
    default: {
      const _never: never = name;
      return err("INVALID_ARGUMENT", `unknown tool: ${String(_never)}`);
    }
  }
  return value;
}

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Every message that sends an agent back to the project tools says the same thing. */
const PROJECT_HINT =
  "Call project_list to see the projects in this workspace, or project_create to start one.";

async function projectList(db: McpDatabase, ctx: AuthContext) {
  const rows = await db
    .select()
    .from(project)
    .where(eq(project.workspaceId, ctx.workspaceId))
    .orderBy(asc(project.createdAt));

  const ids = rows.map((row) => row.id);
  const counts =
    ids.length === 0
      ? []
      : await db
          .select({ projectId: task.projectId, status: task.status, n: count() })
          .from(task)
          .where(inArray(task.projectId, ids))
          .groupBy(task.projectId, task.status);

  const byProject = new Map<string, ReturnType<typeof emptyCardCounts>>();
  for (const row of counts) {
    const tally = byProject.get(row.projectId) ?? emptyCardCounts();
    const n = Number(row.n);
    tally[row.status] += n;
    tally.total += n;
    byProject.set(row.projectId, tally);
  }

  return {
    projects: rows.map((row) =>
      mapProject(row, byProject.get(row.id) ?? emptyCardCounts()),
    ),
  };
}

async function projectGet(
  db: McpDatabase,
  ctx: AuthContext,
  input: { project_id: string },
) {
  const row = await findProject(db, ctx.workspaceId, input.project_id);
  if (!row) {
    return err(
      "NOT_FOUND",
      `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
    );
  }
  return {
    project: mapProjectDetail(row, await projectCardCounts(db, row.id)),
  };
}

async function projectCreate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    name: string;
    repo_url?: string;
    context?: string;
    current_version?: string;
    id_prefix?: string;
  },
) {
  const name = input.name.trim();
  if (!name) {
    return err("INVALID_ARGUMENT", "Project name cannot be empty.");
  }

  const explicit = input.id_prefix?.trim().toUpperCase();
  const prefix = explicit ?? derivePrefix(name);
  if (!prefix) {
    return err(
      "INVALID_ARGUMENT",
      `Could not derive a card prefix from '${name}'. Pass id_prefix explicitly: 2 to 4 letters or digits, for example AGB.`,
    );
  }
  if (!isValidPrefix(prefix)) {
    return err(
      "INVALID_ARGUMENT",
      `Card prefix '${prefix}' is invalid: use 2 to 4 letters or digits, for example AGB.`,
    );
  }

  // The prefix is what every card carries (AGB-1, AGB-2), so a collision would
  // make two projects indistinguishable on the board. Checked here for a clean
  // message, and again by the unique index below for concurrent creates.
  const taken = await findProject(db, ctx.workspaceId, prefix);
  if (taken) {
    return err(
      "INVALID_ARGUMENT",
      `Card prefix '${prefix}' is already used by project '${taken.name}'. Pass a different id_prefix.`,
    );
  }

  let row: ProjectRow | undefined;
  try {
    [row] = await db
      .insert(project)
      .values({
        workspaceId: ctx.workspaceId,
        name,
        repoUrl: input.repo_url?.trim() || null,
        context: input.context?.trim() ? input.context : null,
        currentVersion: input.current_version?.trim() || null,
        idPrefix: prefix,
        nextNumber: 1,
      })
      .returning();
  } catch (error) {
    if (isPrefixConflict(error)) {
      return err(
        "INVALID_ARGUMENT",
        `Card prefix '${prefix}' was just taken by another project. Pass a different id_prefix.`,
      );
    }
    throw error;
  }
  if (!row) {
    throw new Error("failed to insert project");
  }

  return { project: mapProjectDetail(row, emptyCardCounts()) };
}

function isPrefixConflict(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
  return message.includes("project_workspace_prefix");
}

async function countCards(db: Tx, projectId: string): Promise<number> {
  const [counted] = await db
    .select({ n: count() })
    .from(task)
    .where(eq(task.projectId, projectId));
  return Number(counted?.n ?? 0);
}

async function projectCardCounts(db: Tx, projectId: string) {
  const rows = await db
    .select({ status: task.status, n: count() })
    .from(task)
    .where(eq(task.projectId, projectId))
    .groupBy(task.status);
  const tally = emptyCardCounts();
  for (const row of rows) {
    const n = Number(row.n);
    tally[row.status] += n;
    tally.total += n;
  }
  return tally;
}

async function projectUpdate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    project_id: string;
    name?: string;
    repo_url?: string | null;
    context?: string | null;
    current_version?: string | null;
    id_prefix?: string;
  },
) {
  const proj = await findProject(db, ctx.workspaceId, input.project_id);
  if (!proj) {
    return err(
      "NOT_FOUND",
      `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
    );
  }

  const patch: {
    name?: string;
    repoUrl?: string | null;
    context?: string | null;
    currentVersion?: string | null;
    idPrefix?: string;
  } = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      return err("INVALID_ARGUMENT", "Project name cannot be empty.");
    }
    patch.name = name;
  }

  if (input.repo_url !== undefined) {
    patch.repoUrl = input.repo_url?.trim() || null;
  }

  if (input.context !== undefined) {
    patch.context = input.context?.trim() ? input.context : null;
  }

  if (input.current_version !== undefined) {
    patch.currentVersion = input.current_version?.trim() || null;
  }

  if (input.id_prefix !== undefined) {
    const prefix = input.id_prefix.trim().toUpperCase();
    if (!isValidPrefix(prefix)) {
      return err(
        "INVALID_ARGUMENT",
        `Card prefix '${prefix}' is invalid: use 2 to 4 letters or digits, for example AGB.`,
      );
    }
    if (prefix !== proj.idPrefix) {
      // Every card already carries the prefix in its short id (FUN-1, FUN-2),
      // and those ids live outside the board too: branches, commits, PR
      // titles. Rewriting the prefix here would either leave the board naming
      // cards that never existed or silently break every external reference,
      // so the project keeps its prefix for as long as it holds cards.
      const cards = await countCards(db, proj.id);
      if (cards > 0) {
        return err(
          "INVALID_ARGUMENT",
          `Project '${proj.name}' holds ${cards} card${cards === 1 ? "" : "s"} whose short ids already start with ${proj.idPrefix} (${proj.idPrefix}-1, ${proj.idPrefix}-2), and those ids are also in branches, commits and PR titles. Renumbering them is not offered. To reorganize, create the project you want with project_create and move the cards into it with task_update passing project_id: each card is restamped with the destination prefix, keeps its old id in previous_short_ids, and the response returns the old-to-new mapping. The prefix of an empty project can still be changed here.`,
        );
      }
      const taken = await findProject(db, ctx.workspaceId, prefix);
      if (taken) {
        return err(
          "INVALID_ARGUMENT",
          `Card prefix '${prefix}' is already used by project '${taken.name}'. Pass a different id_prefix.`,
        );
      }
      patch.idPrefix = prefix;
    }
  }

  let row: ProjectRow | undefined;
  try {
    [row] = await db
      .update(project)
      .set(patch)
      .where(eq(project.id, proj.id))
      .returning();
  } catch (error) {
    if (isPrefixConflict(error)) {
      return err(
        "INVALID_ARGUMENT",
        `Card prefix '${patch.idPrefix}' was just taken by another project. Pass a different id_prefix.`,
      );
    }
    throw error;
  }
  if (!row) {
    throw new Error("failed to update project");
  }

  const counts = await projectCardCounts(db, row.id);
  return { project: mapProjectDetail(row, counts) };
}

async function projectDelete(
  db: McpDatabase,
  ctx: AuthContext,
  input: { project_id: string; force?: boolean },
) {
  const proj = await findProject(db, ctx.workspaceId, input.project_id);
  if (!proj) {
    return err(
      "NOT_FOUND",
      `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
    );
  }

  return db.transaction(async (tx) => {
    const ids = await tx
      .select({ id: task.id })
      .from(task)
      .where(eq(task.projectId, proj.id));
    const taskIds = ids.map((row) => row.id);

    // task.project_id cascades: deleting the project would take every card
    // with it, silently. That is only ever the answer when force says so.
    if (taskIds.length > 0 && input.force !== true) {
      return err(
        "INVALID_ARGUMENT",
        `Project '${proj.name}' (${proj.idPrefix}) holds ${taskIds.length} card${taskIds.length === 1 ? "" : "s"}, subtasks included, and deleting it would destroy all of them. Move them to another project first with task_update passing project_id, or repeat this call with force: true to delete the project and its ${taskIds.length} card${taskIds.length === 1 ? "" : "s"}. Hard delete: irreversible.`,
      );
    }

    let attempts = 0;
    let handoffs = 0;
    if (taskIds.length > 0) {
      const [attemptRow] = await tx
        .select({ n: count() })
        .from(executionAttempt)
        .where(inArray(executionAttempt.taskId, taskIds));
      const [handoffRow] = await tx
        .select({ n: count() })
        .from(handoff)
        .where(inArray(handoff.taskId, taskIds));
      attempts = Number(attemptRow?.n ?? 0);
      handoffs = Number(handoffRow?.n ?? 0);
    }

    await tx.delete(project).where(eq(project.id, proj.id));

    return {
      deleted: true as const,
      project_id: proj.id,
      id_prefix: proj.idPrefix,
      name: proj.name,
      tasks_deleted: taskIds.length,
      attempts_deleted: attempts,
      handoffs_deleted: handoffs,
    };
  });
}

async function missionList(
  db: McpDatabase,
  ctx: AuthContext,
  input: { status?: "ativa" | "pausada" | "concluida" },
) {
  const filters = [eq(mission.workspaceId, ctx.workspaceId)];
  if (input.status) filters.push(eq(mission.status, input.status));

  const rows = await db
    .select()
    .from(mission)
    .where(and(...filters))
    .orderBy(asc(mission.createdAt));

  const ids = rows.map((row) => row.id);
  const counts =
    ids.length === 0
      ? []
      : await db
          .select({ missionId: task.missionId, n: count() })
          .from(task)
          .where(inArray(task.missionId, ids))
          .groupBy(task.missionId);
  const byMission = new Map(counts.map((row) => [row.missionId, Number(row.n)]));

  return {
    missions: rows.map((row) => mapMission(row, byMission.get(row.id) ?? 0)),
  };
}

async function missionGet(
  db: McpDatabase,
  ctx: AuthContext,
  input: { mission_id: string },
) {
  const row = await findMission(db, ctx.workspaceId, input.mission_id);
  if (!row) {
    return err(
      "NOT_FOUND",
      `Mission ${input.mission_id} not found. Call mission_list to see the available missions.`,
    );
  }
  const [counted] = await db
    .select({ n: count() })
    .from(task)
    .where(eq(task.missionId, row.id));
  return { mission: mapMission(row, Number(counted?.n ?? 0)) };
}

async function missionCreate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    title: string;
    objective?: string;
    context?: string;
    status?: "ativa" | "pausada" | "concluida";
  },
) {
  const objective = (input.objective ?? input.context ?? "").trim();
  const context = (input.context ?? input.objective ?? "").trim();
  const [row] = await db
    .insert(mission)
    .values({
      workspaceId: ctx.workspaceId,
      title: input.title.trim(),
      objective,
      context,
      status: input.status ?? "ativa",
    })
    .returning();
  if (!row) {
    throw new Error("failed to insert mission");
  }
  return { mission: mapMission(row, 0) };
}

async function missionUpdate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    mission_id: string;
    title?: string;
    objective?: string;
    context?: string;
    status?: "ativa" | "pausada" | "concluida";
  },
) {
  const current = await findMission(db, ctx.workspaceId, input.mission_id);
  if (!current) {
    return err(
      "NOT_FOUND",
      `Mission ${input.mission_id} not found in this workspace. Call mission_list to see the available missions.`,
    );
  }

  const patch: {
    title?: string;
    objective?: string;
    context?: string;
    status?: "ativa" | "pausada" | "concluida";
  } = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.objective !== undefined) patch.objective = input.objective.trim();
  if (input.context !== undefined) patch.context = input.context.trim();
  if (input.status !== undefined) patch.status = input.status;

  if (Object.keys(patch).length === 0) {
    const [counted] = await db
      .select({ n: count() })
      .from(task)
      .where(eq(task.missionId, current.id));
    return { mission: mapMission(current, Number(counted?.n ?? 0)) };
  }

  const [row] = await db
    .update(mission)
    .set(patch)
    .where(
      and(
        eq(mission.id, current.id),
        eq(mission.workspaceId, ctx.workspaceId),
      ),
    )
    .returning();
  if (!row) throw new Error("failed to update mission");

  const [counted] = await db
    .select({ n: count() })
    .from(task)
    .where(eq(task.missionId, row.id));
  return { mission: mapMission(row, Number(counted?.n ?? 0)) };
}

async function missionDelete(
  db: McpDatabase,
  ctx: AuthContext,
  input: { mission_id: string; force?: boolean },
) {
  const current = await findMission(db, ctx.workspaceId, input.mission_id);
  if (!current) {
    return err(
      "NOT_FOUND",
      `Mission ${input.mission_id} not found in this workspace. Call mission_list to see the available missions.`,
    );
  }

  return db.transaction(async (tx) => {
    const [counted] = await tx
      .select({ n: count() })
      .from(task)
      .where(eq(task.missionId, current.id));
    const taskCount = Number(counted?.n ?? 0);

    if (taskCount > 0 && input.force !== true) {
      return err(
        "INVALID_ARGUMENT",
        `Mission '${current.title}' holds ${taskCount} card${taskCount === 1 ? "" : "s"}. Move or detach them first with task_update passing mission_id: null, or repeat this call with force: true to detach all ${taskCount} card${taskCount === 1 ? "" : "s"} and delete the mission.`,
      );
    }

    if (taskCount > 0) {
      await tx
        .update(task)
        .set({ missionId: null })
        .where(eq(task.missionId, current.id));
    }
    await tx
      .delete(mission)
      .where(
        and(
          eq(mission.id, current.id),
          eq(mission.workspaceId, ctx.workspaceId),
        ),
      );

    return {
      deleted: true as const,
      mission_id: current.id,
      title: current.title,
      tasks_detached: taskCount,
    };
  });
}

async function taskList(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    project_id?: string;
    mission_id?: string;
    status?: CardStatus | CardStatus[];
    priority?: Task["priority"];
    type?: Task["type"];
    awaiting_review_by?: "me" | string;
    limit?: number;
  },
) {
  const limit = input.limit ?? DEFAULT_TASK_LIST_LIMIT;
  const filters = [eq(project.workspaceId, ctx.workspaceId)];
  if (input.project_id) {
    const proj = await findProject(db, ctx.workspaceId, input.project_id);
    if (!proj) {
      return err(
        "NOT_FOUND",
        `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
      );
    }
    filters.push(eq(task.projectId, proj.id));
  }
  if (input.mission_id) {
    if (!looksLikeUuid(input.mission_id)) {
      return err(
        "NOT_FOUND",
        `Mission ${input.mission_id} not found. Call mission_list to see the available missions.`,
      );
    }
    filters.push(eq(task.missionId, input.mission_id));
  }
  if (input.priority) filters.push(eq(task.priority, input.priority));
  if (input.type) filters.push(eq(task.tipo, input.type));

  if (input.awaiting_review_by !== undefined) {
    filters.push(eq(task.status, "feito"));
    if (input.awaiting_review_by === "me") {
      filters.push(eq(task.devolveParaKind, "agent"));
    } else {
      // Only probe the uuid user column with a uuid; anything else is an
      // agent ref and would otherwise blow up as a raw uuid cast error.
      filters.push(
        looksLikeUuid(input.awaiting_review_by)
          ? or(
              eq(task.devolveParaUserId, input.awaiting_review_by),
              eq(task.devolveParaAgentRef, input.awaiting_review_by),
            )!
          : eq(task.devolveParaAgentRef, input.awaiting_review_by),
      );
    }
  } else if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    filters.push(inArray(task.status, statuses));
  }

  // One past the limit: enough to know another card exists without paying
  // for a second count query on every call.
  const rows = await db
    .select({ task, project })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .where(and(...filters))
    .orderBy(asc(task.createdAt))
    .limit(limit + 1);

  const truncated = rows.length > limit;

  return {
    truncated,
    limit,
    tasks: rows.slice(0, limit).map((row) => {
      const mapped = mapTask(row.task, row.project);
      return {
        id: mapped.id,
        short_id: mapped.short_id,
        title: mapped.title,
        type: mapped.type,
        status: mapped.status,
        revisado: mapped.revisado,
        priority: mapped.priority,
        project_id: mapped.project_id,
        mission_id: mapped.mission_id,
        devolve_para: mapped.devolve_para,
      };
    }),
  };
}

async function taskGet(
  db: McpDatabase,
  ctx: AuthContext,
  input: { task_id: string },
) {
  const found = await findTask(db, ctx.workspaceId, input.task_id);
  if (!found) {
    return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
  }
  return assembleTaskPayload(
    db,
    found.row,
    found.proj,
    undefined,
    undefined,
    await countReports(db, found.row),
  );
}

/**
 * Free-text search over the workspace's cards. Ranking is Postgres FTS with
 * the `simple` dictionary (no stemming, so it behaves the same in any
 * language) over title, o_que, por_que and comment bodies; a query that FTS
 * turns into nothing (a lone number, a code fragment) falls back to substring
 * matching per term so partial hits still appear below the full FTS matches.
 * No new extension and no index: workspaces are small, and a GIN index is a
 * one-line follow-up when one is not.
 */
async function taskSearch(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    q: string;
    project_id?: string;
    type?: Task["type"];
    status?: CardStatus | CardStatus[];
    limit?: number;
  },
) {
  const q = input.q.trim();
  if (!q) return err("INVALID_ARGUMENT", "Search query cannot be empty.");

  const limit = input.limit ?? 5;
  const filters = [eq(project.workspaceId, ctx.workspaceId)];
  if (input.project_id) {
    const proj = await findProject(db, ctx.workspaceId, input.project_id);
    if (!proj) {
      return err(
        "NOT_FOUND",
        `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
      );
    }
    filters.push(eq(task.projectId, proj.id));
  }
  if (input.type) filters.push(eq(task.tipo, input.type));
  if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    filters.push(inArray(task.status, statuses));
  }

  const commentText = sql<string>`coalesce((
    select string_agg(${taskComment.body}, ' ')
    from ${taskComment}
    where ${taskComment.taskId} = ${task.id}
  ), '')`;
  const doc = sql`
    setweight(to_tsvector('simple', ${task.title}), 'A') ||
    setweight(to_tsvector('simple', ${task.oQue} || ' ' || ${task.porQue} || ' ' || ${commentText}), 'B')
  `;
  const tsq = sql`plainto_tsquery('simple', ${q})`;
  const rank = sql<number>`ts_rank(${doc}, ${tsq})`;

  const terms = q.split(/\s+/).filter(Boolean);
  const likeAny = or(
    ...terms.map((term) => {
      const pattern = `%${term.replace(/[%_\\]/g, (match) => `\\${match}`)}%`;
      return or(
        sql`${task.title} ILIKE ${pattern}`,
        sql`${task.oQue} ILIKE ${pattern}`,
        sql`${task.porQue} ILIKE ${pattern}`,
        sql`${commentText} ILIKE ${pattern}`,
      )!;
    }),
  )!;

  const commentsCount = sql<number>`(
    select count(*) from ${taskComment} where ${taskComment.taskId} = ${task.id}
  )`;
  const reportsCount = sql<number>`(
    select count(*) from ${taskComment}
    where ${taskComment.taskId} = ${task.id} and ${taskComment.kind} = 'report'
  )`;

  const select = () =>
    db
      .select({
        task,
        rank,
        commentsCount,
        reportsCount,
      })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id));

  const rows = await select()
    .where(and(...filters, or(sql`${doc} @@ ${tsq}`, likeAny)))
    .orderBy(desc(rank), desc(task.updatedAt))
    .limit(limit);

  return {
    tasks: rows.map((row) => ({
      id: row.task.id,
      short_id: row.task.shortId,
      title: row.task.title,
      type: row.task.tipo,
      status: row.task.status,
      resolved_in: row.task.resolvedIn ?? null,
      o_que: row.task.oQue.slice(0, 300),
      comments_count: Number(row.commentsCount ?? 0),
      reports_count: Number(row.reportsCount ?? 0),
      updated_at: iso(row.task.updatedAt),
    })),
  };
}

async function taskCreate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    mission?: string;
    project_id: string;
    title: string;
    type: Task["type"];
    o_que?: string;
    por_que?: string;
    como_confirmo?: Task["como_confirmo"];
    supersedes?: string;
    inherit?: boolean;
    priority?: Task["priority"];
    parent?: string;
    mode: "solo" | "team";
    subtasks?: Array<{
      title: string;
      scope: string;
      boundary: string;
      o_que?: string;
      por_que?: string;
      como_confirmo?: Task["como_confirmo"];
      harness?: Harness;
      devolve_para?: Reviewer;
    }>;
    devolve_para?: Reviewer;
    harness?: Harness;
    origem: Task["origem"];
  },
) {
  const proj = await findProject(db, ctx.workspaceId, input.project_id);
  if (!proj) {
    return err(
      "NOT_FOUND",
      `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
    );
  }

  let missionId: string | null = null;
  if (input.mission) {
    const miss = await findMission(db, ctx.workspaceId, input.mission);
    if (!miss) {
      return err(
        "NOT_FOUND",
        `Mission ${input.mission} not found. Call mission_list to see the available missions or mission_create to start one.`,
      );
    }
    missionId = miss.id;
  }

  let parentRow: TaskRow | null = null;
  if (input.parent) {
    const parent = await findTask(db, ctx.workspaceId, input.parent);
    if (!parent) {
      return err(
        "NOT_FOUND",
        `Parent task ${input.parent} not found in this workspace. Call task_list to see the available cards.`,
      );
    }
    if (!canNestUnder({ parentId: parent.row.parentId })) {
      return err(
        "INVALID_ARGUMENT",
        "Subtasks only nest one level deep and this parent is already a subtask. Use its parent card instead.",
      );
    }
    parentRow = parent.row;
  }

  const rec = await recommendFor(db, ctx.workspaceId, input.type, input.harness);
  if (!rec.ok) return rec;

  const reviewer = reviewerToColumns(input.devolve_para);
  const harness = harnessToDb(rec.value.harness);

  return db.transaction(async (tx) => {
    const original = input.supersedes
      ? await findTask(tx, ctx.workspaceId, input.supersedes, true)
      : null;
    if (input.supersedes && !original) {
      return err(
        "NOT_FOUND",
        `Task ${input.supersedes} not found in this workspace. Call task_list to see the available cards.`,
      );
    }
    if (original && original.row.status !== "em_execucao") {
      return err(
        "INVALID_ARGUMENT",
        `${original.row.shortId} cannot be superseded because it is ${original.row.status}; only a card in execution can be continued this way.`,
      );
    }

    const oQue = input.o_que ?? (input.inherit ? original?.row.oQue : undefined);
    const porQue = input.por_que ?? (input.inherit ? original?.row.porQue : undefined);
    const comoConfirmo =
      input.como_confirmo ??
      (input.inherit && original
        ? parseComoConfirmo(original.row.comoConfirmo)
        : undefined);
    if (!oQue || !porQue || !comoConfirmo?.length) {
      return err(
        "INVALID_ARGUMENT",
        "o_que, por_que and como_confirmo are required unless inherit: true reuses them from supersedes.",
      );
    }

    const shortId = parentRow
      ? await nextChildShortId(tx, parentRow)
      : await allocateShortId(tx, proj);

    const subtasks = input.mode === "team" ? (input.subtasks ?? []) : [];
    const plano =
      subtasks.length > 0
        ? [
            "",
            "## Plano",
            ...subtasks.map(
              (item, index) =>
                `- ${shortId}.${index + 1} ${item.title} — ${item.scope} (fronteira: ${item.boundary})`,
            ),
          ].join("\n")
        : "";

    const [created] = await tx
      .insert(task)
      .values({
        projectId: proj.id,
        missionId,
        parentId: parentRow?.id ?? null,
        supersedesId: original?.row.id ?? null,
        shortId,
        title: input.title,
        oQue: `${oQue}${plano}`,
        porQue,
        comoConfirmo: serializeComoConfirmo(comoConfirmo),
        tipo: input.type,
        status: "aberto",
        priority: input.priority ?? "media",
        ...reviewer,
        harness,
        origin: originToDb(input.origem),
        mode: input.mode,
      })
      .returning();
    if (!created) {
      throw new Error("failed to insert task");
    }

    if (original) {
      const discarded = await discardSupersededTask(
        tx,
        original.row,
        created,
        `superseded by ${created.shortId}`,
      );
      if (!discarded.ok) return discarded;
    }

    const children: TaskRow[] = [];
    for (const [index, item] of subtasks.entries()) {
      const childRec = item.harness
        ? await recommendFor(db, ctx.workspaceId, input.type, item.harness)
        : rec;
      if (!childRec.ok) throw childRec.error;

      const [child] = await tx
        .insert(task)
        .values({
          projectId: proj.id,
          missionId,
          parentId: created.id,
          shortId: `${shortId}.${index + 1}`,
          title: item.title,
          oQue: item.o_que ?? item.scope,
          porQue: item.por_que ?? porQue,
          comoConfirmo: serializeComoConfirmo(
            item.como_confirmo ?? comoConfirmo,
          ),
          tipo: input.type,
          status: "aberto",
          priority: input.priority ?? "media",
          ...reviewerToColumns(item.devolve_para ?? input.devolve_para),
          harness: harnessToDb(childRec.value.harness),
          origin: originToDb(input.origem),
          mode: "solo",
        })
        .returning();
      if (!child) throw new Error("failed to insert subtask");
      children.push(child);
    }

    return {
      task: mapTask(created, proj),
      subtasks: children.map((child) => mapTask(child, proj)),
    };
  });
}

async function taskClaim(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    task_id: string;
    force?: boolean;
    executor?: {
      cli?: string;
      model?: string;
      agent?: string;
      session_id?: string;
    };
    transcript?: TranscriptRefWire;
  },
) {
  const claimed = await db.transaction(async (tx) => {
    const found = await findTask(tx, ctx.workspaceId, input.task_id, true);
    if (!found) {
      return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
    }

    const [ws] = await tx
      .select({ claimTimeoutMinutes: workspace.claimTimeoutMinutes })
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId))
      .limit(1);
    if (!ws) {
      return err(
        "NOT_FOUND",
        "The workspace for this token no longer exists. Generate a new token in the board Settings.",
      );
    }

    const [previousAttempt] = await tx
      .select()
      .from(executionAttempt)
      .where(
        and(
          eq(executionAttempt.taskId, found.row.id),
          isNull(executionAttempt.finishedAt),
        ),
      )
      .orderBy(desc(executionAttempt.startedAt))
      .limit(1);
    const lastActivity =
      previousAttempt?.lastActivityAt ?? found.row.claimedAt ?? null;
    const reclaimedStale = Boolean(
      found.row.status === "em_execucao" &&
        !input.force &&
        lastActivity &&
        isClaimStale(lastActivity, ws.claimTimeoutMinutes),
    );

    const reopenComment = await latestReopenComment(tx, found.row);
    const evaluated = evaluateClaim(
      {
        id: found.row.id,
        status: found.row.status,
        revisado: found.row.revisado,
        reopen_comment: reopenComment,
        claimed_by: found.row.claimedByTokenId,
        attempt_id: null,
      },
      {
        task_id: found.row.id,
        force: input.force || reclaimedStale,
        actor: {
          token_id: ctx.tokenId,
          token_revoked: false,
          executor: input.executor,
        },
      },
    );
    if (!evaluated.ok) return evaluated;

    // A rejected delivery does not go back to the model that produced it.
    const escalated = await escalatedHarnessForRetry(tx, ctx.workspaceId, found.row);
    const effectiveHarness = escalated ?? found.row.harness;
    const executor = resolveClaimExecutor(input.executor, effectiveHarness);
    // The transcript uses the same contextual CLI as the attempt. An
    // orchestrator calling itself "overclock" therefore resolves to the
    // harness connection that really ran the card.
    const claimTranscript = transcriptRef({
      cli:
        normalizeClaimCli(input.transcript?.cli, effectiveHarness?.cli) ??
        executor.cli,
      sessionId: input.transcript?.session_id ?? executor.session_id,
      path: input.transcript?.path,
      resume: input.transcript?.resume,
    });

    const now = new Date();
    const [updated] = await tx
      .update(task)
      .set({
        status: "em_execucao",
        claimedAt: now,
        claimedByTokenId: ctx.tokenId,
        claimedByExecutor:
          executor.cli ?? executor.agent ?? ctx.tokenLabel,
        ...(escalated ? { harness: escalated } : {}),
      })
      .where(
        and(
          eq(task.id, found.row.id),
          eq(task.status, evaluated.value.cas.expected_status),
        ),
      )
      .returning();
    if (!updated) {
      return err(
        "ALREADY_CLAIMED",
        "Another executor took the card first. Call task_get to see its current status.",
      );
    }

    if (input.force || reclaimedStale) {
      await tx
        .update(executionAttempt)
        .set({
          finishedAt: now,
          lastActivityAt: now,
          result: "abandoned",
          resultNote: reclaimedStale ? "stale" : "force claim takeover",
          ...(previousAttempt
            ? {
                serverDurationMs: Math.max(
                  0,
                  now.getTime() - previousAttempt.startedAt.getTime(),
                ),
              }
            : {}),
        })
        .where(
          and(
            eq(executionAttempt.taskId, updated.id),
            isNull(executionAttempt.finishedAt),
          ),
        );
    }

    const [attempt] = await tx
      .insert(executionAttempt)
      .values({
        taskId: updated.id,
        executor: encodeExecutor({
          token_id: ctx.tokenId,
          cli: executor.cli,
          agent: executor.agent,
          session_id: executor.session_id,
        }),
        model: executor.model ?? null,
        modelSource: executor.model_source ?? null,
        sessionId:
          executor.session_id ?? input.transcript?.session_id ?? null,
        transcript: claimTranscript,
        lastActivityAt: now,
      })
      .returning();
    if (!attempt) throw new Error("failed to insert execution_attempt");

    if (reclaimedStale) {
      await tx.insert(taskComment).values({
        taskId: updated.id,
        authorAgentRef: ctx.tokenLabel,
        kind: "claim_stale",
        body: `previous claim expired after ${ws.claimTimeoutMinutes} minutes without activity; reclaimed by ${ctx.tokenLabel}`,
      });
    }

    return ok({
      updated,
      proj: found.proj,
      attempt,
      reopenComment,
      reclaimedStale,
      executor,
    });
  });

  if (!claimed.ok) return claimed;

  await recordSeenExecutor(db, ctx.workspaceId, {
    cli: claimed.value.executor.cli,
    model: claimed.value.executor.model,
  });

  const payload = await assembleTaskPayload(
    db,
    claimed.value.updated,
    claimed.value.proj,
    claimed.value.reopenComment,
    claimed.value.executor.cli ?? null,
    0,
    {
      sessionId: claimed.value.executor.session_id,
      model: claimed.value.executor.model,
      reclaimedStale: claimed.value.reclaimedStale,
    },
  );
  if (!payload || ("ok" in payload && payload.ok === false)) return payload;

  const recommended = payload.task.harness;
  const actual = claimed.value.executor;
  const divergence =
    recommended &&
    actual.model &&
    normalizeModelKey(actual.model) !== normalizeModelKey(recommended.model)
      ? {
          recommended,
          actual,
          warning: `Executor differs from the card harness: the card plans ${recommended.model} · ${recommended.effort}, the claim came with ${actual.model}.`,
        }
      : undefined;

  if (divergence) {
    // The swap survives the session: the card timeline records planned vs
    // actual automatically, whoever reads the board later sees what ran.
    const planned = [
      recommended?.cli ? `${recommended.cli} · ` : "",
      recommended?.model,
      ` · ${recommended?.effort}`,
    ].join("");
    const cameWith = [actual.cli ? `${actual.cli} · ` : "", actual.model].join("");
    await db.insert(taskComment).values({
      taskId: claimed.value.updated.id,
      authorAgentRef: ctx.tokenLabel,
      kind: "executor_swap",
      body: `planned ${planned}, actual ${cameWith}`,
    });
  }

  return {
    task: payload.task,
    attempt: mapExecutionAttempt(claimed.value.attempt),
    briefing_markdown: payload.briefing_markdown,
    branch_convention: payload.branch_convention,
    usage_recipe: payload.usage_recipe,
    ...(claimed.value.reclaimedStale ? { reclaimed_stale: true } : {}),
    ...(divergence ? { harness_divergence: divergence } : {}),
  };
}

/**
 * Turns an open claim back into queue work. The attempt is closed rather than
 * deleted, so any usage already reported stays attributable and auditable.
 */
async function taskRelease(
  db: McpDatabase,
  ctx: AuthContext,
  input: { task_id: string; reason: string },
) {
  return db.transaction(async (tx) => {
    const found = await findTask(tx, ctx.workspaceId, input.task_id, true);
    if (!found) {
      return err(
        "NOT_FOUND",
        `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
      );
    }
    if (found.row.status !== "em_execucao") {
      return err(
        "INVALID_TRANSITION",
        "Only a card in execution has a claim to release. Call task_get to see its current status.",
      );
    }
    if (found.row.claimedByTokenId !== ctx.tokenId && !ctx.canManage) {
      return err(
        "PERMISSION_DENIED",
        "Only the token that owns this claim, or a token with manage permission, may release it.",
      );
    }

    const [openAttempt] = await tx
      .select()
      .from(executionAttempt)
      .where(
        and(
          eq(executionAttempt.taskId, found.row.id),
          isNull(executionAttempt.finishedAt),
        ),
      )
      .orderBy(desc(executionAttempt.startedAt))
      .limit(1);
    if (!openAttempt) {
      return err(
        "INVALID_ARGUMENT",
        "The card is in execution but has no open attempt to release. Use task_get and repair the card before retrying.",
      );
    }

    const now = new Date();
    const [abandoned] = await tx
      .update(executionAttempt)
      .set({
        finishedAt: now,
        lastActivityAt: now,
        result: "abandoned",
        resultNote: input.reason,
        serverDurationMs: Math.max(
          0,
          now.getTime() - openAttempt.startedAt.getTime(),
        ),
      })
      .where(eq(executionAttempt.id, openAttempt.id))
      .returning();
    if (!abandoned) throw new Error("failed to abandon execution_attempt");

    const [updated] = await tx
      .update(task)
      .set({
        status: "aberto",
        claimedAt: null,
        claimedByExecutor: null,
        claimedByTokenId: null,
      })
      .where(eq(task.id, found.row.id))
      .returning();
    if (!updated) throw new Error("failed to release task claim");

    await tx.insert(taskComment).values({
      taskId: updated.id,
      authorAgentRef: ctx.tokenLabel,
      kind: "claim_release",
      body: input.reason,
    });

    return {
      task: mapTask(updated, found.proj),
      attempt: mapExecutionAttempt(abandoned),
    };
  });
}

/** Keeps a legitimate long-running attempt from becoming reclaimable. */
async function taskHeartbeat(
  db: McpDatabase,
  ctx: AuthContext,
  input: { task_id: string },
) {
  return db.transaction(async (tx) => {
    const found = await findTask(tx, ctx.workspaceId, input.task_id, true);
    if (!found) {
      return err(
        "NOT_FOUND",
        `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
      );
    }
    if (found.row.status !== "em_execucao") {
      return err(
        "INVALID_TRANSITION",
        "Only a card in execution has a claim to keep alive.",
      );
    }
    if (found.row.claimedByTokenId !== ctx.tokenId && !ctx.canManage) {
      return err(
        "PERMISSION_DENIED",
        "Only the token that owns this claim, or a token with manage permission, may heartbeat it.",
      );
    }

    const [ws] = await tx
      .select({ claimTimeoutMinutes: workspace.claimTimeoutMinutes })
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId))
      .limit(1);
    const [openAttempt] = await tx
      .select()
      .from(executionAttempt)
      .where(
        and(
          eq(executionAttempt.taskId, found.row.id),
          isNull(executionAttempt.finishedAt),
        ),
      )
      .orderBy(desc(executionAttempt.startedAt))
      .limit(1);
    if (!ws || !openAttempt) {
      return err(
        "INVALID_ARGUMENT",
        "The claim has no open attempt to keep alive. Call task_get before retrying.",
      );
    }

    const now = new Date();
    await tx
      .update(executionAttempt)
      .set({ lastActivityAt: now })
      .where(eq(executionAttempt.id, openAttempt.id));
    return {
      task_id: found.row.id,
      last_activity_at: iso(now),
      expires_at: iso(claimExpiresAt(now, ws.claimTimeoutMinutes)),
    };
  });
}

/**
 * Learns executors from real connections: a claim or deliver whose cli/model
 * pair is outside the active workspace config records the occurrence, and
 * Settings offers it as a one-click suggestion.
 */
async function recordSeenExecutor(
  db: McpDatabase,
  workspaceId: string,
  executor: { cli?: string; model?: string },
): Promise<void> {
  const normalized = normalizeObservedExecutor(executor);
  if (!normalized) return;
  const { cli, model } = normalized;

  const [ws] = await db
    .select()
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  if (!ws) return;
  if (isExecutorPairConfigured(ws.executors, cli, model)) return;

  const now = new Date().toISOString();
  const seen = [...ws.seenExecutors];
  const match = seen.find((s) => {
    const existing = normalizeObservedExecutor(s);
    return existing?.cli === cli && existing.model === model;
  });
  if (match) {
    match.cli = cli;
    match.model = model;
    match.lastSeenAt = now;
    match.count += 1;
  } else {
    seen.push({ cli, model, firstSeenAt: now, lastSeenAt: now, count: 1 });
  }
  await db
    .update(workspace)
    .set({ seenExecutors: seen })
    .where(eq(workspace.id, workspaceId));
}

async function taskUpdate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    task_id: string;
    comment?: string;
    comment_kind?: "comment" | "report";
    progress?: string;
    revisado?: boolean;
    mission_id?: string | null;
    project_id?: string;
    harness?: Harness;
    usage?: Usage;
    spawn_failure?: string;
    resolved_in?: string | null;
    status?: "descartado";
    superseded_by?: string;
  },
) {
  const found = await findTask(db, ctx.workspaceId, input.task_id);
  if (!found) {
    return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
  }

  let nextRow = found.row;
  if (input.status === "descartado") {
    const denied = requireManage(ctx, "task_update {status: descartado}");
    if (denied) return denied;
    const discarded = await db.transaction(async (tx) => {
      const original = await findTask(tx, ctx.workspaceId, input.task_id, true);
      if (!original) {
        return err("NOT_FOUND", `Task ${input.task_id} not found in this workspace.`);
      }
      if (original.row.status !== "em_execucao") {
        return err(
          "INVALID_ARGUMENT",
          `${original.row.shortId} cannot be discarded because it is ${original.row.status}; only a card in execution can be superseded.`,
        );
      }

      let continuation: TaskRow | null = null;
      if (input.superseded_by) {
        const foundContinuation = await findTask(
          tx,
          ctx.workspaceId,
          input.superseded_by,
          true,
        );
        if (!foundContinuation) {
          return err(
            "NOT_FOUND",
            `Continuation ${input.superseded_by} not found in this workspace.`,
          );
        }
        continuation = foundContinuation.row;
        if (continuation.id === original.row.id) {
          return err("INVALID_ARGUMENT", "A card cannot supersede itself.");
        }
        if (
          continuation.supersedesId &&
          continuation.supersedesId !== original.row.id
        ) {
          return err(
            "INVALID_ARGUMENT",
            `${continuation.shortId} already continues another card.`,
          );
        }
      }
      return discardSupersededTask(
        tx,
        original.row,
        continuation,
        continuation
          ? `superseded by ${continuation.shortId}`
          : "discarded without continuation",
      );
    });
    if (!discarded.ok) return discarded;
    nextRow = discarded.value;
  }

  // A card born loose can join a mission, and one in the wrong mission can
  // leave it. Only missions of the token's workspace qualify: an id from
  // another workspace is a NOT_FOUND, not a silent detach.
  let subtasksMoved: number | null = null;
  if (input.mission_id !== undefined) {
    let missionId: string | null = null;
    if (input.mission_id !== null) {
      const miss = await findMission(db, ctx.workspaceId, input.mission_id);
      if (!miss) {
        return err(
          "NOT_FOUND",
          `Mission ${input.mission_id} not found in this workspace. Call mission_list to see the available missions or mission_create to start one. Send mission_id: null to detach the card.`,
        );
      }
      missionId = miss.id;
    }
    const moved = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(task)
        .set({ missionId })
        .where(eq(task.id, nextRow.id))
        .returning();
      // task_create puts subtasks in the parent's mission. Moving the parent
      // keeps that true instead of leaving its children behind.
      const children = await tx
        .update(task)
        .set({ missionId })
        .where(eq(task.parentId, nextRow.id))
        .returning({ id: task.id });
      return { updated, children: children.length };
    });
    if (moved.updated) nextRow = moved.updated;
    subtasksMoved = moved.children;
  }

  // Moving between projects is what turns four projects into two without
  // deleting anything. The card is restamped with the destination prefix so
  // the board never shows a card whose id points at a project it left, and
  // the id it carried is kept on the card for the references outside.
  let proj = found.proj;
  let projectMove: ProjectMove | null = null;
  if (input.project_id !== undefined) {
    const dest = await findProject(db, ctx.workspaceId, input.project_id);
    if (!dest) {
      return err(
        "NOT_FOUND",
        `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
      );
    }
    if (nextRow.parentId) {
      return err(
        "INVALID_ARGUMENT",
        `${nextRow.shortId} is a subtask: its id is derived from its parent and it never lives in a different project than the card it belongs to. Move the parent card instead and this one travels with it.`,
      );
    }
    if (dest.id !== proj.id) {
      const from = proj;
      const moved = await db.transaction(async (tx) => {
        const shortId = await allocateShortId(tx, dest);
        const previous = nextRow.shortId;
        const changes = [{ from: previous, to: shortId }];

        const [updated] = await tx
          .update(task)
          .set({
            projectId: dest.id,
            shortId,
            previousShortIds: [...(nextRow.previousShortIds ?? []), previous],
          })
          .where(eq(task.id, nextRow.id))
          .returning();

        // Subtasks are numbered off their parent (AGB-5.1), so they follow it
        // and get restamped with it. Leaving them behind would orphan them in
        // a project their id does not belong to.
        const children = await tx
          .select()
          .from(task)
          .where(eq(task.parentId, nextRow.id))
          .orderBy(asc(task.createdAt));
        for (const child of children) {
          const suffix = child.shortId.startsWith(`${previous}.`)
            ? child.shortId.slice(previous.length)
            : `.${changes.length}`;
          const childShortId = `${shortId}${suffix}`;
          changes.push({ from: child.shortId, to: childShortId });
          await tx
            .update(task)
            .set({
              projectId: dest.id,
              shortId: childShortId,
              previousShortIds: [...(child.previousShortIds ?? []), child.shortId],
            })
            .where(eq(task.id, child.id));
        }

        return { updated, changes, children: children.length };
      });

      if (moved.updated) nextRow = moved.updated;
      proj = dest;
      subtasksMoved = moved.children;
      projectMove = {
        from_project_id: from.id,
        from_prefix: from.idPrefix,
        to_project_id: dest.id,
        to_prefix: dest.idPrefix,
        short_ids: moved.changes,
      };
    }
  }

  if (input.harness) {
    const resolved = await resolveHarnessAgainstExecutors(
      db,
      ctx.workspaceId,
      input.harness,
    );
    if (!resolved.ok) return resolved;
    const [updated] = await db
      .update(task)
      .set({ harness: harnessToDb(resolved.value) })
      .where(eq(task.id, nextRow.id))
      .returning();
    if (updated) nextRow = updated;
  }
  if (input.revisado === true) {
    const transition = applyTransition(
      {
        status: found.row.status,
        revisado: found.row.revisado,
        reopen_comment: await latestReopenComment(db, found.row),
      },
      { type: "mark_revisado" },
    );
    if (!transition.ok) return transition;
    const [updated] = await db
      .update(task)
      .set({ revisado: true })
      .where(eq(task.id, found.row.id))
      .returning();
    if (updated) nextRow = updated;
  }

  // "Which release has this" can be known only after the delivery, or be
  // wrong in it: fill, correct or clear it here. Null clears on purpose;
  // undefined leaves it alone.
  if (input.resolved_in !== undefined) {
    const [updated] = await db
      .update(task)
      .set({ resolvedIn: input.resolved_in })
      .where(eq(task.id, nextRow.id))
      .returning();
    if (updated) nextRow = updated;
  }

  // Usage can arrive (or be corrected) after deliver: real numbers found
  // later fill or overwrite the latest attempt instead of dying in a comment.
  let usageRecorded = false;
  if (input.usage) {
    const applied = await applyUsageToLatestAttempt(
      db,
      ctx.workspaceId,
      nextRow,
      input.usage,
    );
    if (!applied.ok) return applied;
    nextRow = applied.value;
    usageRecorded = true;
  }

  const commentKind = input.comment_kind ?? "comment";
  const bodies = [
    ...(input.comment ? [{ kind: commentKind, body: input.comment }] : []),
    ...(input.progress ? [{ kind: "comment", body: `progresso: ${input.progress}` }] : []),
  ];

  for (const body of bodies) {
    await db.insert(taskComment).values({
      taskId: nextRow.id,
      authorAgentRef: ctx.tokenLabel,
      kind: body.kind,
      body: body.body,
    });
  }

  if (input.spawn_failure) {
    // Boot-failure trace from an orchestrator: the planned executor never
    // started. Typed so the card detail labels it, with the planned harness
    // captured at post time.
    const planned = nextRow.harness
      ? ` (planned ${[nextRow.harness.cli, nextRow.harness.model ?? nextRow.harness.modelTier]
          .filter(Boolean)
          .join(" · ")} · ${nextRow.harness.effort})`
      : "";
    await db.insert(taskComment).values({
      taskId: nextRow.id,
      authorAgentRef: ctx.tokenLabel,
      kind: "spawn_failure",
      body: `${input.spawn_failure}${planned}`,
    });
  }

  // Progress on the token's own open claim is an implicit heartbeat. A
  // comment from a different token must not keep an abandoned worker alive.
  if (
    nextRow.status === "em_execucao" &&
    nextRow.claimedByTokenId === ctx.tokenId
  ) {
    await db
      .update(executionAttempt)
      .set({ lastActivityAt: new Date() })
      .where(
        and(
          eq(executionAttempt.taskId, nextRow.id),
          isNull(executionAttempt.finishedAt),
        ),
      );
  }

  const latestUsageGuard = await latestUsageGuardForTask(db, nextRow.id);
  return {
    task: mapTask(nextRow, proj, {
      reopenComment: await latestReopenComment(db, nextRow),
      reportsCount: await countReports(db, nextRow),
    }),
    usage_suspect: latestUsageGuard.suspect,
    usage_suspect_reason: latestUsageGuard.reason,
    ...(usageRecorded ? { usage_recorded: true } : {}),
    ...(subtasksMoved !== null ? { subtasks_moved: subtasksMoved } : {}),
    ...(projectMove ? { project_move: projectMove } : {}),
  };
}

/**
 * Applies a usage block to the task's most recent attempt, merging over what
 * is already there, syncing the latest handoff and recomputing the card's
 * telemetry-incomplete flag.
 */
async function applyUsageToLatestAttempt(
  db: McpDatabase,
  workspaceId: string,
  row: TaskRow,
  usage: Usage,
): Promise<Result<TaskRow>> {
  const [attempt] = await db
    .select()
    .from(executionAttempt)
    .where(eq(executionAttempt.taskId, row.id))
    .orderBy(desc(executionAttempt.startedAt))
    .limit(1);
  if (!attempt) {
    return err(
      "INVALID_ARGUMENT",
      "No execution attempt to receive usage. Call task_claim before reporting usage.",
    );
  }

  // A segment list is a whole picture of who spent what, so a new one replaces
  // the stored one instead of merging counter by counter.
  const incomingFlatTokens =
    usage.tokens_in !== undefined ||
    usage.tokens_out !== undefined ||
    usage.tokens_cache !== undefined;
  const merged: UsageReport = resolveUsageSegments(
    {
      // An incoming flat correction is a new token picture too. Reusing the
      // old segments here would immediately overwrite its flat counters with
      // the stale segment totals during normalization.
      segments:
        usage.segments ??
        (incomingFlatTokens ? undefined : attempt.usageSegments ?? undefined),
      tokens_in: usage.tokens_in ?? attempt.tokensIn ?? undefined,
      tokens_out: usage.tokens_out ?? attempt.tokensOut ?? undefined,
      tokens_cache: usage.tokens_cache ?? attempt.tokensCache ?? undefined,
      cost_usd:
        usage.cost_usd ??
        (attempt.reportedCostUsd != null
          ? Number(attempt.reportedCostUsd)
          : attempt.costSource == null && attempt.costUsd != null
            ? Number(attempt.costUsd)
            : undefined),
      duration_ms: usage.duration_ms ?? attempt.durationMs ?? undefined,
      turns: usage.turns ?? attempt.turns ?? undefined,
      estimated: usage.estimated ?? false,
    },
    attempt.model,
  );

  const executor = decodeExecutor(
    attempt.executor,
    attempt.model,
    attempt.modelSource,
  );
  const sessionId =
    attempt.sessionId ??
    readTranscriptRef(attempt.transcript, {
      cli: executor.cli,
      sessionId: executor.session_id,
    })?.sessionId ??
    null;
  const measuredWindowMs =
    attempt.serverDurationMs ??
    Math.max(
      0,
      (attempt.finishedAt ?? new Date()).getTime() - attempt.startedAt.getTime(),
    );
  const guard = await usageGuardForAttempt(
    db,
    workspaceId,
    attempt.id,
    attempt.taskId,
    sessionId,
    merged,
    measuredWindowMs,
  );
  const prices = await loadModelPrices(db as PricesDb, workspaceId);
  const assessment = assessAttemptCost(merged.segments ?? [], prices, {
    reportedCostUsd: merged.cost_usd,
    usageEstimated: merged.estimated,
    usageSuspect: guard.suspect,
    tokensReported: tokenCountersReported(merged),
  });
  const storedUsage: UsageReport = {
    ...merged,
    segments: assessment.normalizedSegments,
  };
  const measured = measuredModelIdentity(storedUsage.segments);
  const claimedModel = attempt.model ? normalizeModelKey(attempt.model) : null;
  const modelChanged = Boolean(measured && measured.model !== claimedModel);

  await db
    .update(executionAttempt)
    .set({
      ...(modelChanged
        ? { model: measured?.model, modelSource: "measured" as const }
        : {}),
      usageSegments: storedUsage.segments?.length ? storedUsage.segments : null,
      tokensIn: storedUsage.tokens_in,
      tokensOut: storedUsage.tokens_out,
      tokensCache: storedUsage.tokens_cache,
      reportedCostUsd:
        storedUsage.cost_usd !== undefined ? String(storedUsage.cost_usd) : null,
      costUsd: assessment.costUsd != null ? String(assessment.costUsd) : null,
      costSource: assessment.source,
      costStatus: assessment.status,
      costUnpricedModels: assessment.unpricedModels,
      costBreakdown: assessment.breakdown,
      durationMs: storedUsage.duration_ms,
      turns: storedUsage.turns,
      usageEstimated: storedUsage.estimated ?? false,
      sessionId,
      usageSuspect: guard.suspect,
      usageSuspectReason: guard.reason,
    })
    .where(eq(executionAttempt.id, attempt.id));

  if (modelChanged && measured) {
    await db.insert(taskComment).values({
      taskId: row.id,
      authorAgentRef: "usage",
      kind: "executor_swap",
      body: `declarou ${claimedModel ?? "unknown"}, mediu ${measured.chain}`,
    });
  }

  const [latestHandoff] = await db
    .select()
    .from(handoff)
    .where(eq(handoff.taskId, row.id))
    .orderBy(desc(handoff.createdAt))
    .limit(1);
  if (latestHandoff) {
    await db
      .update(handoff)
      .set({ usage: storedUsage })
      .where(eq(handoff.id, latestHandoff.id));
  }

  const [updated] = await db
    .update(task)
    .set({ telemetryIncomplete: isTelemetryIncomplete(storedUsage) })
    .where(eq(task.id, row.id))
    .returning();
  return ok(updated ?? row);
}

/**
 * Resolves a caller-provided harness against the workspace's enabled
 * executors: the model must exist on one of them, and when a CLI is named it
 * must be that CLI. Returns the harness with the CLI filled from the match.
 */
async function resolveHarnessAgainstExecutors(
  db: McpDatabase,
  workspaceId: string,
  input: Harness,
): Promise<Result<{ cli: string | null; model: string; effort: Harness["effort"] }>> {
  const [ws] = await db
    .select()
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  if (!ws) {
    return err(
      "NOT_FOUND",
      "The workspace for this token no longer exists. Generate a new token in the board Settings.",
    );
  }
  return resolveHarnessAgainstConfig(executorsFromWorkspace(ws.executors), input);
}

/**
 * The same check without the round trip, for callers walking a chain: reading
 * the workspace once and testing every link against it beats one SELECT per
 * link, and the link count is the point of the feature.
 */
function resolveHarnessAgainstConfig(
  executors: ReturnType<typeof executorsFromWorkspace>,
  input: Harness,
): Result<{ cli: string | null; model: string; effort: Harness["effort"] }> {
  const needleModel = input.model.trim().toLowerCase();
  const needleCli = input.cli?.trim().toLowerCase();

  const candidates = needleCli
    ? executors.filter(
        (item) =>
          item.id.trim().toLowerCase() === needleCli ||
          item.cli.trim().toLowerCase() === needleCli,
      )
    : executors;
  if (needleCli && candidates.length === 0) {
    return err(
      "INVALID_ARGUMENT",
      `CLI '${input.cli}' is not among the configured executors. Call harness_list to see them.`,
    );
  }
  const matched = candidates.find((item) =>
    item.models.some((model) => model.trim().toLowerCase() === needleModel),
  );
  if (!matched) {
    return err(
      "INVALID_ARGUMENT",
      needleCli
        ? `Model '${input.model}' is not configured on executor '${input.cli}'. Call harness_list to see the available models.`
        : `Model '${input.model}' is not among the configured executors. Call harness_list to see the available models.`,
    );
  }
  return ok({
    cli: input.cli ?? matched.cli,
    model: input.model,
    effort: input.effort,
  });
}

async function taskDeliver(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    task_id: string;
    summary: string;
    how_to_verify?: string;
    evidence: Array<{ text?: string; url?: string }>;
    artifacts: unknown[];
    branch?: string;
    pull_request_url?: string;
    resolved_in?: string;
    usage?: Usage;
    transcript?: TranscriptRefWire;
  },
) {
  const persisted = await db.transaction(async (tx) => {
    const found = await findTask(tx, ctx.workspaceId, input.task_id, true);
    if (!found) {
      return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
    }

    const transition = applyTransition(
      {
        status: found.row.status,
        revisado: found.row.revisado,
        reopen_comment: await latestReopenComment(tx, found.row),
      },
      { type: "handoff" },
    );
    if (!transition.ok) return transition;

    const [openAttempt] = await tx
      .select()
      .from(executionAttempt)
      .where(
        and(
          eq(executionAttempt.taskId, found.row.id),
          isNull(executionAttempt.finishedAt),
        ),
      )
      .orderBy(desc(executionAttempt.startedAt))
      .limit(1);

    // Usage as the board stores it: segments per model, with the flat
    // counters derived from them. A flat-only block still arrives here as one
    // segment for the model the attempt was claimed with.
    const usage: UsageReport | undefined = input.usage
      ? resolveUsageSegments(input.usage, openAttempt?.model ?? null)
      : undefined;
    const incomplete = isTelemetryIncomplete(usage);

    // The delivery usually knows the path the claim could not: the recipe
    // only prints it once the run is done. Fields it omits keep the claimed
    // value, and an attempt claimed before this column existed falls back to
    // the session id already inside its executor blob.
    const claimExecutor = openAttempt
      ? decodeExecutor(
          openAttempt.executor,
          openAttempt.model,
          openAttempt.modelSource,
        )
      : {};
    const transcript = mergeTranscriptRef(
      readTranscriptRef(openAttempt?.transcript, {
        cli: claimExecutor.cli,
        sessionId: claimExecutor.session_id,
      }),
      input.transcript
        ? {
            cli: input.transcript.cli,
            sessionId: input.transcript.session_id,
            path: input.transcript.path,
            resume: input.transcript.resume,
          }
        : null,
    );

    const finishedAt = new Date();
    const serverDurationMs = openAttempt
      ? Math.max(0, finishedAt.getTime() - openAttempt.startedAt.getTime())
      : 0;
    const sessionId =
      transcript?.sessionId ?? openAttempt?.sessionId ?? claimExecutor.session_id ?? null;
    const usageGuard =
      openAttempt && usage
        ? await usageGuardForAttempt(
            tx,
            ctx.workspaceId,
            openAttempt.id,
            openAttempt.taskId,
            sessionId,
            usage,
            serverDurationMs,
          )
        : { suspect: false, reason: null };
    const prices = await loadModelPrices(tx as PricesDb, ctx.workspaceId);
    const assessment = assessAttemptCost(usage?.segments ?? [], prices, {
      reportedCostUsd: usage?.cost_usd,
      usageEstimated: usage?.estimated,
      usageSuspect: usageGuard.suspect,
      tokensReported: tokenCountersReported(usage),
    });
    const storedUsage: UsageReport | undefined = usage
      ? { ...usage, segments: assessment.normalizedSegments }
      : undefined;
    const measured = measuredModelIdentity(storedUsage?.segments);
    const claimedModel = openAttempt?.model
      ? normalizeModelKey(openAttempt.model)
      : null;
    const modelChanged = Boolean(measured && measured.model !== claimedModel);

    if (openAttempt) {
      await tx
        .update(executionAttempt)
        .set({
          ...(modelChanged
            ? { model: measured?.model, modelSource: "measured" as const }
            : {}),
          finishedAt,
          lastActivityAt: finishedAt,
          result: "success",
          usageSegments: storedUsage?.segments?.length ? storedUsage.segments : null,
          tokensIn: storedUsage?.tokens_in,
          tokensOut: storedUsage?.tokens_out,
          tokensCache: storedUsage?.tokens_cache,
          reportedCostUsd:
            storedUsage?.cost_usd !== undefined
              ? String(storedUsage.cost_usd)
              : null,
          costUsd: assessment.costUsd != null ? String(assessment.costUsd) : null,
          costSource: assessment.source,
          costStatus: assessment.status,
          costUnpricedModels: assessment.unpricedModels,
          costBreakdown: assessment.breakdown,
          durationMs: storedUsage?.duration_ms,
          // Telemetry that does not depend on agent goodwill: the server
          // measures claim → deliver itself, whatever the agent reports.
          serverDurationMs,
          turns: storedUsage?.turns,
          usageEstimated: storedUsage?.estimated ?? false,
          sessionId,
          usageSuspect: usageGuard.suspect,
          usageSuspectReason: usageGuard.reason,
          transcript,
        })
        .where(eq(executionAttempt.id, openAttempt.id));
      if (modelChanged && measured) {
        await tx.insert(taskComment).values({
          taskId: found.row.id,
          authorAgentRef: ctx.tokenLabel,
          kind: "executor_swap",
          body: `declarou ${claimedModel ?? "unknown"}, mediu ${measured.chain}`,
        });
      }
    }

    const [saved] = await tx
      .insert(handoff)
      .values({
        taskId: found.row.id,
        attemptId: openAttempt?.id ?? null,
        summary: input.summary,
        howToVerify: input.how_to_verify ?? null,
        evidences: input.evidence as never,
        artifacts: input.artifacts as never,
        branch: input.branch ?? found.row.branch,
        prUrl: input.pull_request_url ?? found.row.prUrl,
        usage: storedUsage ?? null,
      })
      .returning();
    if (!saved) throw new Error("failed to insert handoff");

    const [updated] = await tx
      .update(task)
      .set({
        status: transition.value.status,
        revisado: transition.value.revisado,
        branch: input.branch ?? found.row.branch,
        prUrl: input.pull_request_url ?? found.row.prUrl,
        resolvedIn: input.resolved_in ?? found.row.resolvedIn,
        telemetryIncomplete: incomplete,
        // A fresh delivery restarts lay validation from zero.
        validationTicks: [],
      })
      .where(eq(task.id, found.row.id))
      .returning();
    if (!updated) throw new Error("failed to update task on handoff");

    return ok({
      updated,
      proj: found.proj,
      saved,
      incomplete,
      usage: storedUsage,
      routedTo: reviewerFromRow(updated),
      attemptExecutor: openAttempt
        ? {
            ...claimExecutor,
            ...(measured ? { model: measured.model } : {}),
            ...(modelChanged ? { model_source: "measured" as const } : {}),
          }
        : null,
      transcript,
      usageGuard,
    });
  });

  if (!persisted.ok) return persisted;

  if (persisted.value.attemptExecutor) {
    await recordSeenExecutor(db, ctx.workspaceId, persisted.value.attemptExecutor);
  }

  return {
    task: mapTask(persisted.value.updated, persisted.value.proj),
    handoff: {
      id: persisted.value.saved.id,
      task_id: persisted.value.saved.taskId,
      attempt_id: persisted.value.saved.attemptId ?? undefined,
      summary: persisted.value.saved.summary,
      how_to_verify: persisted.value.saved.howToVerify,
      evidence: input.evidence,
      artifacts: input.artifacts,
      branch: persisted.value.saved.branch,
      pull_request_url:
        persisted.value.saved.prUrl && /^https?:\/\//.test(persisted.value.saved.prUrl)
          ? persisted.value.saved.prUrl
          : null,
      // What the board stored, segments included, not what arrived: a flat
      // block comes back as the single segment it became.
      usage: persisted.value.usage ?? null,
      telemetry_incomplete: persisted.value.incomplete,
      created_at: iso(persisted.value.saved.createdAt),
    },
    telemetry_incomplete: persisted.value.incomplete,
    usage_suspect: persisted.value.usageGuard.suspect,
    usage_suspect_reason: persisted.value.usageGuard.reason,
    transcript: transcriptToWire(persisted.value.transcript),
    ...(input.usage
      ? {}
      : {
          usage_warning:
            "card will show usage not reported — send usage via task_update at any time",
        }),
    routed_to: persisted.value.routedTo,
  };
}

async function taskDelete(
  db: McpDatabase,
  ctx: AuthContext,
  input: { task_id: string },
) {
  return db.transaction(async (tx) => {
    const found = await findTask(tx, ctx.workspaceId, input.task_id, true);
    if (!found) {
      return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
    }

    const children = await tx
      .select({ id: task.id })
      .from(task)
      .where(eq(task.parentId, found.row.id));
    const ids = [found.row.id, ...children.map((child) => child.id)];

    const [attempts] = await tx
      .select({ n: count() })
      .from(executionAttempt)
      .where(inArray(executionAttempt.taskId, ids));
    const [handoffs] = await tx
      .select({ n: count() })
      .from(handoff)
      .where(inArray(handoff.taskId, ids));

    // Hard delete by owner decision: attempts, handoffs, comments and subtasks
    // go with the card via FK cascade. No archive, no undo.
    await tx.delete(task).where(eq(task.id, found.row.id));

    return {
      deleted: true as const,
      task_id: found.row.id,
      short_id: found.row.shortId,
      attempts_deleted: Number(attempts?.n ?? 0),
      handoffs_deleted: Number(handoffs?.n ?? 0),
    };
  });
}

async function branchRegister(
  db: McpDatabase,
  ctx: AuthContext,
  input: { task_id: string; branch: string },
) {
  const found = await findTask(db, ctx.workspaceId, input.task_id);
  if (!found) {
    return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
  }
  const [updated] = await db
    .update(task)
    .set({ branch: input.branch })
    .where(eq(task.id, found.row.id))
    .returning();
  return {
    task: mapTask(updated ?? found.row, found.proj, {
      reopenComment: await latestReopenComment(db, found.row),
    }),
  };
}

async function harnessRecommend(
  db: McpDatabase,
  ctx: AuthContext,
  input: { type: CardapioTaskType },
) {
  const rec = await recommendFor(db, ctx.workspaceId, input.type);
  if (!rec.ok) return rec;
  return rec.value;
}

async function harnessList(db: McpDatabase, ctx: AuthContext) {
  const [ws] = await db
    .select()
    .from(workspace)
    .where(eq(workspace.id, ctx.workspaceId))
    .limit(1);
  if (!ws) {
    return err(
      "NOT_FOUND",
      "The workspace for this token no longer exists. Generate a new token in the board Settings.",
    );
  }
  const policy = await loadPolicy(db, ctx.workspaceId);
  // The price table travels with the policy: an orchestrator picking a
  // harness can weigh what each model costs before it spends anything.
  const prices = await loadModelPrices(db as PricesDb, ctx.workspaceId);
  return {
    policy: policy.length > 0 ? policy : factoryCardapioPolicy(),
    executors: ws.executors,
    prices: prices.map((price) => ({
      model: price.model,
      label: price.label,
      input_per_mtok: price.inputPerMtok,
      output_per_mtok: price.outputPerMtok,
      cache_per_mtok: price.cachePerMtok,
      source: price.source,
      seeded_at: price.seededAt,
      updated_by: price.updatedBy,
      updated_at: price.updatedAt,
    })),
  };
}

/**
 * Writes one line of the harness policy. Gated on the token's manage flag:
 * the point of the flag is that a worker token cannot promote itself to a
 * better model between two claims.
 */
/** The declared line, best first, without repeats and without blanks. */
function declaredChain(
  model: string | undefined,
  chain: readonly string[] | undefined,
): string[] {
  const out: string[] = [];
  for (const name of [model, ...(chain ?? [])]) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    if (out.some((seen) => seen.toLowerCase() === trimmed.toLowerCase())) continue;
    out.push(trimmed);
  }
  return out;
}

async function harnessSet(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    type: CardapioTaskType;
    cli?: string | null;
    model?: string;
    chain?: string[];
    effort: EffortLevel;
  },
) {
  const denied = requireManage(ctx, "harness_set");
  if (denied) return denied;

  const chain = declaredChain(input.model, input.chain);
  const head = chain[0];
  if (!head) {
    return err("INVALID_ARGUMENT", "Send a model, a chain, or both.");
  }

  const [ws] = await db
    .select()
    .from(workspace)
    .where(eq(workspace.id, ctx.workspaceId))
    .limit(1);
  if (!ws) {
    return err(
      "NOT_FOUND",
      "The workspace for this token no longer exists. Generate a new token in the board Settings.",
    );
  }
  const executors = executorsFromWorkspace(ws.executors);

  // A line of succession only earns its keep if at least one link can run. The
  // head is allowed to name an executor this workspace has switched off, since
  // surviving exactly that is why a successor was declared: the write is
  // refused only when no link at all resolves, which is what a bare model has
  // always done.
  let firstAvailable: Result<unknown> | null = null;
  let headResolution: Result<unknown> | null = null;
  for (const [position, model] of chain.entries()) {
    const resolved = resolveHarnessAgainstConfig(executors, {
      ...(position === 0 && input.cli ? { cli: input.cli } : {}),
      model,
      effort: input.effort,
    });
    if (position === 0) headResolution = resolved;
    if (resolved.ok) {
      firstAvailable = resolved;
      break;
    }
  }
  // Reuse the head's own message so a chain of one fails exactly as before.
  if (!firstAvailable) return headResolution as Result<never>;

  // A null cli stays null: "no preference" is a real policy choice, and the
  // executor match above already proved a link is available somewhere.
  const cli = input.cli?.trim() || null;
  // One model is not a chain. Storing null keeps the column meaningful and the
  // row identical to what every pre-chain writer produced.
  const stored = chain.length > 1 ? chain : null;
  const updatedAt = new Date();

  const [row] = await db
    .insert(cardapioEntry)
    .values({
      workspaceId: ctx.workspaceId,
      activityType: input.type,
      cli,
      model: head,
      chain: stored,
      effort: input.effort,
      updatedBy: ctx.tokenLabel,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [cardapioEntry.workspaceId, cardapioEntry.activityType],
      set: {
        cli,
        model: head,
        chain: stored,
        effort: input.effort,
        updatedBy: ctx.tokenLabel,
        updatedAt,
      },
    })
    .returning();
  if (!row) throw new Error("failed to write cardapio entry");

  return { policy: policyEntryFromRow(row) };
}

/**
 * The aggregate questions the Insights page answers, over MCP. Deliberately
 * the same two loaders and the same pure aggregation the page calls, so an
 * agent and a human reading the screen can never disagree about a number.
 */
async function insightsQuery(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    group_by?: "project" | "mission" | "model" | "card";
    since?: string;
    until?: string;
  },
) {
  const since = input.since ? new Date(input.since) : undefined;
  const until = input.until ? new Date(input.until) : undefined;
  if (since && until && since.getTime() > until.getTime()) {
    return err(
      "INVALID_ARGUMENT",
      "The period is inverted: since is later than until.",
    );
  }

  const [ws] = await db
    .select({ pricingEnabled: workspace.pricingEnabled })
    .from(workspace)
    .where(eq(workspace.id, ctx.workspaceId))
    .limit(1);
  // Money is opt-in. With it off there is no price table to read and every
  // cost field comes back null, never a zero pretending to be an answer.
  const pricingEnabled = ws?.pricingEnabled ?? false;

  const [attemptRows, reopenRows, prices] = await Promise.all([
    loadInsightAttemptRows(db as InsightsDb, ctx.workspaceId),
    loadReopenRows(db as InsightsDb, ctx.workspaceId),
    pricingEnabled
      ? loadModelPrices(db as PricesDb, ctx.workspaceId)
      : Promise.resolve([]),
  ]);
  const insights = computeInsights(
    filterAttemptsByPeriod(attemptRows, { since, until }),
    reopenRows,
    prices,
  );

  const totalsFor = (row: (typeof insights)["totals"]) => ({
    cost_usd: pricingEnabled ? row.costUsd : null,
    cost_computed: pricingEnabled ? row.costComputed : 0,
    cost_reported: pricingEnabled ? row.costReported : 0,
    cost_estimated: pricingEnabled ? row.costEstimated : 0,
    cost_unpriced: pricingEnabled ? row.costUnpriced : 0,
    tokens: row.tokens,
    // Two clocks, never one: what the agents worked, and how long the cards
    // that reported nothing simply stayed claimed.
    duration_ms: row.durationMs,
    elapsed_ms: row.elapsedMs,
    elapsed_only: row.elapsedOnly,
    attempts: row.attempts,
    estimated: row.estimated,
    missing: row.missing,
    zero_usage: row.zeroUsage,
    suspect: row.suspect,
    suspect_tokens: row.suspectTokens,
    suspect_duration_ms: row.suspectDurationMs,
    suspect_cost_usd: pricingEnabled ? row.suspectCostUsd : null,
  });
  const totals = totalsFor(insights.totals);

  const groupsFor = (rows: typeof insights.byProject) =>
    rows.map((row) => ({
      key: row.key,
      label: row.label,
      ...totalsFor(row),
      ...(row.sharedAttempts ? { shared_attempts: row.sharedAttempts } : {}),
    }));

  let grouped: Record<string, unknown> = {};
  if (input.group_by === "project") grouped = { groups: groupsFor(insights.byProject) };
  if (input.group_by === "mission") grouped = { groups: groupsFor(insights.byMission) };
  if (input.group_by === "model") grouped = { groups: groupsFor(insights.byModel) };
  if (input.group_by === "card") {
    grouped = {
      cards: insights.perCard.map((card) => ({
        task_id: card.taskId,
        short_id: card.shortId,
        title: card.title,
        project: card.projectName,
        mission: card.missionTitle,
        models: card.models,
        model_origins: card.modelOrigins,
        // Kept nullable on purpose: an unknown cost is not a cost of zero,
        // and with the money layer off there is no cost to know.
        cost_usd: pricingEnabled ? card.costUsd : null,
        cost_source: pricingEnabled ? card.costSource : null,
        unpriced_tokens: pricingEnabled ? card.unpricedTokens : 0,
        unpriced_models: pricingEnabled ? card.unpricedModels : [],
        tokens: card.tokens,
        duration_ms: card.durationMs,
        elapsed_ms: card.elapsedMs,
        attempts: card.attempts,
        estimated: card.estimated,
        missing: card.missing,
        zero_usage: card.zeroUsage,
        suspect: card.suspect,
        suspect_tokens: card.suspectTokens,
        suspect_duration_ms: card.suspectDurationMs,
        suspect_cost_usd: pricingEnabled ? card.suspectCostUsd : null,
      })),
    };
  }

  return {
    period: {
      since: since ? iso(since) : null,
      until: until ? iso(until) : null,
    },
    totals,
    discarded: {
      totals: totalsFor(insights.discarded.totals),
      by_executor: groupsFor(insights.discarded.byExecutor),
      by_mission: groupsFor(insights.discarded.byMission),
      by_model: groupsFor(insights.discarded.byModel),
    },
    pricing_enabled: pricingEnabled,
    note: usageHonestyNote(insights.totals),
    cost_note: pricingEnabled
      ? costSourceNote(insights.totals)
      : "cost is off on this board: tokens and time only",
    ...grouped,
    reopened_by_model: insights.reopensByModel.map((row) => ({
      model: row.model,
      deliveries: row.deliveries,
      reopened: row.reopened,
      rate: row.rate,
    })),
  };
}

/**
 * Adds or removes CLIs and models in the workspace executor config, writing
 * the same shape the Settings grid saves so both screens read one source.
 * Behind the manage flag: executors decide what a card is allowed to run on.
 */
async function executorsUpdate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    cli: string;
    label?: string;
    enabled?: boolean;
    add_models?: string[];
    remove_models?: string[];
    remove?: boolean;
  },
) {
  const denied = requireManage(ctx, "executors_update");
  if (denied) return denied;

  const [ws] = await db
    .select()
    .from(workspace)
    .where(eq(workspace.id, ctx.workspaceId))
    .limit(1);
  if (!ws) {
    return err(
      "NOT_FOUND",
      "The workspace for this token no longer exists. Generate a new token in the board Settings.",
    );
  }

  const applied = applyExecutorUpdate(ws.executors, input);
  if (applied.removed && applied.config.length === ws.executors.length) {
    return err(
      "NOT_FOUND",
      `Executor '${input.cli}' is not in this workspace config. Call harness_list to see the configured executors.`,
    );
  }

  // A removal can orphan a policy line, exactly as it can from Settings. The
  // write stands; the agent gets told what harness_set has to fix. Only what
  // THIS call broke is reported: a board whose policy was already pointing at
  // models it does not have would otherwise warn on every unrelated edit.
  const policy = await loadPolicy(db, ctx.workspaceId);
  const before = new Set(orphanedPolicyTypes(policy, ws.executors));
  const warnings = orphanedPolicyTypes(policy, applied.config)
    .filter((type) => !before.has(type))
    .map((type) => {
      const line = policy.find((row) => row.type === type);
      return `policy line '${type}' points at ${[line?.cli, line?.model]
        .filter(Boolean)
        .join(" · ")}, which is no longer configured. Fix it with harness_set.`;
    });

  await db
    .update(workspace)
    .set({ executors: applied.config as ExecutorConfig[] })
    .where(eq(workspace.id, ctx.workspaceId));

  return {
    executors: applied.config,
    updated: applied.targetId,
    removed: applied.removed,
    ...(warnings.length > 0 ? { policy_warnings: warnings } : {}),
  };
}

/** Activity types whose policy model no longer exists on an enabled executor. */
function orphanedPolicyTypes(
  policy: CardapioPolicyEntry[],
  config: readonly { id: string; enabled: boolean; models: string[] }[],
): string[] {
  const orphaned: string[] = [];
  for (const line of policy) {
    const chain = declaredChain(line.model ?? undefined, line.chain ?? undefined);
    if (chain.length === 0) continue;
    // A line is only orphaned when every link is gone. With a cli the pair has
    // to exist on it, and only for the head: past the first choice the point of
    // the fallback is to leave that CLI behind. Same rule recommendHarness uses.
    const available = chain.some((model, position) =>
      line.cli && position === 0
        ? isPairInConfig(config, line.cli, model)
        : config.some(
            (row) =>
              row.enabled &&
              row.models.some((m) => m.trim().toLowerCase() === model.toLowerCase()),
          ),
    );
    if (!available) orphaned.push(line.type);
  }
  return orphaned;
}

function requireManage(
  ctx: AuthContext,
  tool: string,
): Result<never> | null {
  if (ctx.canManage) return null;
  return err(
    "PERMISSION_DENIED",
    `This token cannot change the workspace configuration, so ${tool} is refused. Ask the owner to tick "can manage the workspace" for it in Settings › MCP tokens, or use a token that already has it.`,
  );
}

function policyEntryFromRow(
  row: typeof cardapioEntry.$inferSelect,
): CardapioPolicyEntry & { updated_by: string | null; updated_at: string } {
  return {
    type: row.activityType,
    cli: row.cli,
    model: row.model,
    ...(row.chain && row.chain.length > 0 ? { chain: row.chain } : {}),
    effort: row.effort as EffortLevel,
    updated_by: row.updatedBy,
    updated_at: iso(row.updatedAt),
  };
}

async function loadPolicy(
  db: McpDatabase,
  workspaceId: string,
): Promise<CardapioPolicyEntry[]> {
  const rows = await db
    .select()
    .from(cardapioEntry)
    .where(eq(cardapioEntry.workspaceId, workspaceId));
  return rows.map((row) => policyEntryFromRow(row));
}

async function recommendFor(
  db: McpDatabase,
  workspaceId: string,
  type: CardapioTaskType,
  explicit?: Harness,
  /** Which try this is, zero-based. Moves the chain walk down the line. */
  attempt = 0,
) {
  const [ws] = await db
    .select()
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  if (!ws) {
    return err(
      "NOT_FOUND",
      "The workspace for this token no longer exists. Generate a new token in the board Settings.",
    );
  }
  const policy = await loadPolicy(db, workspaceId);
  return recommendHarness({
    type,
    executors: executorsFromWorkspace(ws.executors),
    policy,
    ...(attempt > 0 ? { attempt } : {}),
    ...(explicit
      ? {
          explicit: {
            model: explicit.model,
            effort: explicit.effort,
            ...(explicit.cli ? { cli: explicit.cli } : {}),
          },
        }
      : {}),
  });
}

/**
 * A card coming back for another try moves down its chain instead of returning
 * to the model whose delivery was just rejected.
 *
 * Only deliveries count. An attempt abandoned with `force` was a pane someone
 * killed, not a verdict on the model, and paying more for it would be a tax on
 * restarting. A harness pinned off the chain by hand is left alone: escalating
 * somebody's explicit choice is not the board's call.
 */
async function escalatedHarnessForRetry(
  db: McpDatabase,
  workspaceId: string,
  row: TaskRow,
): Promise<ReturnType<typeof harnessToDb>> {
  const delivered = await db
    .select({ id: executionAttempt.id })
    .from(executionAttempt)
    .where(
      and(eq(executionAttempt.taskId, row.id), eq(executionAttempt.result, "success")),
    );
  if (delivered.length === 0) return null;

  const policy = await loadPolicy(db, workspaceId);
  const type = row.tipo as CardapioTaskType;
  const chain = policyChain(lookupCardapioPolicy(policy, type));
  const current = row.harness?.model?.trim().toLowerCase();
  const onChain =
    !current || chain.some((model) => model.trim().toLowerCase() === current);
  if (!onChain) return null;

  const next = await recommendFor(db, workspaceId, type, undefined, delivered.length);
  if (!next.ok || !next.value.available) return null;
  if (next.value.harness.model?.trim().toLowerCase() === current) return null;
  return harnessToDb(next.value.harness);
}

async function assembleTaskPayload(
  db: McpDatabase,
  row: TaskRow,
  proj: ProjectRow,
  reopenComment?: string | null,
  /** CLI running the card, when the caller knows it (the claim executor). */
  cli?: string | null,
  /** Number of report comments on this card; set only on explicit count calls. */
  reportsCount?: number,
  /** Exact executor identity available while assembling a task_claim response. */
  executor?: {
    sessionId?: string | null;
    model?: string | null;
    claimedAt?: Date | string | null;
    reclaimedStale?: boolean;
  },
) {
  const comment =
    reopenComment !== undefined
      ? reopenComment
      : await latestReopenComment(db, row);
  const count = reportsCount ?? 0;
  const mapped = mapTask(row, proj, {
    reopenComment: comment,
    reportsCount: count,
  });
  let missionPayload = null;
  if (row.missionId) {
    const miss = await findMission(db, proj.workspaceId, row.missionId);
    if (miss) missionPayload = mapMission(miss);
  }
  const convention = branchConvention(mapped.short_id, mapped.title);
  const [latestAttempt] = await db
    .select({
      startedAt: executionAttempt.startedAt,
      sessionId: executionAttempt.sessionId,
      model: executionAttempt.model,
      usageSuspect: executionAttempt.usageSuspect,
      usageSuspectReason: executionAttempt.usageSuspectReason,
      costUsd: executionAttempt.costUsd,
      costSource: executionAttempt.costSource,
      costStatus: executionAttempt.costStatus,
      costUnpricedModels: executionAttempt.costUnpricedModels,
    })
    .from(executionAttempt)
    .where(eq(executionAttempt.taskId, row.id))
    .orderBy(desc(executionAttempt.startedAt))
    .limit(1);
  // Whoever is running the card gets the recipe for their own CLI. On a
  // task_get without an executor, the card's claimed executor or its planned
  // harness names the CLI; anything else lands on the generic recipe.
  const recipes = await loadUsageRecipes(db as RecipesDb, proj.workspaceId);
  const recipe = bindUsageRecipe(
    recipeForCli(recipes, cli ?? row.claimedByExecutor ?? row.harness?.cli ?? null),
    {
      sessionId: executor?.sessionId ?? latestAttempt?.sessionId,
      model: executor?.model ?? latestAttempt?.model ?? mapped.harness?.model,
      claimedAt: executor?.claimedAt ?? latestAttempt?.startedAt,
    },
  );
  // The line of succession behind the one model the card prints, so a worker
  // that stalls knows where the work goes next without asking the board.
  const policy = await loadPolicy(db, proj.workspaceId);
  const chain = policyChain(lookupCardapioPolicy(policy, row.tipo));
  const delivered = await db
    .select({ id: executionAttempt.id })
    .from(executionAttempt)
    .where(
      and(eq(executionAttempt.taskId, row.id), eq(executionAttempt.result, "success")),
    );
  return {
    task: mapped,
    briefing_markdown: renderBriefingMarkdown({
      task: mapped,
      mission: missionPayload,
      project: {
        name: proj.name,
        idPrefix: proj.idPrefix,
        context: proj.context,
        currentVersion: proj.currentVersion,
      },
      branchConvention: convention,
      recipe,
      chain,
      attempt: delivered.length,
      claimedAt: latestAttempt?.startedAt
        ? iso(latestAttempt.startedAt)
        : null,
      reclaimedStale: executor?.reclaimedStale,
    }),
    mission: missionPayload,
    branch_convention: convention,
    usage_recipe: recipe
      ? {
          cli: recipe.cli,
          label: recipe.label,
          yields: recipe.yields,
          instructions: recipe.instructions,
          command: recipe.command,
        }
      : null,
    usage_suspect: latestAttempt?.usageSuspect ?? false,
    usage_suspect_reason: latestAttempt?.usageSuspectReason ?? null,
    cost_usd:
      latestAttempt?.costUsd != null ? Number(latestAttempt.costUsd) : null,
    cost_source: latestAttempt?.costSource ?? null,
    cost_status: latestAttempt?.costStatus ?? null,
    cost_unpriced_models: latestAttempt?.costUnpricedModels ?? [],
    ...(row.status === "descartado" && row.telemetryIncomplete
      ? {
          usage_warning:
            "custo do attempt abandonado não reportado — envie task_update {usage} no card descartado",
        }
      : {}),
  };
}

type UsageGuard = { suspect: boolean; reason: string | null };

/** Latest stored verdict for task_get and task_update responses. */
async function latestUsageGuardForTask(
  db: McpDatabase,
  taskId: string,
): Promise<UsageGuard> {
  const [latest] = await db
    .select({
      suspect: executionAttempt.usageSuspect,
      reason: executionAttempt.usageSuspectReason,
    })
    .from(executionAttempt)
    .where(eq(executionAttempt.taskId, taskId))
    .orderBy(desc(executionAttempt.startedAt))
    .limit(1);
  return latest ?? { suspect: false, reason: null };
}

/**
 * The server-side guard is advisory, never a delivery veto. It compares the
 * report with the server's claim window and checks whether this exact executor
 * session had already completed a different card in the same workspace.
 */
async function usageGuardForAttempt(
  db: McpDatabase,
  workspaceId: string,
  attemptId: string,
  taskId: string,
  sessionId: string | null,
  usage: UsageReport,
  measuredWindowMs: number,
): Promise<UsageGuard> {
  const window = checkUsageWindow(usage, measuredWindowMs);
  let reusedSession = false;

  if (sessionId) {
    const [previous] = await db
      .select({ id: executionAttempt.id })
      .from(executionAttempt)
      .innerJoin(task, eq(executionAttempt.taskId, task.id))
      .innerJoin(project, eq(task.projectId, project.id))
      .where(
        and(
          eq(project.workspaceId, workspaceId),
          eq(executionAttempt.sessionId, sessionId),
          isNotNull(executionAttempt.finishedAt),
          ne(executionAttempt.id, attemptId),
          ne(executionAttempt.taskId, taskId),
        ),
      )
      .limit(1);
    reusedSession = Boolean(previous);
  }

  const reasons = [
    ...(window.suspect ? ["claim_window_exceeded"] : []),
    ...(reusedSession ? ["session_reused"] : []),
  ];
  return {
    suspect: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join(",") : null,
  };
}

async function countReports(db: McpDatabase, row: TaskRow): Promise<number> {
  const [rowCount] = await db
    .select({ n: count() })
    .from(taskComment)
    .where(and(eq(taskComment.taskId, row.id), eq(taskComment.kind, "report")));
  return Number(rowCount?.n ?? 0);
}

/**
 * Resolves a project by uuid or by its card prefix (AGB), case-insensitively
 * and only inside the token's workspace. A non-uuid ref never reaches the
 * driver as a uuid: the cast error would surface as a raw "Failed query".
 */
async function findProject(
  db: Tx,
  workspaceId: string,
  projectRef: string,
): Promise<ProjectRow | null> {
  const ref = projectRef.trim();
  if (!ref) return null;
  const identity = looksLikeUuid(ref)
    ? eq(project.id, ref)
    : sql`upper(${project.idPrefix}) = ${ref.toUpperCase()}`;

  const [row] = await db
    .select()
    .from(project)
    .where(and(eq(project.workspaceId, workspaceId), identity))
    .limit(1);
  return row ?? null;
}

async function findMission(
  db: Tx,
  workspaceId: string,
  missionRef: string,
) {
  // task_create.mission and mission_get take an existing mission id.
  // A missing or unknown id is a clean NOT_FOUND — we never match by title
  // and never invent a mission on the fly.
  if (!looksLikeUuid(missionRef)) {
    return null;
  }
  const [row] = await db
    .select()
    .from(mission)
    .where(and(eq(mission.workspaceId, workspaceId), eq(mission.id, missionRef)))
    .limit(1);
  return row ?? null;
}

async function findTask(
  db: Tx,
  workspaceId: string,
  taskRef: string,
  lock = false,
): Promise<{ row: TaskRow; proj: ProjectRow } | null> {
  const ref = taskRef.trim();
  // Uuid or short id (AGB-5, OVK-5.4). Short ids are matched
  // case-insensitively and only inside the token's workspace.
  const identity = looksLikeUuid(ref)
    ? eq(task.id, ref)
    : sql`upper(${task.shortId}) = ${normalizeShortId(ref)}`;

  const query = db
    .select({ task, project })
    .from(task)
    .innerJoin(project, eq(task.projectId, project.id))
    .where(and(eq(project.workspaceId, workspaceId), identity))
    .limit(1);

  const rows = lock
    ? await query.for("update")
    : await query;
  const found = rows[0];
  return found ? { row: found.task, proj: found.project } : null;
}

async function allocateShortId(tx: Tx, proj: ProjectRow): Promise<string> {
  const [locked] = await tx
    .select()
    .from(project)
    .where(eq(project.id, proj.id))
    .for("update");
  const current = locked ?? proj;
  let allocated = nextShortId(current.idPrefix, current.nextNumber);
  // short_id is unique board-wide, so the number the counter points at can
  // already be spoken for. Walk the counter forward until it lands on a free
  // id instead of failing on the constraint.
  while (await shortIdTaken(tx, allocated.shortId)) {
    allocated = nextShortId(current.idPrefix, allocated.nextNumber);
  }
  await tx
    .update(project)
    .set({ nextNumber: allocated.nextNumber })
    .where(eq(project.id, proj.id));
  return allocated.shortId;
}

async function shortIdTaken(tx: Tx, shortId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: task.id })
    .from(task)
    .where(eq(task.shortId, shortId))
    .limit(1);
  return Boolean(row);
}

async function nextChildShortId(tx: Tx, parent: TaskRow): Promise<string> {
  const [counted] = await tx
    .select({ n: count() })
    .from(task)
    .where(eq(task.parentId, parent.id));
  return `${parent.shortId}.${Number(counted?.n ?? 0) + 1}`;
}

async function latestReopenComment(
  db: Tx,
  row: TaskRow,
): Promise<string | null> {
  if (row.status !== "aberto") return null;

  // Reopen comments only exist when the board moved a delivered card back to open,
  // which always leaves a handoff behind as the transition marker.
  const [latestHandoff] = await db
    .select({ createdAt: handoff.createdAt })
    .from(handoff)
    .where(eq(handoff.taskId, row.id))
    .orderBy(desc(handoff.createdAt))
    .limit(1);
  if (!latestHandoff) return null;

  // Only prose comments qualify: typed timeline entries (executor_swap,
  // spawn_failure) are traces, not reopen instructions for the next claim.
  const [comment] = await db
    .select()
    .from(taskComment)
    .where(
      and(
        eq(taskComment.taskId, row.id),
        eq(taskComment.kind, "comment"),
        isNotNull(taskComment.authorUserId),
        gt(taskComment.createdAt, latestHandoff.createdAt),
      ),
    )
    .orderBy(desc(taskComment.createdAt))
    .limit(1);
  return comment?.body ?? null;
}
