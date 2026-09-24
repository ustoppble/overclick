import {
  assessAttemptCost,
  canNestUnder,
  checkUsageWindow,
  claimExpiresAt,
  derivePrefix,
  executionAttempt,
  handoff,
  isValidPrefix,
  isClaimStale,
  mcpToken,
  mergeTranscriptRef,
  mission,
  missionAttempt,
  missionAttemptReport,
  nextShortId,
  normalizeModelKey,
  normalizeShortId,
  organization,
  project,
  projectContextAudit,
  readTranscriptRef,
  resolveUsageSegments,
  task,
  taskComment,
  transcriptRef,
  user,
  workspace,
  type ExecutorConfig,
  type ProjectContextSource,
  type UsageSegment,
  type UsageReport,
} from "@agent-board/db";
import {
  applyContextOps,
  applyTransition,
  branchConvention,
  confirmationSteps,
  discardRefusal,
  err,
  evaluateClaim,
  isMcpCoreError,
  isTelemetryIncomplete,
  telemetryIncompleteReason,
  MCP_TOOL_NAMES,
  ok,
  toolContracts,
  type CardExecutor,
  type CardStatus,
  type ContextOp,
  type DiscardCheck,
  type Harness,
  type ListInclude,
  type McpToolName,
  type OrganizationCounts,
  type ProjectMove,
  type ProjectResolution,
  type ReadOptions,
  type Result,
  type Reviewer,
  type Task,
  type TaskComment,
  type TranscriptRefWire,
  type Usage,
} from "@agent-board/mcp-core";
import { createHash } from "node:crypto";
import {
  canonicalTranscriptModel,
  identityFromTranscript,
} from "./transcript-model";
import { usageFromTranscript } from "./transcript-usage";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { applyExecutorUpdate } from "../lib/executors";
import {
  computeInsights,
  costSourceNote,
  filterAttemptsByPeriod,
  loadInsightAttemptRows,
  loadMissionAttemptRows,
  loadReopenRows,
  usageHonestyNote,
  type InsightsDb,
} from "../lib/insights";
import { manageDenialMessage } from "../lib/manage-capability";
import {
  canManageStructure,
  canManageWorkspace,
  canSeeMission,
  canSeeOrganization,
  canSeeProject,
  canSeeTask,
  isAdmin,
  missionScope,
  organizationScope,
  principalFromAuth,
  projectScope,
  taskScope,
  type MaybePrincipal,
} from "../lib/scope";
import { loadModelPrices, type PricesDb } from "../lib/prices";
import {
  bindUsageRecipe,
  loadUsageRecipes,
  recipeForCli,
  type RecipesDb,
} from "../lib/recipes";
import {
  verifyDelivery,
  type DeliveryVerificationResult,
} from "../lib/delivery-verification";
import { renderBriefingMarkdown } from "./briefing";
import { refreshProjectContext } from "../lib/project-context-refresh";
import {
  isExecutorPairConfigured,
  normalizeClaimCli,
  normalizeObservedExecutor,
  resolveClaimExecutor,
  unregisteredClaimModelRefusal,
  type AttemptModelSource,
} from "./executor-identity";
import { resolveProjectByRepo } from "./project-resolution";
import {
  decodeExecutor,
  emptyCardCounts,
  encodeExecutor,
  executorToWire,
  iso,
  looksLikeUuid,
  emptyOrganizationCounts,
  mapMission,
  mapOrganization,
  mapOrganizationDetail,
  mapProject,
  mapProjectDetail,
  mapProjectSummary,
  mapTask,
  mapTaskForRead,
  originToDb,
  parseComoConfirmo,
  reviewerFromRow,
  reviewerToColumns,
  serializeComoConfirmo,
  transcriptToWire,
  type OrganizationRow,
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

type TaskReadLayers = {
  briefing: boolean;
  mission: boolean;
  usage_recipe: boolean;
  comments: boolean;
};

const FULL_TASK_READ_LAYERS: TaskReadLayers = {
  briefing: true,
  mission: true,
  usage_recipe: true,
  comments: true,
};

function requestedFullRead(input?: ReadOptions): boolean {
  return input?.view === "briefing" || input?.view === "full";
}

function taskReadLayers(input?: ReadOptions, fullByDefault = false): TaskReadLayers {
  const includes = new Set(input?.include ?? []);
  const full = fullByDefault || requestedFullRead(input);
  return {
    briefing: full || includes.has("briefing"),
    mission: full || includes.has("mission"),
    usage_recipe: full || includes.has("usage_recipe"),
    comments: full || includes.has("comments"),
  };
}

function contextReadRequested(input?: ReadOptions): boolean {
  const includes = new Set(input?.include ?? []);
  return requestedFullRead(input) || includes.has("context") || includes.has("project");
}

type ListLayers = {
  ids: boolean;
  refs: boolean;
  delivery: boolean;
};

/**
 * task_list/task_search row groups. The default row is the operational
 * minimum (short_id, title, type, status, ...); every uuid and delivery flag
 * rides behind one of these groups instead.
 */
function listLayers(include?: ListInclude[]): ListLayers {
  const includes = new Set(include ?? []);
  const all = includes.has("all");
  return {
    ids: all || includes.has("ids"),
    refs: all || includes.has("refs"),
    delivery: all || includes.has("delivery"),
  };
}

/**
 * OCL-202 took the planned harness off the card: the Overclock app decides
 * what runs, the board records what ran. For one release the old inputs are
 * accepted and ignored with one of these warnings instead of an error, so a
 * caller written against the previous contract keeps working and learns why.
 */
const HARNESS_INPUT_IGNORED =
  "harness was ignored: the board no longer plans a harness (OCL-202). The Overclock app decides what runs; task_claim records what ran (executor cli, model, effort) and task_get returns it as executor. This input will be refused in a later release.";

const HARNESS_INCLUDE_IGNORED =
  "include harness was ignored: cards no longer carry a planned harness (OCL-202). task_get returns the executor that ran the card.";

function harnessIncludeWarnings(include?: ListInclude[]): { warnings?: string[] } {
  return include?.includes("harness") ? { warnings: [HARNESS_INCLUDE_IGNORED] } : {};
}

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
    const model = canonicalTranscriptModel(segment.model);
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
    delivery_unverified: row.deliveryUnverified,
    delivery_verification: row.deliveryVerification ?? null,
    delivery_warning: row.deliveryWarning ?? null,
    result: row.result as "success" | "failure" | "abandoned" | null,
    result_note: row.resultNote,
    transcript: transcriptToWire(row.transcript),
  };
}

type ChangedFields = Record<string, unknown>;

/**
 * Marks a caller-authored text field as written without echoing it (OCL-210).
 * The caller already holds what it sent, so repeating a 2,000-character
 * comment or a whole mission context doubled the cost of every write; the
 * read tools return the stored text for whoever needs it again.
 */
const WRITTEN = true;

/** Compact acknowledgement for a task mutation. */
function taskWriteAck(
  row: TaskRow,
  changed: ChangedFields,
  updatedAt: Date | string = row.updatedAt,
  warnings?: string[],
) {
  return {
    short_id: row.shortId,
    updated_at: iso(updatedAt),
    status: row.status,
    changed,
    ...(warnings?.length ? { warnings } : {}),
  };
}

/** Compact acknowledgement for a non-task row mutation. */
function rowWriteAck(
  id: string,
  updatedAt: Date | string,
  changed: ChangedFields,
  status?: string,
) {
  return {
    id,
    updated_at: iso(updatedAt),
    ...(status !== undefined ? { status } : {}),
    changed,
  };
}

/**
 * Compact acknowledgement for an executor mutation. `removed` sits at the top
 * level, not inside `changed`: ExecutorsWriteAckSchema requires it there, and
 * a caller branching on "did this delete the executor" should not have to dig
 * into a record typed as unknown to find out.
 */
function executorsWriteAck(
  id: string,
  updatedAt: Date | string,
  removed: boolean,
  changed: ChangedFields,
) {
  return {
    id,
    updated_at: iso(updatedAt),
    removed,
    changed,
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
    case "organization_list":
      value = await organizationList(db, ctx);
      break;
    case "organization_get":
      value = await organizationGet(
        db,
        ctx,
        data as Parameters<typeof organizationGet>[2],
      );
      break;
    case "organization_create":
      value = await organizationCreate(
        db,
        ctx,
        data as Parameters<typeof organizationCreate>[2],
      );
      break;
    case "organization_update":
      value = await organizationUpdate(
        db,
        ctx,
        data as Parameters<typeof organizationUpdate>[2],
      );
      break;
    case "organization_delete":
      value = await organizationDelete(
        db,
        ctx,
        data as Parameters<typeof organizationDelete>[2],
      );
      break;
    case "project_list":
      value = await projectList(
        db,
        ctx,
        data as Parameters<typeof projectList>[2],
      );
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
    case "project_context_refresh":
      value = await projectContextRefresh(
        db,
        ctx,
        data as Parameters<typeof projectContextRefresh>[2],
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
    case "mission_attempt_start":
      value = await missionAttemptStart(
        db,
        ctx,
        data as Parameters<typeof missionAttemptStart>[2],
      );
      break;
    case "mission_report_usage":
      value = await missionReportUsage(
        db,
        ctx,
        data as Parameters<typeof missionReportUsage>[2],
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
    case "task_reopen":
      value = await taskReopen(db, ctx, data as Parameters<typeof taskReopen>[2]);
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
/** Every message that sends an agent back to the organization tools says the same thing. */
const ORGANIZATION_HINT =
  "Call organization_list to see the organizations in this workspace, or organization_create to start one.";

/**
 * Internal lookups that only serve rows a caller already passed the scope
 * check for (names of the organizations behind a visible project) run as the
 * workspace itself, not as a person.
 */
function workspaceCtx(workspaceId: string): AuthContext {
  return {
    tokenId: "workspace",
    workspaceId,
    tokenLabel: "workspace",
    userId: "workspace",
    role: "admin",
    organizationId: null,
  };
}

async function listOrganizations(
  db: Tx,
  ctx: AuthContext,
): Promise<OrganizationRow[]> {
  return db
    .select()
    .from(organization)
    .where(
      and(
        eq(organization.workspaceId, ctx.workspaceId),
        organizationScope(principalFromAuth(ctx)),
      ),
    )
    .orderBy(asc(organization.createdAt));
}

/**
 * Uuid or name. Unlike a mission ref, the name is a legitimate handle here: it
 * is unique per workspace and it is what a human types.
 */
async function findOrganization(
  db: Tx,
  ctx: AuthContext,
  organizationRef: string,
  lock = false,
): Promise<OrganizationRow | null> {
  const ref = organizationRef.trim();
  if (!ref) return null;
  const identity = looksLikeUuid(ref)
    ? eq(organization.id, ref)
    : sql`lower(${organization.name}) = ${ref.toLowerCase()}`;

  const query = db
    .select()
    .from(organization)
    .where(
      and(
        eq(organization.workspaceId, ctx.workspaceId),
        organizationScope(principalFromAuth(ctx)),
        identity,
      ),
    )
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

/** A miss always comes back with the list, so the next call is not a guess. */
async function organizationNotFound(
  db: Tx,
  ctx: AuthContext,
  ref: string,
): Promise<Result<never>> {
  const rows = await listOrganizations(db, ctx);
  const options = rows.length
    ? ` Available: ${rows.map((row) => `${row.name} (${row.id})`).join(", ")}.`
    : "";
  return err(
    "NOT_FOUND",
    `Organization ${ref} not found in this workspace.${options} ${ORGANIZATION_HINT}`,
  );
}

/** Either the resolved row, or the refusal to hand straight back to the caller. */
type OrganizationChoice =
  | { row: OrganizationRow; refusal?: undefined }
  | { row?: undefined; refusal: Result<never> };

/**
 * The organization a new project or mission lands in. Naming one resolves it;
 * omitting it only works while the workspace holds a single business, because
 * picking one of several on the caller's behalf is exactly how a repo ends up
 * filed under the wrong company.
 */
async function resolveOrganizationChoice(
  db: Tx,
  ctx: AuthContext,
  ref: string | undefined,
): Promise<OrganizationChoice> {
  if (ref !== undefined) {
    const row = await findOrganization(db, ctx, ref);
    return row
      ? { row }
      : { refusal: await organizationNotFound(db, ctx, ref) };
  }

  const rows = await listOrganizations(db, ctx);
  const only = rows[0];
  if (rows.length === 1 && only) return { row: only };
  if (rows.length === 0) {
    return {
      refusal: err(
        "INVALID_ARGUMENT",
        "This workspace has no organization yet. Create one with organization_create and pass its name or id as organization.",
      ),
    };
  }
  return {
    refusal: err(
      "INVALID_ARGUMENT",
      `This workspace has ${rows.length} organizations, so organization cannot be omitted: pass one of ${rows
        .map((row) => `${row.name} (${row.id})`)
        .join(", ")}.`,
    ),
  };
}

/** Names by id: one query answers a whole page of projects or missions. */
async function organizationNames(
  db: Tx,
  workspaceId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(eq(organization.workspaceId, workspaceId));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * The foreign key guarantees the row exists, so a miss here means the map was
 * built for another workspace, not that a project has no business.
 */
function organizationNameOf(names: Map<string, string>, id: string): string {
  const name = names.get(id);
  if (!name) throw new Error(`organization ${id} is not in this workspace`);
  return name;
}

/** The organization a project or mission already points at, by the same rule. */
async function organizationOf(
  db: Tx,
  workspaceId: string,
  organizationId: string,
): Promise<OrganizationRow> {
  const row = await findOrganization(
    db,
    workspaceCtx(workspaceId),
    organizationId,
  );
  if (!row) {
    throw new Error(`organization ${organizationId} is not in this workspace`);
  }
  return row;
}

/** What every organization in the workspace holds, in three grouped queries. */
async function organizationCounts(
  db: Tx,
  ctx: AuthContext,
): Promise<Map<string, OrganizationCounts>> {
  const principal = principalFromAuth(ctx);
  const [projects, missions, cards] = await Promise.all([
    db
      .select({ id: project.organizationId, n: count() })
      .from(project)
      .where(and(eq(project.workspaceId, ctx.workspaceId), projectScope(principal)))
      .groupBy(project.organizationId),
    db
      .select({ id: mission.organizationId, n: count() })
      .from(mission)
      .where(and(eq(mission.workspaceId, ctx.workspaceId), missionScope(principal)))
      .groupBy(mission.organizationId),
    db
      .select({ id: project.organizationId, n: count() })
      .from(task)
      .innerJoin(project, eq(task.projectId, project.id))
      .where(
        and(
          eq(project.workspaceId, ctx.workspaceId),
          projectScope(principal),
          taskScope(principal),
        ),
      )
      .groupBy(project.organizationId),
  ]);

  const tally = new Map<string, OrganizationCounts>();
  const bucket = (id: string): OrganizationCounts => {
    const found = tally.get(id) ?? emptyOrganizationCounts();
    tally.set(id, found);
    return found;
  };
  for (const row of projects) bucket(row.id).projects = Number(row.n);
  for (const row of missions) bucket(row.id).missions = Number(row.n);
  for (const row of cards) bucket(row.id).cards = Number(row.n);
  return tally;
}

async function organizationList(db: McpDatabase, ctx: AuthContext) {
  const rows = await listOrganizations(db, ctx);
  const counts = await organizationCounts(db, ctx);
  return {
    organizations: rows.map((row) =>
      mapOrganization(row, counts.get(row.id) ?? emptyOrganizationCounts()),
    ),
  };
}

async function organizationGet(
  db: McpDatabase,
  ctx: AuthContext,
  input: { organization_id: string },
) {
  const row = await findOrganization(db, ctx, input.organization_id);
  if (!row) {
    return organizationNotFound(db, ctx, input.organization_id);
  }
  const counts = await organizationCounts(db, ctx);
  return {
    organization: mapOrganizationDetail(
      row,
      counts.get(row.id) ?? emptyOrganizationCounts(),
    ),
  };
}

async function organizationCreate(
  db: McpDatabase,
  ctx: AuthContext,
  input: { name: string; context?: string },
) {
  const structureDenied = requireStructure(ctx, "organization_create");
  if (structureDenied) return structureDenied;
  const name = input.name.trim();
  // The name is how callers refer to a business, so two of them sharing one
  // would make every reference ambiguous. Checked here for a clean message,
  // and again by the unique index below for concurrent creates.
  const taken = await findOrganization(db, ctx, name);
  if (taken) {
    return err(
      "INVALID_ARGUMENT",
      `Organization '${taken.name}' already exists in this workspace. Pass a different name, or edit it with organization_update.`,
    );
  }

  let row: OrganizationRow | undefined;
  try {
    [row] = await db
      .insert(organization)
      .values({
        workspaceId: ctx.workspaceId,
        name,
        context: input.context?.trim() ? input.context : null,
      })
      .returning();
  } catch (error) {
    if (isOrganizationNameConflict(error)) {
      return err(
        "INVALID_ARGUMENT",
        `Organization '${name}' was just created by another caller. Pass a different name.`,
      );
    }
    throw error;
  }
  if (!row) {
    throw new Error("failed to insert organization");
  }
  return {
    organization: mapOrganizationDetail(row, emptyOrganizationCounts()),
  };
}

function isOrganizationNameConflict(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
  return message.includes("organization_workspace_name");
}

async function organizationUpdate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    organization_id: string;
    name?: string;
    context?: string | null;
    return?: "ack" | "full";
  },
) {
  const structureDenied = requireStructure(ctx, "organization_update");
  if (structureDenied) return structureDenied;
  const current = await findOrganization(
    db,
    ctx,
    input.organization_id,
  );
  if (!current) {
    return organizationNotFound(db, ctx, input.organization_id);
  }

  const patch: { name?: string; context?: string | null } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.toLowerCase() !== current.name.toLowerCase()) {
      const taken = await findOrganization(db, ctx, name);
      if (taken) {
        return err(
          "INVALID_ARGUMENT",
          `Organization '${taken.name}' already exists in this workspace. Pass a different name.`,
        );
      }
    }
    patch.name = name;
  }
  if (input.context !== undefined) {
    patch.context = input.context?.trim() ? input.context : null;
  }

  let row: OrganizationRow | undefined;
  try {
    [row] = await db
      .update(organization)
      .set(patch)
      .where(
        and(
          eq(organization.id, current.id),
          eq(organization.workspaceId, ctx.workspaceId),
        ),
      )
      .returning();
  } catch (error) {
    if (isOrganizationNameConflict(error)) {
      return err(
        "INVALID_ARGUMENT",
        `Organization '${patch.name}' was just taken by another caller. Pass a different name.`,
      );
    }
    throw error;
  }
  if (!row) throw new Error("failed to update organization");

  if (input.return === "full") {
    const counts = await organizationCounts(db, ctx);
    return {
      organization: mapOrganizationDetail(
        row,
        counts.get(row.id) ?? emptyOrganizationCounts(),
      ),
    };
  }

  const changed: ChangedFields = {};
  if (current.name !== row.name) changed.name = WRITTEN;
  if (current.context !== row.context) changed.context = WRITTEN;
  return rowWriteAck(row.id, row.updatedAt, changed);
}

async function organizationDelete(
  db: McpDatabase,
  ctx: AuthContext,
  input: { organization_id: string; reassign_to?: string },
) {
  const structureDenied = requireStructure(ctx, "organization_delete");
  if (structureDenied) return structureDenied;
  return db.transaction(async (tx) => {
    const current = await findOrganization(
      tx,
      ctx,
      input.organization_id,
      true,
    );
    if (!current) {
      return organizationNotFound(tx, ctx, input.organization_id);
    }

    let heir: OrganizationRow | null = null;
    if (input.reassign_to !== undefined) {
      heir = await findOrganization(tx, ctx, input.reassign_to);
      if (!heir) {
        return organizationNotFound(tx, ctx, input.reassign_to);
      }
      if (heir.id === current.id) {
        return err(
          "INVALID_ARGUMENT",
          `reassign_to names '${current.name}', the organization being deleted. Name the organization that inherits its projects and missions.`,
        );
      }
    }

    const [projectRow] = await tx
      .select({ n: count() })
      .from(project)
      .where(eq(project.organizationId, current.id));
    const [missionRow] = await tx
      .select({ n: count() })
      .from(mission)
      .where(eq(mission.organizationId, current.id));
    const projects = Number(projectRow?.n ?? 0);
    const missions = Number(missionRow?.n ?? 0);

    // Both columns are not null and both foreign keys restrict, so there is no
    // force here and nothing to detach: an organization holding rows is either
    // emptied by hand or inherited by another one.
    if ((projects > 0 || missions > 0) && !heir) {
      const held = [
        projects > 0 ? `${projects} project${projects === 1 ? "" : "s"}` : null,
        missions > 0 ? `${missions} mission${missions === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(" and ");
      return err(
        "INVALID_ARGUMENT",
        `Organization '${current.name}' still holds ${held}, and neither can exist without one. Repeat this call with reassign_to naming the organization that inherits them, or move them one by one with project_update and mission_update passing organization.`,
      );
    }

    if (heir) {
      if (projects > 0) {
        await tx
          .update(project)
          .set({ organizationId: heir.id })
          .where(eq(project.organizationId, current.id));
      }
      if (missions > 0) {
        await tx
          .update(mission)
          .set({ organizationId: heir.id })
          .where(eq(mission.organizationId, current.id));
      }
    }

    await tx
      .delete(organization)
      .where(
        and(
          eq(organization.id, current.id),
          eq(organization.workspaceId, ctx.workspaceId),
        ),
      );

    return {
      deleted: true as const,
      organization_id: current.id,
      name: current.name,
      reassigned_to: heir ? { id: heir.id, name: heir.name } : null,
      projects_reassigned: heir ? projects : 0,
      missions_reassigned: heir ? missions : 0,
    };
  });
}

const PROJECT_HINT =
  "Call project_list to see the projects in this workspace, or project_create to start one.";

async function projectList(
  db: McpDatabase,
  ctx: AuthContext,
  input: { organization?: string; view?: "summary" | "full" },
) {
  const principal = principalFromAuth(ctx);
  const filters = [
    eq(project.workspaceId, ctx.workspaceId),
    projectScope(principal),
  ];
  if (input.organization) {
    const org = await findOrganization(db, ctx, input.organization);
    if (!org) {
      return organizationNotFound(db, ctx, input.organization);
    }
    filters.push(eq(project.organizationId, org.id));
  }

  // The default answers "which project is it" (OCL-208): measured on a real
  // board, the full rows came to 24,202 characters for 61 projects and the
  // three fields that pick one to 6,214. Counters, organization and uuid are
  // one view: full away.
  if (input.view !== "full") {
    const rows = await db
      .select({
        idPrefix: project.idPrefix,
        name: project.name,
        repoUrl: project.repoUrl,
      })
      .from(project)
      .where(and(...filters))
      .orderBy(asc(project.createdAt));
    return { projects: rows.map(mapProjectSummary) };
  }

  const rows = await db
    .select()
    .from(project)
    .where(and(...filters))
    .orderBy(asc(project.createdAt));

  const ids = rows.map((row) => row.id);
  const counts =
    ids.length === 0
      ? []
      : await db
          .select({ projectId: task.projectId, status: task.status, n: count() })
          .from(task)
          .where(and(inArray(task.projectId, ids), taskScope(principal)))
          .groupBy(task.projectId, task.status);

  const byProject = new Map<string, ReturnType<typeof emptyCardCounts>>();
  for (const row of counts) {
    const tally = byProject.get(row.projectId) ?? emptyCardCounts();
    const n = Number(row.n);
    tally[row.status] += n;
    tally.total += n;
    byProject.set(row.projectId, tally);
  }

  const names = await organizationNames(db, ctx.workspaceId);
  return {
    projects: rows.map((row) =>
      mapProject(
        row,
        organizationNameOf(names, row.organizationId),
        byProject.get(row.id) ?? emptyCardCounts(),
      ),
    ),
  };
}

async function projectGet(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    project_id: string;
    view?: ReadOptions["view"];
    include?: ReadOptions["include"];
  },
) {
  const row = await findProject(db, ctx, input.project_id);
  if (!row) {
    return err(
      "NOT_FOUND",
      `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
    );
  }
  const cards = await projectCardCounts(db, row.id, principalFromAuth(ctx));
  const names = await organizationNames(db, ctx.workspaceId);
  const orgName = organizationNameOf(names, row.organizationId);
  return {
    project: contextReadRequested(input)
      ? mapProjectDetail(row, orgName, cards)
      : mapProject(row, orgName, cards),
  };
}

async function projectCreate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    name: string;
    organization?: string;
    repo_url?: string;
    context?: string;
    current_version?: string;
    context_source?: {
      releases_repo?: string;
      context_file?: string;
      refresh: "on_release" | "daily" | "manual";
    };
    id_prefix?: string;
  },
) {
  const structureDenied = requireStructure(ctx, "project_create");
  if (structureDenied) return structureDenied;
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
  const taken = await findProject(db, ctx, prefix);
  if (taken) {
    return err(
      "INVALID_ARGUMENT",
      `Card prefix '${prefix}' is already used by project '${taken.name}'. Pass a different id_prefix.`,
    );
  }

  const choice = await resolveOrganizationChoice(
    db,
    ctx,
    input.organization,
  );
  if (choice.refusal) return choice.refusal;
  const org = choice.row;

  let row: ProjectRow | undefined;
  try {
    [row] = await db
      .insert(project)
      .values({
        workspaceId: ctx.workspaceId,
        organizationId: org.id,
        name,
        repoUrl: input.repo_url?.trim() || null,
        context: input.context?.trim() ? input.context : null,
        currentVersion: input.current_version?.trim() || null,
        contextSource: input.context_source
          ? {
              ...(input.context_source.releases_repo
                ? { releasesRepo: input.context_source.releases_repo }
                : {}),
              ...(input.context_source.context_file
                ? { contextFile: input.context_source.context_file }
                : {}),
              refresh: input.context_source.refresh,
            }
          : null,
        contextUpdatedAt:
          input.context || input.current_version || input.context_source
            ? new Date()
            : null,
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

  return { project: mapProjectDetail(row, org.name, emptyCardCounts()) };
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

async function projectCardCounts(
  db: Tx,
  projectId: string,
  principal: MaybePrincipal,
) {
  const rows = await db
    .select({ status: task.status, n: count() })
    .from(task)
    .where(and(eq(task.projectId, projectId), taskScope(principal)))
    .groupBy(task.status);
  const tally = emptyCardCounts();
  for (const row of rows) {
    const n = Number(row.n);
    tally[row.status] += n;
    tally.total += n;
  }
  return tally;
}

function contextHash(value: string | null | undefined): string {
  return createHash("sha256").update(value ?? "", "utf8").digest("hex");
}

function contextGuardError(
  value: string | null | undefined,
  input: { expected_len?: number; expected_hash?: string },
  field: string,
) {
  const current = value ?? "";
  if (input.expected_len !== undefined && current.length !== input.expected_len) {
    return err(
      "INVALID_ARGUMENT",
      `${field} changed since it was read (expected length ${input.expected_len}, current length ${current.length}). Re-read it and retry, or use granular context_ops.`,
    );
  }
  if (
    input.expected_hash !== undefined &&
    contextHash(current) !== input.expected_hash.toLowerCase()
  ) {
    return err(
      "INVALID_ARGUMENT",
      `${field} changed since it was read (expected_hash does not match). Re-read it and retry, or use granular context_ops.`,
    );
  }
  return null;
}

function applyContextDelta(
  value: string | null | undefined,
  operations: readonly ContextOp[],
  field: string,
): { ok: true; value: string } | ReturnType<typeof err> {
  try {
    return { ok: true, value: applyContextOps(value, operations) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid context operation";
    return err("INVALID_ARGUMENT", `${field}: ${message}`);
  }
}

async function projectUpdate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    project_id: string;
    name?: string;
    organization?: string;
    repo_url?: string | null;
    context?: string | null;
    context_ops?: ContextOp[];
    expected_len?: number;
    expected_hash?: string;
    current_version?: string | null;
    context_source?: {
      releases_repo?: string;
      context_file?: string;
      refresh: "on_release" | "daily" | "manual";
    } | null;
    id_prefix?: string;
    return?: "ack" | "full";
  },
) {
  const structureDenied = requireStructure(ctx, "project_update");
  if (structureDenied) return structureDenied;
  return db.transaction(async (tx) => {
    const proj = await findProject(tx, ctx, input.project_id, true);
    if (!proj) {
      return err(
        "NOT_FOUND",
        `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
      );
    }

    const patch: {
      name?: string;
      organizationId?: string;
      repoUrl?: string | null;
      context?: string | null;
      currentVersion?: string | null;
      contextSource?: ProjectContextSource | null;
      contextUpdatedAt?: Date;
      idPrefix?: string;
    } = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        return err("INVALID_ARGUMENT", "Project name cannot be empty.");
      }
      patch.name = name;
    }

    // The cards follow the project: they are read through it, never filed
    // under a business of their own.
    let org = await organizationOf(tx, ctx.workspaceId, proj.organizationId);
    if (input.organization !== undefined) {
      const moved = await findOrganization(
        tx,
        ctx,
        input.organization,
      );
      if (!moved) {
        return organizationNotFound(tx, ctx, input.organization);
      }
      patch.organizationId = moved.id;
      org = moved;
    }

    if (input.repo_url !== undefined) {
      patch.repoUrl = input.repo_url?.trim() || null;
    }

    if (input.context !== undefined || input.context_ops !== undefined) {
      const guard = contextGuardError(proj.context, input, "Project context");
      if (guard) return guard;

      if (input.context_ops !== undefined) {
        const applied = applyContextDelta(
          proj.context,
          input.context_ops,
          "Project context",
        );
        if (!applied.ok) return applied;
        if (applied.value.length > 32_000) {
          return err(
            "INVALID_ARGUMENT",
            "Project context cannot exceed 32000 characters after applying context_ops.",
          );
        }
        patch.context = applied.value.trim() ? applied.value : null;
      } else {
        patch.context = input.context?.trim() ? input.context : null;
      }
    }

    if (input.current_version !== undefined) {
      patch.currentVersion = input.current_version?.trim() || null;
    }

    if (input.context_source !== undefined) {
      patch.contextSource = input.context_source
        ? {
            ...(input.context_source.releases_repo
              ? { releasesRepo: input.context_source.releases_repo }
              : {}),
            ...(input.context_source.context_file
              ? { contextFile: input.context_source.context_file }
              : {}),
            refresh: input.context_source.refresh,
          }
        : null;
    }
    const contextWasTouched =
      input.context !== undefined ||
      input.context_ops !== undefined ||
      input.current_version !== undefined ||
      input.context_source !== undefined;
    if (contextWasTouched) patch.contextUpdatedAt = new Date();

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
        const cards = await countCards(tx, proj.id);
        if (cards > 0) {
          return err(
            "INVALID_ARGUMENT",
            `Project '${proj.name}' holds ${cards} card${cards === 1 ? "" : "s"} whose short ids already start with ${proj.idPrefix} (${proj.idPrefix}-1, ${proj.idPrefix}-2), and those ids are also in branches, commits and PR titles. Renumbering them is not offered. To reorganize, create the project you want with project_create and move the cards into it with task_update passing project_id: each card is restamped with the destination prefix, keeps its old id in previous_short_ids, and the response returns the old-to-new mapping. The prefix of an empty project can still be changed here.`,
          );
        }
        const taken = await findProject(tx, ctx, prefix);
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
      [row] = await tx
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

    if (contextWasTouched) {
      await tx.insert(projectContextAudit).values({
        projectId: row.id,
        source: "manual",
        sourceRef: `manual:${row.updatedAt.toISOString()}:${ctx.tokenId}`,
        version: row.currentVersion,
        prerelease: false,
        summary: "project context updated manually",
        actor: ctx.tokenLabel || "manual",
      });
    }

    const counts = await projectCardCounts(tx, row.id, principalFromAuth(ctx));
    if (input.return === "full") {
      return { project: mapProjectDetail(row, org.name, counts) };
    }

    const changed: ChangedFields = {};
    if (proj.name !== row.name) changed.name = WRITTEN;
    if (proj.organizationId !== row.organizationId) {
      changed.organization_id = row.organizationId;
      changed.organization_name = org.name;
    }
    if (proj.repoUrl !== row.repoUrl) changed.repo_url = row.repoUrl;
    if (proj.context !== row.context) changed.context = WRITTEN;
    if (proj.currentVersion !== row.currentVersion) {
      changed.current_version = row.currentVersion;
    }
    if (proj.idPrefix !== row.idPrefix) changed.id_prefix = row.idPrefix;
    return rowWriteAck(row.id, row.updatedAt, changed);
  });
}

async function projectContextRefresh(
  db: McpDatabase,
  ctx: AuthContext,
  input: { project_id: string; force?: boolean },
) {
  const structureDenied = requireStructure(ctx, "project_context_refresh");
  if (structureDenied) return structureDenied;
  const row = await findProject(db, ctx, input.project_id);
  if (!row) {
    return err(
      "NOT_FOUND",
      `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
    );
  }
  if (!row.contextSource) {
    return err(
      "INVALID_ARGUMENT",
      "Project has no context_source. Configure releases_repo, context_file or both with project_update first.",
    );
  }

  const refreshed = await refreshProjectContext(db, ctx.workspaceId, row.id, {
    actor: ctx.tokenLabel || "mcp",
  });
  if (!refreshed) return err("NOT_FOUND", "Project disappeared during refresh.");
  const counts = await projectCardCounts(db, refreshed.project.id, principalFromAuth(ctx));
  const names = await organizationNames(db, ctx.workspaceId);
  return {
    project: mapProjectDetail(
      refreshed.project,
      organizationNameOf(names, refreshed.project.organizationId),
      counts,
    ),
    updated: refreshed.updated,
    updates: refreshed.updates,
  };
}

async function projectDelete(
  db: McpDatabase,
  ctx: AuthContext,
  input: { project_id: string; force?: boolean },
) {
  const structureDenied = requireStructure(ctx, "project_delete");
  if (structureDenied) return structureDenied;
  const proj = await findProject(db, ctx, input.project_id);
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
  input: { status?: "ativa" | "pausada" | "concluida"; organization?: string },
) {
  const principal = principalFromAuth(ctx);
  const filters = [
    eq(mission.workspaceId, ctx.workspaceId),
    missionScope(principal),
  ];
  if (input.status) filters.push(eq(mission.status, input.status));
  if (input.organization) {
    const org = await findOrganization(db, ctx, input.organization);
    if (!org) {
      return organizationNotFound(db, ctx, input.organization);
    }
    filters.push(eq(mission.organizationId, org.id));
  }

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
          .where(and(inArray(task.missionId, ids), taskScope(principal)))
          .groupBy(task.missionId);
  const byMission = new Map(counts.map((row) => [row.missionId, Number(row.n)]));

  const names = await organizationNames(db, ctx.workspaceId);
  return {
    missions: rows.map((row) =>
      mapMission(
        row,
        organizationNameOf(names, row.organizationId),
        byMission.get(row.id) ?? 0,
      ),
    ),
  };
}

async function missionGet(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    mission_id: string;
    view?: ReadOptions["view"];
    include?: ReadOptions["include"];
  },
) {
  const row = await findMission(db, ctx, input.mission_id);
  if (!row) {
    return err(
      "NOT_FOUND",
      `Mission ${input.mission_id} not found. Call mission_list to see the available missions.`,
    );
  }
  const [counted] = await db
    .select({ n: count() })
    .from(task)
    .where(and(eq(task.missionId, row.id), taskScope(principalFromAuth(ctx))));
  const names = await organizationNames(db, ctx.workspaceId);
  const mapped = mapMission(
    row,
    organizationNameOf(names, row.organizationId),
    Number(counted?.n ?? 0),
  );
  if (contextReadRequested(input)) return { mission: mapped };
  const { objective: _objective, context: _context, ...summary } = mapped;
  return { mission: summary };
}

async function missionCreate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    title: string;
    organization?: string;
    objective?: string;
    context?: string;
    status?: "ativa" | "pausada" | "concluida";
  },
) {
  const choice = await resolveOrganizationChoice(
    db,
    ctx,
    input.organization,
  );
  if (choice.refusal) return choice.refusal;
  const org = choice.row;

  const objective = (input.objective ?? input.context ?? "").trim();
  const context = (input.context ?? input.objective ?? "").trim();
  const [row] = await db
    .insert(mission)
    .values({
      workspaceId: ctx.workspaceId,
      organizationId: org.id,
      title: input.title.trim(),
      objective,
      context,
      status: input.status ?? "ativa",
      createdByUserId: ctx.userId ?? null,
    })
    .returning();
  if (!row) {
    throw new Error("failed to insert mission");
  }
  return { mission: mapMission(row, org.name, 0) };
}

async function missionUpdate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    mission_id: string;
    title?: string;
    organization?: string;
    objective?: string;
    objective_ops?: ContextOp[];
    context?: string;
    context_ops?: ContextOp[];
    expected_len?: number;
    expected_hash?: string;
    status?: "ativa" | "pausada" | "concluida";
    return?: "ack" | "full";
  },
) {
  return db.transaction(async (tx) => {
    const current = await findMission(tx, ctx, input.mission_id, true);
    if (!current) {
      return err(
        "NOT_FOUND",
        `Mission ${input.mission_id} not found in this workspace. Call mission_list to see the available missions.`,
      );
    }

    const contextChanged =
      input.context !== undefined || input.context_ops !== undefined;
    const objectiveChanged =
      input.objective !== undefined || input.objective_ops !== undefined;
    if (
      (input.expected_len !== undefined || input.expected_hash !== undefined) &&
      Number(contextChanged) + Number(objectiveChanged) !== 1
    ) {
      return err(
        "INVALID_ARGUMENT",
        "expected_len/expected_hash guard exactly one mission blob (context or objective) per update.",
      );
    }

    if (input.status === "concluida" && current.status !== "concluida") {
      const [openAttempt] = await tx
        .select({ id: missionAttempt.id })
        .from(missionAttempt)
        .where(
          and(
            eq(missionAttempt.missionId, current.id),
            eq(missionAttempt.status, "aberto"),
          ),
        )
        .orderBy(desc(missionAttempt.startedAt))
        .limit(1);
      if (openAttempt) {
        return err(
          "MISSION_ATTEMPT_ALREADY_OPEN",
          `Mission '${current.title}' has an open orchestration attempt. Send its final mission_report_usage checkpoint before concluding the mission.`,
          { attempt_id: openAttempt.id, mission_id: current.id },
        );
      }
    }

    const patch: {
      title?: string;
      organizationId?: string;
      objective?: string;
      context?: string;
      status?: "ativa" | "pausada" | "concluida";
    } = {};
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.status !== undefined) patch.status = input.status;

    let org = await organizationOf(tx, ctx.workspaceId, current.organizationId);
    if (input.organization !== undefined) {
      const moved = await findOrganization(
        tx,
        ctx,
        input.organization,
      );
      if (!moved) {
        return organizationNotFound(tx, ctx, input.organization);
      }
      patch.organizationId = moved.id;
      org = moved;
    }

    if (contextChanged) {
      const guard = contextGuardError(current.context, input, "Mission context");
      if (guard) return guard;
      if (input.context_ops !== undefined) {
        const applied = applyContextDelta(
          current.context,
          input.context_ops,
          "Mission context",
        );
        if (!applied.ok) return applied;
        patch.context = applied.value;
      } else {
        patch.context = input.context?.trim() ?? "";
      }
    }

    if (objectiveChanged) {
      const guard = contextGuardError(current.objective, input, "Mission objective");
      if (guard) return guard;
      if (input.objective_ops !== undefined) {
        const applied = applyContextDelta(
          current.objective,
          input.objective_ops,
          "Mission objective",
        );
        if (!applied.ok) return applied;
        patch.objective = applied.value;
      } else {
        patch.objective = input.objective?.trim() ?? "";
      }
    }

    if (Object.keys(patch).length === 0) {
      const [counted] = await tx
        .select({ n: count() })
        .from(task)
        .where(and(eq(task.missionId, current.id), taskScope(principalFromAuth(ctx))));
      if (input.return === "full") {
        return {
          mission: mapMission(current, org.name, Number(counted?.n ?? 0)),
        };
      }
      return rowWriteAck(
        current.id,
        current.updatedAt,
        {},
        current.status,
      );
    }

    const [row] = await tx
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

    const [counted] = await tx
      .select({ n: count() })
      .from(task)
      .where(and(eq(task.missionId, row.id), taskScope(principalFromAuth(ctx))));
    if (input.return === "full") {
      return {
        mission: mapMission(row, org.name, Number(counted?.n ?? 0)),
      };
    }

  const changed: ChangedFields = {};
  if (current.title !== row.title) changed.title = WRITTEN;
  if (current.organizationId !== row.organizationId) {
    changed.organization_id = row.organizationId;
    changed.organization_name = org.name;
  }
  if (current.objective !== row.objective) changed.objective = WRITTEN;
  if (current.context !== row.context) changed.context = WRITTEN;
  if (current.status !== row.status) changed.status = row.status;
  return rowWriteAck(row.id, row.updatedAt, changed, row.status);
  });
}

async function missionDelete(
  db: McpDatabase,
  ctx: AuthContext,
  input: { mission_id: string; force?: boolean },
) {
  const current = await findMission(db, ctx, input.mission_id);
  if (!current) {
    return err(
      "NOT_FOUND",
      `Mission ${input.mission_id} not found in this workspace. Call mission_list to see the available missions.`,
    );
  }

  return db.transaction(async (tx) => {
    // Only the cards the caller may see are counted or named (OCL-227). An
    // admin can put a card of theirs in a member's mission; refusing, or
    // counting it, would tell the member that card exists. The mission is the
    // member's to delete, so those cards are detached with the rest and simply
    // end up with no mission, as `mission_id: null` would leave them.
    const [counted] = await tx
      .select({ n: count() })
      .from(task)
      .where(and(eq(task.missionId, current.id), taskScope(principalFromAuth(ctx))));
    const taskCount = Number(counted?.n ?? 0);

    if (taskCount > 0 && input.force !== true) {
      return err(
        "INVALID_ARGUMENT",
        `Mission '${current.title}' holds ${taskCount} card${taskCount === 1 ? "" : "s"}. Move or detach them first with task_update passing mission_id: null, or repeat this call with force: true to detach all ${taskCount} card${taskCount === 1 ? "" : "s"} and delete the mission.`,
      );
    }

    await tx
      .update(task)
      .set({ missionId: null })
      .where(eq(task.missionId, current.id));
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

type MissionAttemptExecutorInput = {
  cli?: string;
  model?: string;
  effort?: string;
  agent?: string;
  session_id: string;
};

type MissionReportInput = {
  mission_id: string;
  attempt_id?: string;
  mission_attempt_id?: string;
  sequence: number;
  checkpoint: "rodada" | "final";
  usage: Usage;
  result?: "success" | "abandoned";
  result_note?: string;
};

function missionAttemptUsage(
  row: typeof missionAttempt.$inferSelect,
): Usage | null {
  const hasUsage = Boolean(
    (row.usageSegments?.length ?? 0) > 0 ||
      row.tokensIn != null ||
      row.tokensOut != null ||
      row.tokensCache != null ||
      row.reportedCostUsd != null ||
      row.durationMs != null ||
      row.turns != null,
  );
  if (!hasUsage) return null;
  return {
    ...(row.usageSegments?.length ? { segments: row.usageSegments } : {}),
    ...(row.tokensIn != null ? { tokens_in: row.tokensIn } : {}),
    ...(row.tokensOut != null ? { tokens_out: row.tokensOut } : {}),
    ...(row.tokensCache != null ? { tokens_cache: row.tokensCache } : {}),
    ...(row.reportedCostUsd != null
      ? { cost_usd: Number(row.reportedCostUsd) }
      : {}),
    ...(row.durationMs != null ? { duration_ms: row.durationMs } : {}),
    ...(row.turns != null ? { turns: row.turns } : {}),
    estimated: row.usageEstimated,
  };
}

function mapMissionAttempt(row: typeof missionAttempt.$inferSelect) {
  const decoded = decodeExecutor(row.executor, row.model, row.modelSource);
  const { token_id: _tokenId, ...executor } = decoded;
  return {
    id: row.id,
    mission_id: row.missionId,
    project_id: row.projectId,
    executor: {
      ...executor,
      session_id: row.sessionId,
    },
    transcript: transcriptToWire(row.transcript),
    status: row.status,
    started_at: iso(row.startedAt),
    last_activity_at: iso(row.lastActivityAt),
    finished_at: row.finishedAt ? iso(row.finishedAt) : null,
    usage: missionAttemptUsage(row),
    server_duration_ms: row.serverDurationMs,
    last_report_sequence: row.lastReportSequence,
    usage_suspect: row.usageSuspect,
    usage_suspect_reason: row.usageSuspectReason,
    cost_usd: row.costUsd != null ? Number(row.costUsd) : null,
    cost_source: row.costSource ?? null,
    cost_status: row.costStatus ?? null,
    cost_unpriced_models: row.costUnpricedModels ?? [],
    result: row.result as "success" | "abandoned" | null,
    result_note: row.resultNote ?? null,
  };
}

function missionAttemptReportFingerprint(input: {
  checkpoint: "rodada" | "final";
  usageSegments: UsageSegment[];
  tokensIn: number | null | undefined;
  tokensOut: number | null | undefined;
  tokensCache: number | null | undefined;
  durationMs: number | null | undefined;
  turns: number | null | undefined;
  usageEstimated: boolean;
  reportedCostUsd: number | null | undefined;
  result: "success" | "abandoned" | null | undefined;
  resultNote: string | null | undefined;
}) {
  const usageSegments = input.usageSegments.map((segment) => ({
    model: segment.model ?? null,
    input: segment.input ?? null,
    output: segment.output ?? null,
    cache_read: segment.cache_read ?? null,
    cache_write: segment.cache_write ?? null,
  }));
  return JSON.stringify({
    checkpoint: input.checkpoint,
    usage_segments: usageSegments,
    tokens_in: input.tokensIn ?? null,
    tokens_out: input.tokensOut ?? null,
    tokens_cache: input.tokensCache ?? null,
    duration_ms: input.durationMs ?? null,
    turns: input.turns ?? null,
    estimated: input.usageEstimated,
    reported_cost_usd: input.reportedCostUsd ?? null,
    result: input.result ?? null,
    result_note: input.resultNote ?? null,
  });
}

function reportRowFingerprint(
  row: typeof missionAttemptReport.$inferSelect,
  reportedCostUsd: number | null | undefined,
) {
  return missionAttemptReportFingerprint({
    checkpoint: row.checkpoint,
    usageSegments: row.usageSegments ?? [],
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    tokensCache: row.tokensCache,
    durationMs: row.durationMs,
    turns: row.turns,
    usageEstimated: row.estimated,
    reportedCostUsd,
    result: row.result as "success" | "abandoned" | null,
    resultNote: row.resultNote,
  });
}

function addUsageSuspectReason(
  existing: string | null | undefined,
  reason: string,
): string {
  const reasons = (existing ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!reasons.includes(reason)) reasons.push(reason);
  return reasons.join(",");
}

/** Marks both sides when a transcript/session is shared with orchestration. */
async function markOrchestrationSessionReuse(
  db: Tx,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  const cardAttempts = await db
    .select({ id: executionAttempt.id, usageSuspectReason: executionAttempt.usageSuspectReason })
    .from(executionAttempt)
    .innerJoin(task, eq(executionAttempt.taskId, task.id))
    .innerJoin(project, eq(task.projectId, project.id))
    .where(
      and(
        eq(project.workspaceId, workspaceId),
        eq(executionAttempt.sessionId, sessionId),
      ),
    );

  for (const cardAttempt of cardAttempts) {
    await db
      .update(executionAttempt)
      .set({
        usageSuspect: true,
        usageSuspectReason: addUsageSuspectReason(
          cardAttempt.usageSuspectReason,
          "session_reused_orchestration",
        ),
      })
      .where(eq(executionAttempt.id, cardAttempt.id));
  }

  if (cardAttempts.length === 0) return false;
  return true;
}

/** The card side can be created after orchestration; flag its mission peers. */
async function markMissionAttemptsForSessionReuse(
  db: Tx,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  const orchestrationAttempts = await db
    .select({
      id: missionAttempt.id,
      usageSuspectReason: missionAttempt.usageSuspectReason,
    })
    .from(missionAttempt)
    .innerJoin(mission, eq(missionAttempt.missionId, mission.id))
    .where(
      and(
        eq(mission.workspaceId, workspaceId),
        eq(missionAttempt.sessionId, sessionId),
      ),
    );
  for (const orchestration of orchestrationAttempts) {
    await db
      .update(missionAttempt)
      .set({
        usageSuspect: true,
        usageSuspectReason: addUsageSuspectReason(
          orchestration.usageSuspectReason,
          "session_reused_orchestration",
        ),
      })
      .where(eq(missionAttempt.id, orchestration.id));
  }
  return orchestrationAttempts.length > 0;
}

async function abandonStaleMissionAttempt(
  db: Tx,
  row: typeof missionAttempt.$inferSelect,
  now: Date,
) {
  const hasUsage = Boolean(
    (row.usageSegments?.length ?? 0) > 0 ||
      row.tokensIn != null ||
      row.tokensOut != null ||
      row.tokensCache != null ||
      row.reportedCostUsd != null ||
      row.durationMs != null ||
      row.turns != null,
  );
  const [updated] = await db
    .update(missionAttempt)
    .set({
      status: "abandonado",
      finishedAt: now,
      lastActivityAt: now,
      result: "abandoned",
      resultNote: "stale",
      serverDurationMs: Math.max(0, now.getTime() - row.startedAt.getTime()),
      ...(!hasUsage ? { costStatus: "not_reported" as const } : {}),
    })
    .where(eq(missionAttempt.id, row.id))
    .returning();
  if (!updated) throw new Error("failed to abandon stale mission_attempt");
  return updated;
}

async function missionAttemptStart(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    mission_id: string;
    project_id?: string;
    executor: MissionAttemptExecutorInput;
    transcript?: TranscriptRefWire;
  },
) {
  return db.transaction(async (tx) => {
    const current = await findMission(tx, ctx, input.mission_id);
    if (!current) {
      return err(
        "NOT_FOUND",
        `Mission ${input.mission_id} not found in this workspace. Call mission_list to see the available missions.`,
      );
    }
    if (current.status !== "ativa") {
      return err(
        "MISSION_NOT_ACTIVE",
        `Mission '${current.title}' is ${current.status}; mission_attempt_start only accepts an active mission.`,
        { mission_id: current.id, status: current.status },
      );
    }

    let projectId: string | null = null;
    if (input.project_id !== undefined) {
      const proj = await findProject(tx, ctx, input.project_id);
      if (!proj) {
        return err(
          "NOT_FOUND",
          `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
        );
      }
      projectId = proj.id;
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

    const [open] = await tx
      .select()
      .from(missionAttempt)
      .where(
        and(
          eq(missionAttempt.missionId, current.id),
          eq(missionAttempt.status, "aberto"),
        ),
      )
      .orderBy(desc(missionAttempt.startedAt))
      .limit(1);
    const now = new Date();
    if (open) {
      if (isClaimStale(open.lastActivityAt, ws.claimTimeoutMinutes, now)) {
        await abandonStaleMissionAttempt(tx, open, now);
      } else {
        return err(
          "MISSION_ATTEMPT_ALREADY_OPEN",
          `Mission '${current.title}' already has an open orchestration attempt. Report its next cumulative snapshot or wait for the lease to expire.`,
          { attempt_id: open.id, mission_id: current.id },
        );
      }
    }

    const cli = normalizeClaimCli(input.executor.cli);
    const model = input.executor.model
      ? normalizeModelKey(input.executor.model)
      : undefined;
    const executor = {
      token_id: ctx.tokenId,
      ...(cli ? { cli } : {}),
      ...(input.executor.effort ? { effort: input.executor.effort } : {}),
      ...(input.executor.agent ? { agent: input.executor.agent } : {}),
      session_id: input.executor.session_id,
    };
    const transcript = transcriptRef({
      cli,
      sessionId: input.executor.session_id,
      path: input.transcript?.path,
      resume: input.transcript?.resume,
    });
    const [created] = await tx
      .insert(missionAttempt)
      .values({
        missionId: current.id,
        projectId,
        executor: JSON.stringify(executor),
        model: model || null,
        modelSource: model ? "declared" : null,
        sessionId: input.executor.session_id,
        transcript,
        startedAt: now,
        lastActivityAt: now,
      })
      .returning();
    if (!created) throw new Error("failed to insert mission_attempt");

    const reused = await markOrchestrationSessionReuse(
      tx,
      ctx.workspaceId,
      input.executor.session_id,
    );
    const saved = reused
      ? (
          await tx
            .update(missionAttempt)
            .set({
              usageSuspect: true,
              usageSuspectReason: "session_reused_orchestration",
            })
            .where(eq(missionAttempt.id, created.id))
            .returning()
        )[0] ?? created
      : created;

    return {
      attempt_id: saved.id,
      mission_attempt_id: saved.id,
      mission_id: saved.missionId,
      sequence: 0 as const,
      started_at: iso(saved.startedAt),
      attempt: mapMissionAttempt(saved),
    };
  });
}

async function missionReportUsage(
  db: McpDatabase,
  ctx: AuthContext,
  input: MissionReportInput,
) {
  const requestedAttemptId = input.attempt_id ?? input.mission_attempt_id;
  if (
    input.attempt_id &&
    input.mission_attempt_id &&
    input.attempt_id !== input.mission_attempt_id
  ) {
    return err(
      "INVALID_ARGUMENT",
      "attempt_id and mission_attempt_id must identify the same attempt",
    );
  }

  return db.transaction(async (tx) => {
    const current = await findMission(tx, ctx, input.mission_id);
    if (!current) {
      return err(
        "MISSION_ATTEMPT_NOT_FOUND",
        `Mission ${input.mission_id} not found in this workspace.`,
      );
    }

    const [attempt] = await tx
      .select()
      .from(missionAttempt)
      .where(
        and(
          eq(missionAttempt.missionId, current.id),
          requestedAttemptId
            ? eq(missionAttempt.id, requestedAttemptId)
            : eq(missionAttempt.status, "aberto"),
        ),
      )
      .orderBy(desc(missionAttempt.startedAt))
      .limit(1);
    if (!attempt) {
      return err(
        "MISSION_ATTEMPT_NOT_FOUND",
        `No open orchestration attempt was found for mission '${current.title}'.`,
        { mission_id: current.id, attempt_id: requestedAttemptId ?? null },
      );
    }
    const existing = await tx
      .select()
      .from(missionAttemptReport)
      .where(
        and(
          eq(missionAttemptReport.missionAttemptId, attempt.id),
          eq(missionAttemptReport.sequence, input.sequence),
        ),
      )
      .limit(1);
    const incomingUsage = resolveUsageSegments(input.usage, attempt.model);
    const incomingFingerprint = missionAttemptReportFingerprint({
      checkpoint: input.checkpoint,
      usageSegments: incomingUsage.segments,
      tokensIn: incomingUsage.tokens_in,
      tokensOut: incomingUsage.tokens_out,
      tokensCache: incomingUsage.tokens_cache,
      durationMs: incomingUsage.duration_ms,
      turns: incomingUsage.turns,
      usageEstimated: incomingUsage.estimated ?? false,
      reportedCostUsd: incomingUsage.cost_usd,
      result: input.result ?? null,
      resultNote: input.result_note ?? null,
    });
    const idempotent =
      input.sequence === attempt.lastReportSequence &&
      Boolean(existing[0]) &&
      reportRowFingerprint(
        existing[0]!,
        attempt.reportedCostUsd != null ? Number(attempt.reportedCostUsd) : null,
      ) === incomingFingerprint;
    if (attempt.status !== "aberto") {
      if (idempotent) {
        return {
          attempt_id: attempt.id,
          mission_attempt_id: attempt.id,
          mission_id: attempt.missionId,
          sequence: input.sequence,
          checkpoint: existing[0]!.checkpoint,
          idempotent: true,
          attempt: mapMissionAttempt(attempt),
        };
      }
      return err(
        "INVALID_ARGUMENT",
        `Mission attempt ${attempt.id} is already ${attempt.status}; reports after the final checkpoint are not accepted.`,
        { attempt_id: attempt.id, status: attempt.status },
      );
    }

    const [ws] = await tx
      .select({ claimTimeoutMinutes: workspace.claimTimeoutMinutes })
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId))
      .limit(1);
    if (!ws) return err("NOT_FOUND", "Workspace not found.");
    const now = new Date();
    if (isClaimStale(attempt.lastActivityAt, ws.claimTimeoutMinutes, now)) {
      await abandonStaleMissionAttempt(tx, attempt, now);
      return err(
        "MISSION_ATTEMPT_NOT_FOUND",
        `Mission attempt ${attempt.id} lease expired and was abandoned; start a new attempt.`,
        { attempt_id: attempt.id, reason: "stale" },
      );
    }

    if (input.sequence <= attempt.lastReportSequence) {
      if (idempotent) {
        return {
          attempt_id: attempt.id,
          mission_attempt_id: attempt.id,
          mission_id: attempt.missionId,
          sequence: input.sequence,
          checkpoint: existing[0].checkpoint,
          idempotent: true,
          attempt: mapMissionAttempt(attempt),
        };
      }
      return err(
        "INVALID_SEQUENCE",
        `Sequence ${input.sequence} is not a new cumulative snapshot for attempt ${attempt.id}.`,
        {
          last_report_sequence: attempt.lastReportSequence,
        },
      );
    }

    const usage = incomingUsage;
    const sessionReused = await markOrchestrationSessionReuse(
      tx,
      ctx.workspaceId,
      attempt.sessionId,
    );
    const prices = await loadModelPrices(tx as PricesDb, ctx.workspaceId);
    const assessment = assessAttemptCost(usage.segments ?? [], prices, {
      reportedCostUsd: usage.cost_usd,
      usageEstimated: usage.estimated,
      usageSuspect: attempt.usageSuspect || sessionReused,
      tokensReported: tokenCountersReported(usage),
    });
    const storedUsage: UsageReport = {
      ...usage,
      segments: assessment.normalizedSegments,
    };
    const final = input.checkpoint === "final";
    const result = final ? input.result ?? "success" : null;
    const [report] = await tx
      .insert(missionAttemptReport)
      .values({
        missionAttemptId: attempt.id,
        sequence: input.sequence,
        checkpoint: input.checkpoint,
        usageSegments: storedUsage.segments?.length
          ? storedUsage.segments
          : null,
        tokensIn: storedUsage.tokens_in,
        tokensOut: storedUsage.tokens_out,
        tokensCache: storedUsage.tokens_cache,
        durationMs: storedUsage.duration_ms,
        turns: storedUsage.turns,
        estimated: storedUsage.estimated ?? false,
        result,
        resultNote: final ? input.result_note ?? null : null,
      })
      .returning();
    if (!report) throw new Error("failed to insert mission_attempt_report");

    const [updated] = await tx
      .update(missionAttempt)
      .set({
        status: final
          ? result === "abandoned"
            ? "abandonado"
            : "sucesso"
          : "aberto",
        lastActivityAt: now,
        finishedAt: final ? now : null,
        usageSegments: storedUsage.segments?.length
          ? storedUsage.segments
          : null,
        tokensIn: storedUsage.tokens_in,
        tokensOut: storedUsage.tokens_out,
        tokensCache: storedUsage.tokens_cache,
        durationMs: storedUsage.duration_ms,
        serverDurationMs: final
          ? Math.max(0, now.getTime() - attempt.startedAt.getTime())
          : null,
        turns: storedUsage.turns,
        usageEstimated: storedUsage.estimated ?? false,
        reportedCostUsd:
          storedUsage.cost_usd !== undefined
            ? String(storedUsage.cost_usd)
            : null,
        costUsd: assessment.costUsd != null ? String(assessment.costUsd) : null,
        costSource: assessment.source,
        costStatus: assessment.status,
        costUnpricedModels: assessment.unpricedModels,
        costBreakdown: assessment.breakdown,
        usageSuspect: attempt.usageSuspect || sessionReused,
        usageSuspectReason: sessionReused
          ? addUsageSuspectReason(
              attempt.usageSuspectReason,
              "session_reused_orchestration",
            )
          : attempt.usageSuspectReason,
        result,
        resultNote: final ? input.result_note ?? null : null,
        lastReportSequence: input.sequence,
      })
      .where(eq(missionAttempt.id, attempt.id))
      .returning();
    if (!updated) throw new Error("failed to update mission_attempt");

    return {
      attempt_id: updated.id,
      mission_attempt_id: updated.id,
      mission_id: updated.missionId,
      sequence: input.sequence,
      checkpoint: input.checkpoint,
      idempotent: false,
      attempt: mapMissionAttempt(updated),
    };
  });
}

async function taskList(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    project_id?: string;
    mission_id?: string;
    organization?: string;
    resolved_in?: string;
    status?: CardStatus | CardStatus[];
    priority?: Task["priority"];
    type?: Task["type"];
    claimed_by?: "me" | "token";
    session_id?: string;
    order?: "oldest" | "newest";
    offset?: number;
    created_after?: string;
    awaiting_review_by?: "me" | string;
    limit?: number;
    include?: ListInclude[];
  },
) {
  const limit = input.limit ?? DEFAULT_TASK_LIST_LIMIT;
  const offset = input.offset ?? 0;
  const order = input.order ?? "oldest";
  const layers = listLayers(input.include);
  const filters = [
    eq(project.workspaceId, ctx.workspaceId),
    projectScope(principalFromAuth(ctx)),
    taskScope(principalFromAuth(ctx)),
  ];
  if (input.project_id) {
    const proj = await findProject(db, ctx, input.project_id);
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
  if (input.organization) {
    const org = await findOrganization(db, ctx, input.organization);
    if (!org) {
      return organizationNotFound(db, ctx, input.organization);
    }
    filters.push(eq(project.organizationId, org.id));
  }
  if (input.resolved_in) filters.push(eq(task.resolvedIn, input.resolved_in));
  if (input.priority) filters.push(eq(task.priority, input.priority));
  if (input.type) filters.push(eq(task.tipo, input.type));
  if (input.created_after) filters.push(gt(task.createdAt, new Date(input.created_after)));
  if (input.claimed_by) {
    filters.push(eq(task.claimedByTokenId, ctx.tokenId), eq(task.status, "em_execucao"));
  }
  if (input.session_id) {
    filters.push(eq(task.status, "em_execucao"), exists(
      db.select({ id: executionAttempt.id }).from(executionAttempt).where(and(
        eq(executionAttempt.taskId, task.id),
        eq(executionAttempt.sessionId, input.session_id),
        isNull(executionAttempt.finishedAt),
      )),
    ));
  }

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
    .orderBy(
      order === "newest" ? desc(task.createdAt) : asc(task.createdAt),
      order === "newest" ? desc(task.id) : asc(task.id),
    )
    .limit(limit + 1).offset(offset);

  const truncated = rows.length > limit;
  const selected = rows.slice(0, limit);
  const attemptRows =
    selected.length === 0
      ? []
      : await db
          .select({
            taskId: executionAttempt.taskId,
            costUsd: executionAttempt.costUsd,
          })
          .from(executionAttempt)
          .where(
            inArray(
              executionAttempt.taskId,
              selected.map((item) => item.task.id),
            ),
          )
          .orderBy(desc(executionAttempt.startedAt));
  const latestCostByTask = new Map<string, number | null>();
  for (const attempt of attemptRows) {
    if (!latestCostByTask.has(attempt.taskId)) {
      latestCostByTask.set(
        attempt.taskId,
        attempt.costUsd != null ? Number(attempt.costUsd) : null,
      );
    }
  }

  return {
    truncated,
    limit,
    offset,
    order,
    next_offset: truncated ? offset + limit : null,
    tasks: (await withVisibleLinks(
      db,
      ctx,
      selected.map((row) => row.task),
    )).map((visible, index) => {
      const mapped = mapTaskForRead(mapTask(visible, selected[index].project));
      const costUsd = latestCostByTask.get(mapped.id);
      return {
        short_id: mapped.short_id,
        title: mapped.title,
        type: mapped.type,
        status: mapped.status,
        priority: mapped.priority,
        // Attention flag: present only when true, never as a `false` line.
        ...(mapped.delivery_unverified ? { delivery_unverified: true } : {}),
        ...(costUsd != null ? { cost_usd: costUsd } : {}),
        ...(layers.ids ? { id: mapped.id } : {}),
        ...(layers.refs
          ? {
              project_id: mapped.project_id,
              ...(mapped.mission_id ? { mission_id: mapped.mission_id } : {}),
              ...(mapped.branch ? { branch: mapped.branch } : {}),
              ...(mapped.claimed_by ? { claimed_by: mapped.claimed_by } : {}),
            }
          : {}),
        ...(layers.delivery
          ? {
              revisado: mapped.revisado,
              devolve_para: mapped.devolve_para,
              ...(mapped.commit ? { commit: mapped.commit } : {}),
              ...(mapped.delivery_verification
                ? { delivery_verification: mapped.delivery_verification }
                : {}),
              ...(mapped.delivery_warning
                ? { delivery_warning: mapped.delivery_warning }
                : {}),
              ...(mapped.reports_count
                ? { reports_count: mapped.reports_count }
                : {}),
            }
          : {}),
      };
    }),
    ...harnessIncludeWarnings(input.include),
  };
}

async function taskGet(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    task_id: string;
    view?: ReadOptions["view"];
    include?: Array<NonNullable<ReadOptions["include"]>[number] | "delivery">;
    delivery_limit?: number;
    delivery_offset?: number;
  },
) {
  const found = await findTask(db, ctx, input.task_id);
  if (!found) {
    return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
  }
  const payload = await assembleTaskPayload(
    db,
    ctx,
    found.row,
    found.proj,
    undefined,
    undefined,
    await countReports(db, found.row),
    undefined,
    taskReadLayers({
      view: input.view,
      include: input.include?.filter((section) => section !== "delivery"),
    }),
  );
  const contract = compactTaskReadPayload(payload);
  const requested = input.include?.includes("delivery") || input.view === "full"
    || input.delivery_limit !== undefined || input.delivery_offset !== undefined;
  if (!requested) return contract;

  const limit = input.delivery_limit ?? 1;
  const offset = input.delivery_offset ?? 0;
  const rows = await db.select().from(handoff)
    .where(eq(handoff.taskId, found.row.id))
    .orderBy(desc(handoff.createdAt), desc(handoff.id))
    .limit(limit + 1).offset(offset);
  const truncated = rows.length > limit;
  return {
    ...contract,
    deliveries: rows.slice(0, limit).map((row) => ({
      id: row.id,
      task_id: row.taskId,
      attempt_id: row.attemptId ?? undefined,
      summary: row.summary,
      how_to_verify: row.howToVerify,
      // Preserve content from the evidence/artifact shapes used by older rows.
      evidence: row.evidences.map((item) => item.kind === "text"
        ? { text: item.value } : item.kind === "link" ? { url: item.value } : item),
      artifacts: row.artifacts.map((item) => "kind" in item ? item : {
        kind: "file", name: item.name, content: item.content, mime_type: item.mime,
      }),
      branch: row.branch,
      pull_request_url: row.prUrl && /^https?:\/\//.test(row.prUrl) ? row.prUrl : null,
      commit: row.commitHash,
      delivery_unverified: row.deliveryUnverified,
      delivery_verification: row.deliveryVerification,
      delivery_warning: row.deliveryWarning,
      usage: row.usage,
      telemetry_incomplete: isTelemetryIncomplete(row.usage),
      created_at: iso(row.createdAt),
    })),
    delivery_limit: limit,
    delivery_offset: offset,
    deliveries_truncated: truncated,
    next_delivery_offset: truncated ? offset + limit : null,
  };
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
    organization?: string;
    resolved_in?: string;
    type?: Task["type"];
    status?: CardStatus | CardStatus[];
    limit?: number;
    include?: ListInclude[];
  },
) {
  const q = input.q.trim();
  if (!q) return err("INVALID_ARGUMENT", "Search query cannot be empty.");

  const limit = input.limit ?? 5;
  const layers = listLayers(input.include);
  const filters = [
    eq(project.workspaceId, ctx.workspaceId),
    projectScope(principalFromAuth(ctx)),
    taskScope(principalFromAuth(ctx)),
  ];
  if (input.project_id) {
    const proj = await findProject(db, ctx, input.project_id);
    if (!proj) {
      return err(
        "NOT_FOUND",
        `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
      );
    }
    filters.push(eq(task.projectId, proj.id));
  }
  if (input.organization) {
    const org = await findOrganization(db, ctx, input.organization);
    if (!org) {
      return organizationNotFound(db, ctx, input.organization);
    }
    filters.push(eq(project.organizationId, org.id));
  }
  if (input.resolved_in) filters.push(eq(task.resolvedIn, input.resolved_in));
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
      short_id: row.task.shortId,
      title: row.task.title,
      type: row.task.tipo,
      status: row.task.status,
      o_que: row.task.oQue.slice(0, 300),
      ...(layers.ids ? { id: row.task.id } : {}),
      ...(layers.refs && row.task.resolvedIn
        ? { resolved_in: row.task.resolvedIn }
        : {}),
      ...(layers.delivery
        ? {
            comments_count: Number(row.commentsCount ?? 0),
            ...(Number(row.reportsCount ?? 0) > 0
              ? { reports_count: Number(row.reportsCount ?? 0) }
              : {}),
            updated_at: iso(row.task.updatedAt),
          }
        : {}),
    })),
    ...harnessIncludeWarnings(input.include),
  };
}

type CardProjectChoice =
  | { row: ProjectRow; resolution: ProjectResolution; refusal?: undefined }
  | { row?: undefined; resolution?: undefined; refusal: Result<never> };

/**
 * The project a new card lands in (OCL-208). A declared project_id always
 * wins, also when it names a project of another repository: filing a card for
 * another project from this checkout is routine, so the repo is never checked
 * against it. Without one, the repo the caller sent is matched against the
 * projects' repo_url; none or several comes back refused with what was looked
 * for or with the candidates, never with the whole list.
 */
async function resolveCardProject(
  db: Tx,
  ctx: AuthContext,
  input: { project_id?: string; repo?: string },
): Promise<CardProjectChoice> {
  if (input.project_id !== undefined) {
    const row = await findProject(db, ctx, input.project_id);
    if (!row) {
      return {
        refusal: err(
          "NOT_FOUND",
          `Project ${input.project_id} not found in this workspace. ${PROJECT_HINT}`,
        ),
      };
    }
    return { row, resolution: { id_prefix: row.idPrefix, from: "project_id" } };
  }

  const known = await db
    .select({
      id: project.id,
      idPrefix: project.idPrefix,
      name: project.name,
      repoUrl: project.repoUrl,
    })
    .from(project)
    .where(
      and(
        eq(project.workspaceId, ctx.workspaceId),
        projectScope(principalFromAuth(ctx)),
        isNotNull(project.repoUrl),
      ),
    )
    .orderBy(asc(project.createdAt));
  const found = resolveProjectByRepo(input.repo ?? "", known);

  if (found.kind === "unreadable") {
    return {
      refusal: err(
        "INVALID_ARGUMENT",
        "repo is not a git remote, owner/repo, a path or a name. Send what git remote get-url origin prints, or pass project_id (uuid or card prefix).",
      ),
    };
  }
  if (found.kind === "none") {
    const how =
      found.ref === "remote"
        ? ""
        : " A path or a name matches a file:// repo_url that holds it, or a repository named after one of its folders; the git remote (git remote get-url origin) matches exactly.";
    return {
      refusal: err(
        "NOT_FOUND",
        `No project in this workspace has a repo_url matching ${found.sought}.${how} If the card belongs to an existing project, pass its project_id (uuid or card prefix); if this repository has no project yet, create it with project_create passing repo_url, then retry.`,
      ),
    };
  }
  if (found.kind === "ambiguous") {
    const options = found.candidates
      .map((row) => `${row.idPrefix} (${row.name}, ${row.repoUrl})`)
      .join("; ");
    return {
      refusal: err(
        "INVALID_ARGUMENT",
        `${found.sought} matches ${found.candidates.length} projects: ${options}. Pass project_id with the card prefix of the right one.`,
      ),
    };
  }

  const row = await findProject(db, ctx, found.project.id);
  if (!row) {
    return {
      refusal: err(
        "NOT_FOUND",
        `Project ${found.project.idPrefix} was removed while this card was being filed. ${PROJECT_HINT}`,
      ),
    };
  }
  return {
    row,
    resolution: {
      id_prefix: row.idPrefix,
      from: "repo",
      match: found.match,
      ...(row.repoUrl ? { repo_url: row.repoUrl } : {}),
    },
  };
}

async function taskCreate(
  db: McpDatabase,
  ctx: AuthContext,
  input: {
    mission?: string;
    project_id?: string;
    repo?: string;
    title: string;
    type: Task["type"];
    o_que?: string;
    por_que?: string;
    como_confirmo?: Task["como_confirmo"] | string;
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
    origem?: Task["origem"];
    return?: "ack" | "full";
  },
) {
  const target = await resolveCardProject(db, ctx, input);
  if (target.refusal) return target.refusal;
  const proj = target.row;

  let missionId: string | null = null;
  if (input.mission) {
    const miss = await findMission(db, ctx, input.mission);
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
    const parent = await findTask(db, ctx, input.parent);
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

  // A card is born without a harness (OCL-202): the Overclock app decides what
  // runs it and task_claim records what did. A caller still sending one, on
  // the card or on a subtask, gets a warning for one release, not a refusal.
  const warnings =
    input.harness || input.subtasks?.some((item) => item.harness)
      ? [HARNESS_INPUT_IGNORED]
      : undefined;

  const reviewer = reviewerToColumns(input.devolve_para);
  // The board fills what it already knows (OCL-213): with no origem, the card
  // records the token that filed it.
  const origin = originToDb(input.origem ?? { agent: ctx.tokenLabel });
  // Text como_confirmo was already checked line by line by the input schema.
  const sentSteps =
    input.como_confirmo === undefined
      ? undefined
      : (confirmationSteps(input.como_confirmo) ?? undefined);

  return db.transaction(async (tx) => {
    const original = input.supersedes
      ? await findTask(tx, ctx, input.supersedes, true)
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
      sentSteps ??
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
        origin,
        mode: input.mode,
        createdByUserId: ctx.userId ?? null,
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
        supersededNote(original.row, created),
      );
      if (!discarded.ok) return discarded;
    }

    const children: TaskRow[] = [];
    for (const [index, item] of subtasks.entries()) {
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
          origin,
          mode: "solo",
          createdByUserId: ctx.userId ?? null,
        })
        .returning();
      if (!child) throw new Error("failed to insert subtask");
      children.push(child);
    }

    if (input.return === "full") {
      return {
        task: mapTask(created, proj),
        subtasks: children.map((child) => mapTask(child, proj)),
        project: target.resolution,
        ...(warnings ? { warnings } : {}),
      };
    }

    const changed: ChangedFields = {
      project_id: created.projectId,
      mode: created.mode,
      ...(created.missionId ? { mission_id: created.missionId } : {}),
      ...(created.parentId ? { parent_id: created.parentId } : {}),
      ...(created.supersedesId ? { supersedes: created.supersedesId } : {}),
      ...(children.length
        ? { subtasks: children.map((child) => child.shortId) }
        : {}),
    };
    return {
      ...taskWriteAck(created, changed, created.updatedAt, warnings),
      project: target.resolution,
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
      effort?: string;
      agent?: string;
      session_id?: string;
    };
    transcript?: TranscriptRefWire;
  },
) {
  const declaredModel = input.executor?.model?.trim();
  if (declaredModel) {
    const [claimWs] = await db
      .select({ executors: workspace.executors })
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId))
      .limit(1);
    if (!claimWs) {
      return err(
        "NOT_FOUND",
        "The workspace for this token no longer exists. Generate a new token in the board Settings.",
      );
    }
    const refusal = unregisteredClaimModelRefusal(
      input.executor?.cli,
      declaredModel,
      claimWs.executors,
    );
    if (refusal) {
      // Refused, but not forgotten: the pair still lands in seen_executors,
      // which is what Settings offers as "add this executor?". Otherwise
      // closing the catalog would also close the only path by which a real
      // new connection becomes known — the agent would be told to ask a human
      // to register it, and the human would have nothing to click.
      await recordSeenExecutor(db, ctx.workspaceId, {
        cli: input.executor?.cli,
        model: declaredModel ?? undefined,
      });
      return err("INVALID_ARGUMENT", refusal);
    }
  }

  const claimed = await db.transaction(async (tx) => {
    const found = await findTask(tx, ctx, input.task_id, true);
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
    // A claim the caller may not end (OCL-231): the admin's claim on a
    // member's card is the admin's to end, forced or gone stale.
    const mayEnd =
      found.row.status !== "em_execucao" ||
      (await mayEndClaim(tx, ctx, found.row.claimedByTokenId));
    if (input.force && !mayEnd) {
      return err(
        "PERMISSION_DENIED",
        "Only the person who owns this claim, or an admin, may force a claim over it. Call task_get to see its current status.",
      );
    }
    const reclaimedStale = Boolean(
      found.row.status === "em_execucao" &&
        !input.force &&
        mayEnd &&
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

    // What the claim declares is what the card records as having run it
    // (OCL-202): there is no planned harness left to fill gaps from or to
    // escalate along, the Overclock app made that choice before the claim.
    const executor = resolveClaimExecutor(input.executor);
    const claimTranscript = transcriptRef({
      cli: normalizeClaimCli(input.transcript?.cli) ?? executor.cli,
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

    let [attempt] = await tx
      .insert(executionAttempt)
      .values({
        taskId: updated.id,
        executor: encodeExecutor({
          token_id: ctx.tokenId,
          cli: executor.cli,
          effort: executor.effort,
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

    if (attempt.sessionId) {
      const orchestrationReuse = await markMissionAttemptsForSessionReuse(
        tx,
        ctx.workspaceId,
        attempt.sessionId,
      );
      if (orchestrationReuse) {
        const [flagged] = await tx
          .update(executionAttempt)
          .set({
            usageSuspect: true,
            usageSuspectReason: "session_reused_orchestration",
          })
          .where(eq(executionAttempt.id, attempt.id))
          .returning();
        attempt = flagged ?? attempt;
      }
    }

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
    ctx,
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

  return {
    task: payload.task,
    attempt: mapExecutionAttempt(claimed.value.attempt),
    briefing_markdown: payload.briefing_markdown,
    branch_convention: payload.branch_convention,
    usage_recipe: payload.usage_recipe,
    ...(claimed.value.reclaimedStale ? { reclaimed_stale: true } : {}),
  };
}

/**
 * Turns an open claim back into queue work. The attempt is closed rather than
 * deleted, so any usage already reported stays attributable and auditable.
 */
async function taskRelease(
  db: McpDatabase,
  ctx: AuthContext,
  input: { task_id: string; reason: string; return?: "ack" | "full" },
) {
  return db.transaction(async (tx) => {
    const found = await findTask(tx, ctx, input.task_id, true);
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
    if (found.row.claimedByTokenId !== ctx.tokenId && !canTakeOverClaim(ctx)) {
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

    if (input.return === "full") {
      return {
        task: mapTask(await visibleLinks(db, ctx, updated), found.proj, {
          executor: cardExecutorFromAttempt(abandoned),
        }),
        attempt: mapExecutionAttempt(abandoned),
      };
    }
    return taskWriteAck(updated, {
      claimed_by: null,
      status: updated.status,
    });
  });
}

/** Keeps a legitimate long-running attempt from becoming reclaimable. */
async function taskHeartbeat(
  db: McpDatabase,
  ctx: AuthContext,
  input: { task_id: string; return?: "ack" | "full" },
) {
  return db.transaction(async (tx) => {
    const found = await findTask(tx, ctx, input.task_id, true);
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
    if (found.row.claimedByTokenId !== ctx.tokenId && !canTakeOverClaim(ctx)) {
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
    const expiresAt = claimExpiresAt(now, ws.claimTimeoutMinutes);
    if (input.return === "full") {
      return {
        task_id: found.row.id,
        last_activity_at: iso(now),
        expires_at: iso(expiresAt),
      };
    }
    return taskWriteAck(
      found.row,
      {
        last_activity_at: iso(now),
        expires_at: iso(expiresAt),
      },
      now,
    );
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

async function taskReopen(
  db: McpDatabase,
  ctx: AuthContext,
  input: { task_id: string; reason: string },
) {
  return db.transaction(async (tx) => {
    const found = await findTask(tx, ctx, input.task_id, true);
    if (!found) return err("NOT_FOUND", `Task ${input.task_id} not found in this workspace.`);
    const transition = applyTransition({
      status: found.row.status,
      revisado: found.row.revisado,
      reopen_comment: null,
    }, { type: "reopen", comment: input.reason });
    if (!transition.ok) return transition;

    const now = new Date();
    const [updated] = await tx.update(task).set({
      status: transition.value.status,
      revisado: transition.value.revisado,
      validationTicks: [],
      claimedAt: null,
      claimedByExecutor: null,
      claimedByTokenId: null,
      updatedAt: now,
    }).where(eq(task.id, found.row.id)).returning();
    if (!updated) throw new Error("failed to reopen task");
    await tx.insert(taskComment).values({
      taskId: updated.id,
      authorAgentRef: ctx.tokenLabel,
      kind: "report",
      reopens: true,
      body: input.reason,
    });
    return taskWriteAck(updated, {
      status: "aberto", revisado: false, reopen_comment: WRITTEN, report_recorded: true,
    });
  });
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
    status?: "descartado" | "validado";
    superseded_by?: string;
    return?: "ack" | "full";
  },
) {
  const found = await findTask(db, ctx, input.task_id);
  if (!found) {
    return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
  }

  if (input.status === "validado") {
    // Validating is the admin's (OCL-227): a member may not sign off on the
    // card they wrote, whatever flags their token carries.
    if (!isAdmin(principalFromAuth(ctx))) {
      return err("PERMISSION_DENIED", "Only an admin can validate a card.");
    }
    const validated = await db.transaction(async (tx) => {
      const current = await findTask(tx, ctx, input.task_id, true);
      if (!current) {
        return err("NOT_FOUND", `Task ${input.task_id} not found in this workspace.`);
      }
      const transition = applyTransition(
        {
          status: current.row.status,
          revisado: current.row.revisado,
          reopen_comment: await latestReopenComment(tx, current.row),
        },
        { type: "validate", actor: "agent", comment: input.comment },
      );
      if (!transition.ok) return transition;
      const [updated] = await tx
        .update(task)
        .set({ status: "validado", revisado: true })
        .where(eq(task.id, current.row.id))
        .returning();
      if (!updated) throw new Error("failed to validate task");
      await tx.insert(taskComment).values({
        taskId: updated.id,
        authorAgentRef: ctx.tokenLabel,
        kind: "validation",
        body: input.comment!.trim(),
      });
      return ok(updated);
    });
    if (!validated.ok) return validated;
    const updated = validated.value;
    if (input.return !== "full") {
      return taskWriteAck(updated, {
        status: "validado", revisado: true, comment: WRITTEN,
      });
    }
    const latestUsageGuard = await latestUsageGuardForTask(db, updated.id);
    return {
      task: mapTask(await visibleLinks(db, ctx, updated), found.proj, {
        reopenComment: await latestReopenComment(db, updated),
        reportsCount: await countReports(db, updated),
        executor: await cardExecutorFor(db, updated.id),
      }),
      usage_suspect: latestUsageGuard.suspect,
      usage_suspect_reason: latestUsageGuard.reason,
    };
  }

  let nextRow = found.row;
  if (input.status === "descartado") {
    const denied = requireManage(ctx, "task_update {status: descartado}");
    if (denied) return denied;
    const discarded = await db.transaction(async (tx) => {
      const original = await findTask(tx, ctx, input.task_id, true);
      if (!original) {
        return err("NOT_FOUND", `Task ${input.task_id} not found in this workspace.`);
      }
      let continuation: TaskRow | null = null;
      if (input.superseded_by) {
        const foundContinuation = await findTask(
          tx,
          ctx,
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

      // One rule for the board UI and MCP (OCL-203): an open or delivered card
      // can go, and so can one in execution unless another executor is still
      // renewing a live claim on it. The refusal says who holds it and what to
      // do first, instead of a bare "no".
      let claim: DiscardCheck["claim"];
      if (original.row.status === "em_execucao") {
        const [openAttempt] = await tx
          .select({ lastActivityAt: executionAttempt.lastActivityAt })
          .from(executionAttempt)
          .where(
            and(
              eq(executionAttempt.taskId, original.row.id),
              isNull(executionAttempt.finishedAt),
            ),
          )
          .orderBy(desc(executionAttempt.startedAt))
          .limit(1);
        const [ws] = await tx
          .select({ claimTimeoutMinutes: workspace.claimTimeoutMinutes })
          .from(workspace)
          .where(eq(workspace.id, ctx.workspaceId))
          .limit(1);
        const lastActivity =
          openAttempt?.lastActivityAt ?? original.row.claimedAt ?? null;
        claim = {
          ownedByCaller: original.row.claimedByTokenId === ctx.tokenId,
          stale: lastActivity
            ? isClaimStale(lastActivity, ws?.claimTimeoutMinutes)
            : true,
          holder: original.row.claimedByExecutor,
          lastActivityAt: lastActivity ? iso(lastActivity) : null,
          expiresAt: lastActivity
            ? iso(claimExpiresAt(lastActivity, ws?.claimTimeoutMinutes))
            : null,
        };
      }
      const refusal = discardRefusal({
        shortId: original.row.shortId,
        status: original.row.status,
        continues: continuation !== null,
        ...(claim ? { claim } : {}),
      });
      if (refusal) return err("INVALID_TRANSITION", refusal);

      return discardSupersededTask(
        tx,
        original.row,
        continuation,
        input.comment?.trim() ||
          (continuation ? supersededNote(original.row, continuation) : "discarded"),
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
      const miss = await findMission(db, ctx, input.mission_id);
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
      // keeps that true instead of leaving its children behind. Only the
      // children the caller may see follow (OCL-227): an admin's subtask under
      // a member's card stays where the admin put it, and is never counted.
      const children = await tx
        .update(task)
        .set({ missionId })
        .where(
          and(eq(task.parentId, nextRow.id), taskScope(principalFromAuth(ctx))),
        )
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
    const dest = await findProject(db, ctx, input.project_id);
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
        const allChildren = await tx
          .select()
          .from(task)
          .where(eq(task.parentId, nextRow.id))
          .orderBy(asc(task.createdAt));
        // A subtask the caller may not see is not theirs to move, restamp or
        // name in the answer (OCL-227). It stays in its project under its id
        // and is detached instead, which is what keeps the rule above: no
        // subtask lives in a different project than its parent.
        const principal = principalFromAuth(ctx);
        const children = allChildren.filter((child) => canSeeTask(principal, child));
        const hidden = allChildren.filter((child) => !canSeeTask(principal, child));
        if (hidden.length > 0) {
          await tx
            .update(task)
            .set({ parentId: null })
            .where(inArray(task.id, hidden.map((child) => child.id)));
        }
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

  // Reclassifying the harness is gone with the planned harness (OCL-202); the
  // rest of this update still applies, and the caller is told why.
  const warnings = input.harness ? [HARNESS_INPUT_IGNORED] : undefined;
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
  // A discard's comment is its reason: it lands on the timeline saying so.
  const commentBody =
    input.comment && input.status === "descartado"
      ? `Discarded: ${input.comment.trim()}`
      : input.comment;
  const bodies = [
    ...(commentBody ? [{ kind: commentKind, body: commentBody }] : []),
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
    // Boot-failure trace from an orchestrator: the executor it launched never
    // started. Typed so the card detail labels it.
    await db.insert(taskComment).values({
      taskId: nextRow.id,
      authorAgentRef: ctx.tokenLabel,
      kind: "spawn_failure",
      body: input.spawn_failure,
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
  const changed: ChangedFields = {};
  if (found.row.missionId !== nextRow.missionId) {
    changed.mission_id = nextRow.missionId;
  }
  if (found.row.projectId !== nextRow.projectId) {
    changed.project_id = nextRow.projectId;
  }
  if (found.row.shortId !== nextRow.shortId) {
    changed.short_id = nextRow.shortId;
  }
  if (found.row.revisado !== nextRow.revisado) {
    changed.revisado = nextRow.revisado;
  }
  if (found.row.resolvedIn !== nextRow.resolvedIn) {
    changed.resolved_in = nextRow.resolvedIn;
  }
  if (found.row.supersededById !== nextRow.supersededById) {
    changed.superseded_by = nextRow.supersededById;
  }
  if (found.row.status !== nextRow.status) {
    changed.status = nextRow.status;
  }
  if (input.comment !== undefined) changed.comment = WRITTEN;
  if (input.progress !== undefined) changed.progress = WRITTEN;
  if (input.spawn_failure !== undefined) changed.spawn_failure = WRITTEN;
  if (usageRecorded) changed.usage_recorded = true;
  if (subtasksMoved !== null) changed.subtasks_moved = subtasksMoved;
  if (projectMove) changed.project_move = projectMove;

  if (input.return !== "full") {
    return taskWriteAck(nextRow, changed, nextRow.updatedAt, warnings);
  }

  return {
    task: mapTask(await visibleLinks(db, ctx, nextRow), proj, {
      reopenComment: await latestReopenComment(db, nextRow),
      reportsCount: await countReports(db, nextRow),
      executor: await cardExecutorFor(db, nextRow.id),
    }),
    usage_suspect: latestUsageGuard.suspect,
    usage_suspect_reason: latestUsageGuard.reason,
    ...(usageRecorded ? { usage_recorded: true } : {}),
    ...(subtasksMoved !== null ? { subtasks_moved: subtasksMoved } : {}),
    ...(projectMove ? { project_move: projectMove } : {}),
    ...(warnings ? { warnings } : {}),
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
  const storedTranscript = readTranscriptRef(attempt.transcript, {
    cli: executor.cli,
    sessionId: executor.session_id,
  });
  const sessionId = attempt.sessionId ?? storedTranscript?.sessionId ?? null;
  const attemptFinishedAt = attempt.finishedAt ?? new Date();
  const measuredWindowMs =
    attempt.serverDurationMs ??
    Math.max(0, attemptFinishedAt.getTime() - attempt.startedAt.getTime());
  const guard = await usageGuardForAttempt(
    db,
    workspaceId,
    attempt.id,
    attempt.taskId,
    sessionId,
    merged,
    measuredWindowMs,
    attempt.startedAt,
    attemptFinishedAt,
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
  // The file the card points at is the proof of which model ran; only that
  // earns "measured". Whatever the agent typed into usage.segments without a
  // readable transcript behind it is "declared" instead — see OCL-173.
  const fromTranscript = identityFromTranscript({
    cli: storedTranscript?.cli,
    path: storedTranscript?.path,
  });
  const measured = fromTranscript ?? measuredModelIdentity(storedUsage.segments);
  const claimedModel = attempt.model
    ? canonicalTranscriptModel(attempt.model)
    : null;
  const modelChanged = Boolean(measured && measured.model !== claimedModel);
  const newModelSource: AttemptModelSource | undefined = modelChanged
    ? fromTranscript
      ? "measured"
      : "declared"
    : undefined;

  await db
    .update(executionAttempt)
    .set({
      ...(newModelSource
        ? { model: measured?.model, modelSource: newModelSource }
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

/** Where the shipped recipe looks for this CLI's session transcript. */
function recipeTranscriptHint(cli: string): string {
  switch (cli) {
    case "grok":
      return "~/.grok/sessions/<cwd>/<session>/updates.jsonl";
    case "claude-code":
      return "~/.claude/projects/<cwd-slug>/<session>.jsonl";
    case "codex":
      return "~/.codex/sessions/<date>/rollout-*.jsonl";
    case "kimi":
      return "the Kimi session directory indexed in ~/.kimi-code/session_index.jsonl";
    default:
      return "the transcript path the recipe prints";
  }
}

/**
 * A tokens_per_model recipe already measured the run. estimated: true is only
 * allowed when the recipe itself could not read the transcript and printed
 * a reason to send along.
 */
function estimatedUsageRecipeRefusal(recipe: {
  cli: string;
  label: string;
  yields: string;
  instructions: string;
  command: string;
}): Result<never> {
  const path = recipeTranscriptHint(recipe.cli);
  const body = [
    `${recipe.label} (${recipe.cli}) yields ${recipe.yields}: exact tokens are on disk, so usage.estimated = true is refused unless you send the reason the recipe prints when it cannot read the transcript.`,
    `Transcript: ${path}`,
    "",
    recipe.instructions,
    recipe.command,
  ]
    .filter((line) => line !== "")
    .join("\n");
  return err("INVALID_ARGUMENT", body);
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
    commit?: string;
    pull_request_url?: string;
    resolved_in?: string;
    usage?: Usage;
    transcript?: TranscriptRefWire;
    return?: "ack" | "full";
  },
) {
  // Check the project remote before opening the database transaction. The
  // verifier is advisory by design: a missing commit or a network outage is
  // recorded on the delivery, never turned into a silent rejection.
  const preview = await findTask(db, ctx, input.task_id);
  if (!preview) {
    return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
  }
  // A delivery must identify its own pushed commit. Do not silently reuse an
  // older delivery's hash: on a project remote, omitting commit is precisely
  // the advisory unverified case the board needs to surface.
  const deliveryCommit = input.commit?.trim() || null;
  const deliveryBranch = input.branch?.trim() || preview.row.branch || null;
  const [verificationWorkspace] = await db
    .select({ githubToken: workspace.githubToken })
    .from(workspace)
    .where(eq(workspace.id, ctx.workspaceId))
    .limit(1);
  const deliveryVerification: DeliveryVerificationResult = await verifyDelivery({
    repoUrl: preview.proj.repoUrl,
    commit: deliveryCommit,
    branch: deliveryBranch,
  }, { githubToken: verificationWorkspace?.githubToken });

  const persisted = await db.transaction(async (tx) => {
    const found = await findTask(tx, ctx, input.task_id, true);
    if (!found) {
      return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
    }
    // Delivering ends the open claim, so it takes the same right as forcing
    // one (OCL-231).
    if (
      found.row.status === "em_execucao" &&
      !(await mayEndClaim(tx, ctx, found.row.claimedByTokenId))
    ) {
      return err(
        "PERMISSION_DENIED",
        "This card is in execution under someone else's claim. Only the person who owns that claim, or an admin, may deliver it.",
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
    if (input.usage?.estimated === true) {
      const recipes = await loadUsageRecipes(tx as RecipesDb, ctx.workspaceId);
      const recipe = recipeForCli(
        recipes,
        claimExecutor.cli ?? found.row.claimedByExecutor ?? null,
      );
      const reason = input.usage.reason?.trim() ?? "";
      if (recipe?.yields === "tokens_per_model" && !reason) {
        return estimatedUsageRecipeRefusal(recipe);
      }
    }
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
    // Usage by reference (OCL-211): a delivery that names its transcript and
    // sends no numbers gets them from the board, which runs the shipped recipe
    // on that file from the claim boundary. Numbers the agent sent always win.
    // A path this machine cannot read (the agent's disk, seen from a board in
    // the cloud) measures nothing, and the delivery goes on as one without
    // usage.
    const boardMeasured = input.usage
      ? null
      : await usageFromTranscript({
          cli: transcript?.cli ?? claimExecutor.cli ?? found.row.claimedByExecutor ?? null,
          path: transcript?.path,
          claimedAt: openAttempt?.startedAt,
        });
    // Usage as the board stores it: segments per model, with the flat
    // counters derived from them. A flat-only block still arrives here as one
    // segment for the model the attempt was claimed with.
    const usage: UsageReport | undefined = input.usage
      ? resolveUsageSegments(input.usage, openAttempt?.model ?? null)
      : boardMeasured
        ? resolveUsageSegments(
            {
              segments: boardMeasured.segments,
              turns: boardMeasured.turns,
              duration_ms: serverDurationMs,
              estimated: false,
            },
            openAttempt?.model ?? null,
          )
        : undefined;
    const incomplete = isTelemetryIncomplete(usage);
    // A flag that only says something is missing leaves the agent guessing
    // which field to send; the reason names them.
    const incompleteReason =
      !usage && transcript?.path
        ? `no usage was sent and the board cannot read ${transcript.path} from where it runs — run the usage recipe and send usage with task_update`
        : telemetryIncompleteReason(usage);

    // The file the card points at is the proof of which model ran. When it
    // is reachable and names one, that name wins over the claim and over
    // whatever the agent typed into usage.segments. Unreadable path → keep
    // the declared model (or the existing segments correction).
    const fromTranscript = identityFromTranscript({
      cli: transcript?.cli,
      path: transcript?.path,
    });
    const usageForCost =
      fromTranscript && !fromTranscript.chain.includes(" to ") && usage?.segments?.length
        ? {
            ...usage,
            segments: usage.segments.map((segment) =>
              segment.model ? { ...segment, model: fromTranscript.model } : segment,
            ),
          }
        : usage;

    const sessionId =
      transcript?.sessionId ?? openAttempt?.sessionId ?? claimExecutor.session_id ?? null;
    const usageGuard =
      openAttempt && usageForCost
        ? await usageGuardForAttempt(
            tx,
            ctx.workspaceId,
            openAttempt.id,
            openAttempt.taskId,
            sessionId,
            usageForCost,
            serverDurationMs,
            openAttempt.startedAt,
            finishedAt,
          )
        : { suspect: false, reason: null };
    const prices = await loadModelPrices(tx as PricesDb, ctx.workspaceId);
    const assessment = assessAttemptCost(usageForCost?.segments ?? [], prices, {
      reportedCostUsd: usageForCost?.cost_usd,
      usageEstimated: usageForCost?.estimated,
      usageSuspect: usageGuard.suspect,
      tokensReported: tokenCountersReported(usageForCost),
    });
    const storedUsage: UsageReport | undefined = usageForCost
      ? { ...usageForCost, segments: assessment.normalizedSegments }
      : undefined;
    // Only a transcript the server itself read off disk earns "measured";
    // a model that came only from usage.segments is the agent's word for it,
    // "declared" — see OCL-173.
    const measured = fromTranscript ?? measuredModelIdentity(storedUsage?.segments);
    const claimedModel = openAttempt?.model
      ? canonicalTranscriptModel(openAttempt.model)
      : null;
    const modelChanged = Boolean(measured && measured.model !== claimedModel);
    const newModelSource: AttemptModelSource | undefined = modelChanged
      ? fromTranscript || boardMeasured
        ? "measured"
        : "declared"
      : undefined;

    if (openAttempt) {
      await tx
        .update(executionAttempt)
        .set({
          ...(newModelSource
            ? { model: measured?.model, modelSource: newModelSource }
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
          deliveryUnverified: deliveryVerification.unverified,
          deliveryVerification: deliveryVerification.status ?? null,
          deliveryWarning: deliveryVerification.warning,
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
        branch: deliveryBranch,
        prUrl: input.pull_request_url ?? found.row.prUrl,
        commitHash: deliveryCommit,
        deliveryUnverified: deliveryVerification.unverified,
        deliveryVerification: deliveryVerification.status ?? null,
        deliveryWarning: deliveryVerification.warning,
        usage: storedUsage ?? null,
      })
      .returning();
    if (!saved) throw new Error("failed to insert handoff");

    const [updated] = await tx
      .update(task)
      .set({
        status: transition.value.status,
        revisado: transition.value.revisado,
        branch: deliveryBranch,
        prUrl: input.pull_request_url ?? found.row.prUrl,
        commitHash: deliveryCommit,
        deliveryUnverified: deliveryVerification.unverified,
        deliveryVerification: deliveryVerification.status ?? null,
        deliveryWarning: deliveryVerification.warning,
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
      incompleteReason,
      usage: storedUsage,
      routedTo: reviewerFromRow(updated),
      attemptExecutor: openAttempt
        ? {
            ...claimExecutor,
            ...(measured ? { model: measured.model } : {}),
            ...(newModelSource ? { model_source: newModelSource } : {}),
          }
        : null,
      transcript,
      usageGuard,
      deliveryVerification,
      attemptCostUsd: assessment.costUsd,
    });
  });

  if (!persisted.ok) return persisted;

  if (persisted.value.attemptExecutor) {
    await recordSeenExecutor(db, ctx.workspaceId, persisted.value.attemptExecutor);
  }

  if (input.return !== "full") {
    const updated = persisted.value.updated;
    return {
      ...taskWriteAck(updated, {
        branch: persisted.value.saved.branch,
        commit: persisted.value.saved.commitHash ?? null,
        pull_request_url: persisted.value.saved.prUrl ?? null,
        resolved_in: updated.resolvedIn ?? null,
        delivery_unverified: persisted.value.saved.deliveryUnverified,
        delivery_verification: persisted.value.saved.deliveryVerification ?? null,
        delivery_warning: persisted.value.saved.deliveryWarning ?? null,
        telemetry_incomplete: persisted.value.incomplete,
        ...(persisted.value.usage ? { usage_recorded: true } : {}),
      }),
      ...(persisted.value.incompleteReason
        ? { telemetry_incomplete_reason: persisted.value.incompleteReason }
        : {}),
      handoff_id: persisted.value.saved.id,
      cost_usd: persisted.value.attemptCostUsd,
      delivery_unverified: persisted.value.saved.deliveryUnverified,
      delivery_verification: persisted.value.saved.deliveryVerification ?? null,
      delivery_warning: persisted.value.saved.deliveryWarning ?? null,
      usage_suspect: persisted.value.usageGuard.suspect,
      usage_suspect_reason: persisted.value.usageGuard.reason,
    };
  }

  return {
    task: mapTask(
      await visibleLinks(db, ctx, persisted.value.updated),
      persisted.value.proj,
      { executor: await cardExecutorFor(db, persisted.value.updated.id) },
    ),
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
      commit: persisted.value.saved.commitHash ?? null,
      delivery_unverified: persisted.value.saved.deliveryUnverified,
      delivery_verification: persisted.value.saved.deliveryVerification ?? null,
      delivery_warning: persisted.value.saved.deliveryWarning ?? null,
      // What the board stored, segments included, not what arrived: a flat
      // block comes back as the single segment it became.
      usage: persisted.value.usage ?? null,
      telemetry_incomplete: persisted.value.incomplete,
      created_at: iso(persisted.value.saved.createdAt),
    },
    telemetry_incomplete: persisted.value.incomplete,
    ...(persisted.value.incompleteReason
      ? { telemetry_incomplete_reason: persisted.value.incompleteReason }
      : {}),
    usage_suspect: persisted.value.usageGuard.suspect,
    usage_suspect_reason: persisted.value.usageGuard.reason,
    delivery_unverified: persisted.value.saved.deliveryUnverified,
    delivery_verification: persisted.value.saved.deliveryVerification ?? null,
    delivery_warning: persisted.value.saved.deliveryWarning ?? null,
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
    const found = await findTask(tx, ctx, input.task_id, true);
    if (!found) {
      return err(
      "NOT_FOUND",
      `Task ${input.task_id} not found in this workspace. Call task_list to see the available cards.`,
    );
    }

    const allChildren = await tx
      .select({ id: task.id, createdByUserId: task.createdByUserId })
      .from(task)
      .where(eq(task.parentId, found.row.id));
    // A subtask the caller may not see is someone else's card (OCL-227): an
    // admin can open one under a member's card. It is detached before the
    // delete, so the cascade cannot take it, and it is left out of the counts.
    const principal = principalFromAuth(ctx);
    const children = allChildren.filter((child) => canSeeTask(principal, child));
    const hidden = allChildren.filter((child) => !canSeeTask(principal, child));
    if (hidden.length > 0) {
      await tx
        .update(task)
        .set({ parentId: null })
        .where(inArray(task.id, hidden.map((child) => child.id)));
    }
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
  const found = await findTask(db, ctx, input.task_id);
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
    task: mapTask(await visibleLinks(db, ctx, updated ?? found.row), found.proj, {
      reopenComment: await latestReopenComment(db, found.row),
      executor: await cardExecutorFor(db, found.row.id),
    }),
  };
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
    group_by?: "project" | "mission" | "model" | "executor" | "release" | "card";
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

  const [attemptRows, missionAttemptRows, reopenRows, prices] = await Promise.all([
    loadInsightAttemptRows(db as InsightsDb, ctx.workspaceId, principalFromAuth(ctx)),
    loadMissionAttemptRows(db as InsightsDb, ctx.workspaceId, principalFromAuth(ctx)),
    loadReopenRows(db as InsightsDb, ctx.workspaceId, principalFromAuth(ctx)),
    pricingEnabled
      ? loadModelPrices(db as PricesDb, ctx.workspaceId)
      : Promise.resolve([]),
  ]);
  const insights = computeInsights(
    filterAttemptsByPeriod(attemptRows, { since, until }),
    reopenRows,
    prices,
    filterAttemptsByPeriod(missionAttemptRows, { since, until }),
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
    delivery_unverified: row.deliveryUnverified,
  });
  const totals = totalsFor(insights.totals);

  const groupsFor = (rows: typeof insights.byProject) =>
    rows.map((row) => ({
      key: row.key,
      label: row.label,
      ...totalsFor(row),
      ...(row.sharedAttempts ? { shared_attempts: row.sharedAttempts } : {}),
    }));

  const groupSetFor = (set: {
    byProject: typeof insights.byProject;
    byMission: typeof insights.byMission;
    byModel: typeof insights.byModel;
  }) => ({
    by_project: groupsFor(set.byProject),
    by_mission: groupsFor(set.byMission),
    by_model: groupsFor(set.byModel),
  });

  const combinedGroupFor = (rows: typeof insights.combinedGroups.byProject) =>
    rows.map((row) => ({
      key: row.key,
      label: row.label,
      execution: {
        key: row.execution.key,
        label: row.execution.label,
        ...totalsFor(row.execution),
      },
      orchestration: {
        key: row.orchestration.key,
        label: row.orchestration.label,
        ...totalsFor(row.orchestration),
      },
      total: {
        key: row.total.key,
        label: row.total.label,
        ...totalsFor(row.total),
      },
    }));

  let grouped: Record<string, unknown> = {};
  if (input.group_by === "project") grouped = { groups: groupsFor(insights.byProject) };
  if (input.group_by === "mission") grouped = { groups: groupsFor(insights.byMission) };
  if (input.group_by === "model") grouped = { groups: groupsFor(insights.byModel) };
  if (input.group_by === "executor") grouped = { groups: groupsFor(insights.byExecutor) };
  if (input.group_by === "release") grouped = { groups: groupsFor(insights.byRelease) };
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
        delivery_unverified: card.deliveryUnverified,
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
      orchestration: totalsFor(insights.discarded.orchestration),
    },
    execution_totals: totalsFor(insights.executionTotals),
    orchestration_totals: totalsFor(insights.orchestrationTotals),
    orchestration_groups: groupSetFor(insights.orchestrationGroups),
    combined_groups: {
      by_project: combinedGroupFor(insights.combinedGroups.byProject),
      by_mission: combinedGroupFor(insights.combinedGroups.byMission),
      by_model: combinedGroupFor(insights.combinedGroups.byModel),
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
    efforts?: Record<string, string[]>;
    remove?: boolean;
    return?: "ack" | "full";
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
      `Executor '${input.cli}' is not in this workspace config. The board Settings list the configured executors.`,
    );
  }

  await db
    .update(workspace)
    .set({ executors: applied.config as ExecutorConfig[] })
    .where(eq(workspace.id, ctx.workspaceId));

  const [savedWorkspace] = await db
    .select({ updatedAt: workspace.updatedAt })
    .from(workspace)
    .where(eq(workspace.id, ctx.workspaceId))
    .limit(1);
  if (input.return === "full") {
    return {
      executors: applied.config.map(executorToWire),
      updated: applied.targetId,
      removed: applied.removed,
    };
  }

  const changed: ChangedFields = {};
  if (!applied.removed) {
    const target = applied.config.find((item) => item.id === applied.targetId);
    if (input.label !== undefined && target) changed.label = target.label;
    if (input.enabled !== undefined && target) changed.enabled = target.enabled;
    if (input.add_models?.length || input.remove_models?.length) {
      changed.models = target?.models ?? [];
    }
    if (input.efforts !== undefined && target) {
      changed.efforts = target.efforts;
    }
  }
  return executorsWriteAck(
    applied.targetId,
    savedWorkspace?.updatedAt ?? new Date(),
    applied.removed,
    changed,
  );
}

/** Organizations and projects are the admin's to create, edit and delete. */
function requireStructure(ctx: AuthContext, tool: string): Result<never> | null {
  if (canManageStructure(principalFromAuth(ctx))) return null;
  return err(
    "PERMISSION_DENIED",
    `${tool} is not available to this token: projects and organizations are managed by an admin.`,
  );
}

/**
 * Whether the caller may release or keep alive a claim another token holds.
 * The same rule as `requireManage` (OCL-227): the manage flag on a member's
 * token must not let them free, or hold on to, a claim the admin took on one
 * of their cards.
 */
function canTakeOverClaim(ctx: AuthContext): boolean {
  return ctx.canManage === true && canManageWorkspace(principalFromAuth(ctx));
}

type TaskLinks = Pick<
  TaskRow,
  "missionId" | "parentId" | "supersedesId" | "supersededById"
>;

/**
 * The cards as the caller may read them (OCL-231): a link to a mission or a
 * card out of their scope reads as absent, like the row it points at. An admin
 * may put a member's card in their mission or continue it with a card of
 * their own; the member reads neither id.
 */
async function withVisibleLinks<R extends TaskLinks>(
  db: Pick<McpDatabase, "select">,
  ctx: AuthContext,
  rows: R[],
): Promise<R[]> {
  const principal = principalFromAuth(ctx);
  if (isAdmin(principal)) return rows;
  const missionIds = [
    ...new Set(rows.flatMap((row) => (row.missionId ? [row.missionId] : []))),
  ];
  const taskIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.parentId, row.supersedesId, row.supersededById].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ),
  ];
  const missions = missionIds.length
    ? await db
        .select({ id: mission.id })
        .from(mission)
        .where(and(inArray(mission.id, missionIds), missionScope(principal)))
    : [];
  const tasks = taskIds.length
    ? await db
        .select({ id: task.id })
        .from(task)
        .where(and(inArray(task.id, taskIds), taskScope(principal)))
    : [];
  const seen = new Set([...missions, ...tasks].map((row) => row.id));
  const keep = (id: string | null) => (id && seen.has(id) ? id : null);
  return rows.map((row) => ({
    ...row,
    missionId: keep(row.missionId),
    parentId: keep(row.parentId),
    supersedesId: keep(row.supersedesId),
    supersededById: keep(row.supersededById),
  }));
}

async function visibleLinks<R extends TaskLinks>(
  db: Pick<McpDatabase, "select">,
  ctx: AuthContext,
  row: R,
): Promise<R> {
  const [visible] = await withVisibleLinks(db, ctx, [row]);
  return visible;
}

/**
 * Whether the caller may end a claim another token holds, by forcing a claim
 * over it, reclaiming it once stale, or delivering on it (OCL-231). An admin
 * may, with any token, as before. A member may end only a claim one of their
 * own tokens holds (an earlier installation that died mid-card), never the
 * admin's claim on one of their cards.
 */
async function mayEndClaim(
  db: Pick<McpDatabase, "select">,
  ctx: AuthContext,
  holderTokenId: string | null,
): Promise<boolean> {
  if (!holderTokenId || holderTokenId === ctx.tokenId) return true;
  if (isAdmin(principalFromAuth(ctx))) return true;
  if (!ctx.userId) return false;
  const [holder] = await db
    .select({ ownerUserId: mcpToken.ownerUserId })
    .from(mcpToken)
    .where(eq(mcpToken.id, holderTokenId))
    .limit(1);
  return holder?.ownerUserId === ctx.userId;
}

/**
 * The note left on the attempt a continuation cuts short. It names the
 * continuation only when both cards have the same author (OCL-227): an admin
 * can continue a member's card, and the member's card must not carry the id of
 * a card they cannot see. The admin still reaches it through `superseded_by`.
 */
function supersededNote(original: TaskRow, continuation: TaskRow): string {
  return original.createdByUserId === continuation.createdByUserId
    ? `superseded by ${continuation.shortId}`
    : "superseded by another card";
}

function requireManage(
  ctx: AuthContext,
  tool: string,
): Result<never> | null {
  // A token flag never widens what its owner may do: workspace configuration
  // stays with admins even if a member's token was ticked "can manage".
  if (ctx.canManage && canManageWorkspace(principalFromAuth(ctx))) return null;
  return err("PERMISSION_DENIED", manageDenialMessage(tool, ctx.tokenLabel));
}

/**
 * The harness that ran the card, as its latest claim recorded it (OCL-202):
 * cli and effort from the claim's executor, model from the attempt (declared
 * at claim, corrected by measured usage at delivery). Undefined before the
 * first claim, and for an attempt that recorded nothing usable.
 */
function cardExecutorFromAttempt(
  attempt: { executor: string | null; model: string | null } | undefined,
): CardExecutor | undefined {
  if (!attempt) return undefined;
  const decoded = decodeExecutor(attempt.executor, attempt.model);
  const effort = decoded.effort?.trim();
  const value: CardExecutor = {
    ...(decoded.cli ? { cli: decoded.cli } : {}),
    ...(decoded.model ? { model: decoded.model } : {}),
    ...(effort && effort.length <= 32 ? { effort } : {}),
  };
  return Object.keys(value).length > 0 ? value : undefined;
}

async function cardExecutorFor(
  db: McpDatabase,
  taskId: string,
): Promise<CardExecutor | undefined> {
  const [latest] = await db
    .select({ executor: executionAttempt.executor, model: executionAttempt.model })
    .from(executionAttempt)
    .where(eq(executionAttempt.taskId, taskId))
    .orderBy(desc(executionAttempt.startedAt))
    .limit(1);
  return cardExecutorFromAttempt(latest);
}

async function assembleTaskPayload(
  db: McpDatabase,
  /** Who is reading: the card's mission is shown only when they may see it. */
  ctx: AuthContext,
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
  read: TaskReadLayers = FULL_TASK_READ_LAYERS,
) {
  const wantsBriefing = read.briefing;
  const wantsMission = read.mission || wantsBriefing;
  const wantsRecipe = read.usage_recipe || wantsBriefing;
  const wantsComments = read.comments || wantsBriefing;
  const comment =
    reopenComment !== undefined
      ? reopenComment
      : await latestReopenComment(db, row);
  const count = reportsCount ?? 0;
  const [latestAttempt] = await db
    .select({
      startedAt: executionAttempt.startedAt,
      sessionId: executionAttempt.sessionId,
      executor: executionAttempt.executor,
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
  const mapped = mapTask(await visibleLinks(db, ctx, row), proj, {
    reopenComment: comment,
    reportsCount: count,
    executor: cardExecutorFromAttempt(latestAttempt),
  });
  // The business above the project. Loaded only for a briefing: every other
  // read of a card has no use for the organization markdown.
  const projectOrganization = wantsBriefing
    ? await organizationOf(db, proj.workspaceId, proj.organizationId)
    : null;
  let missionPayload = null;
  if (wantsMission && row.missionId) {
    // As the reader, not the workspace (OCL-227): an admin may put a member's
    // card in one of their missions, and that mission's objective and context
    // are still the admin's. Out of scope, the card reads as mission-less.
    const miss = await findMission(db, ctx, row.missionId);
    if (miss) {
      const missOrg = await organizationOf(
        db,
        proj.workspaceId,
        miss.organizationId,
      );
      missionPayload = mapMission(miss, missOrg.name);
    }
  }
  const comments = wantsComments ? await listTaskComments(db, row.id) : [];
  const convention = branchConvention(mapped.short_id, mapped.title);
  let recipe: ReturnType<typeof bindUsageRecipe> = null;
  if (wantsRecipe) {
    // Whoever is running the card gets the recipe for their own CLI. On a
    // task_get without an executor, the CLI that claimed the card names it;
    // anything else lands on the generic recipe.
    const recipes = await loadUsageRecipes(db as RecipesDb, proj.workspaceId);
    recipe = bindUsageRecipe(
      recipeForCli(recipes, cli ?? row.claimedByExecutor ?? null),
      {
        sessionId: executor?.sessionId ?? latestAttempt?.sessionId,
        model: executor?.model ?? latestAttempt?.model,
        claimedAt: executor?.claimedAt ?? latestAttempt?.startedAt,
      },
    );
  }
  const briefingMarkdown = wantsBriefing
    ? renderBriefingMarkdown({
        task: mapped,
        mission: missionPayload,
        organization: projectOrganization
          ? {
              name: projectOrganization.name,
              context: projectOrganization.context,
            }
          : null,
        project: {
          name: proj.name,
          idPrefix: proj.idPrefix,
          context: proj.context,
          currentVersion: proj.currentVersion,
        },
        branchConvention: convention,
        comments,
        recipe,
        claimedAt: latestAttempt?.startedAt
          ? iso(latestAttempt.startedAt)
          : null,
        reclaimedStale: executor?.reclaimedStale,
      })
    : undefined;
  return {
    task: mapped,
    branch_convention: convention,
    usage_suspect: latestAttempt?.usageSuspect ?? false,
    usage_suspect_reason: latestAttempt?.usageSuspectReason ?? null,
    cost_usd:
      latestAttempt?.costUsd != null ? Number(latestAttempt.costUsd) : null,
    cost_source: latestAttempt?.costSource ?? null,
    cost_status: latestAttempt?.costStatus ?? null,
    cost_unpriced_models: latestAttempt?.costUnpricedModels ?? [],
    ...(briefingMarkdown !== undefined
      ? { briefing_markdown: briefingMarkdown }
      : {}),
    ...(read.mission ? { mission: missionPayload } : {}),
    ...(read.comments ? { comments } : {}),
    ...(read.usage_recipe
      ? {
          usage_recipe: recipe
            ? {
                cli: recipe.cli,
                label: recipe.label,
                yields: recipe.yields,
                instructions: recipe.instructions,
                command: recipe.command,
              }
            : null,
        }
      : {}),
    ...(row.status === "descartado" && row.telemetryIncomplete
      ? {
          usage_warning:
            "custo do attempt abandonado não reportado — envie task_update {usage} no card descartado",
        }
      : {}),
  };
}

/** Keep task_get's compact read contract free of null and empty placeholders. */
function compactTaskReadPayload(
  payload: Awaited<ReturnType<typeof assembleTaskPayload>>,
) {
  return {
    task: mapTaskForRead(payload.task),
    branch_convention: payload.branch_convention,
    usage_suspect: payload.usage_suspect,
    ...(payload.briefing_markdown !== undefined
      ? { briefing_markdown: payload.briefing_markdown }
      : {}),
    ...(payload.mission ? { mission: payload.mission } : {}),
    ...(payload.comments ? { comments: payload.comments } : {}),
    ...(payload.usage_recipe ? { usage_recipe: payload.usage_recipe } : {}),
    ...(payload.usage_suspect_reason
      ? { usage_suspect_reason: payload.usage_suspect_reason }
      : {}),
    ...(payload.cost_usd != null ? { cost_usd: payload.cost_usd } : {}),
    ...(payload.cost_source ? { cost_source: payload.cost_source } : {}),
    ...(payload.cost_status ? { cost_status: payload.cost_status } : {}),
    ...(payload.cost_unpriced_models.length > 0
      ? { cost_unpriced_models: payload.cost_unpriced_models }
      : {}),
    ...(payload.usage_warning ? { usage_warning: payload.usage_warning } : {}),
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
 * session had already completed a different card in the same workspace whose
 * execution window overlaps this one. The usage recipe counts from each
 * card's own claimed_at, so two cards worked back to back by the same session
 * measure disjoint stretches of work and cannot double-count anything —
 * only an actual overlap can.
 */
async function usageGuardForAttempt(
  db: McpDatabase,
  workspaceId: string,
  attemptId: string,
  taskId: string,
  sessionId: string | null,
  usage: UsageReport,
  measuredWindowMs: number,
  startedAt: Date,
  finishedAt: Date,
): Promise<UsageGuard> {
  const window = checkUsageWindow(usage, measuredWindowMs);
  let reusedSession = false;
  let overlappingAttemptIds: string[] = [];
  let orchestrationReuse = false;

  if (sessionId) {
    const overlapping = await db
      .select({ id: executionAttempt.id, usageSuspectReason: executionAttempt.usageSuspectReason })
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
          lt(executionAttempt.startedAt, finishedAt),
          gt(executionAttempt.finishedAt, startedAt),
        ),
      );
    reusedSession = overlapping.length > 0;
    overlappingAttemptIds = overlapping.map((row) => row.id);

    if (reusedSession) {
      // The other side of the overlap never got a chance to know about this
      // attempt when it was delivered, so it is marked retroactively here —
      // the same both-sides pattern markOrchestrationSessionReuse uses below.
      for (const other of overlapping) {
        await db
          .update(executionAttempt)
          .set({
            usageSuspect: true,
            usageSuspectReason: addUsageSuspectReason(
              other.usageSuspectReason,
              `session_reused:${attemptId}`,
            ),
          })
          .where(eq(executionAttempt.id, other.id));
      }
    }

    const orchestrationAttempts = await db
      .select({
        id: missionAttempt.id,
        usageSuspectReason: missionAttempt.usageSuspectReason,
      })
      .from(missionAttempt)
      .innerJoin(mission, eq(missionAttempt.missionId, mission.id))
      .where(
        and(
          eq(mission.workspaceId, workspaceId),
          eq(missionAttempt.sessionId, sessionId),
        ),
      );
    orchestrationReuse = orchestrationAttempts.length > 0;
    if (orchestrationReuse) {
      await markOrchestrationSessionReuse(
        db,
        workspaceId,
        sessionId,
      );
      for (const orchestration of orchestrationAttempts) {
        await db
          .update(missionAttempt)
          .set({
            usageSuspect: true,
            usageSuspectReason: addUsageSuspectReason(
              orchestration.usageSuspectReason,
              "session_reused_orchestration",
            ),
          })
          .where(eq(missionAttempt.id, orchestration.id));
      }
    }
  }

  const reasons = [
    ...(window.suspect ? ["claim_window_exceeded"] : []),
    ...(reusedSession
      ? [`session_reused:${overlappingAttemptIds.join("+")}`]
      : []),
    ...(orchestrationReuse ? ["session_reused_orchestration"] : []),
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
 * Every prose comment, delivery report, or cited validation on a card, oldest first — the
 * corrections the owner makes to a contract after the card was created.
 * Typed timeline events (executor_swap, claim_stale, claim_release,
 * spawn_failure) are operational traces, not contract text, so they are
 * left out.
 */
async function listTaskComments(
  db: McpDatabase,
  taskId: string,
): Promise<TaskComment[]> {
  const rows = await db
    .select({
      body: taskComment.body,
      kind: taskComment.kind,
      createdAt: taskComment.createdAt,
      authorAgentRef: taskComment.authorAgentRef,
      authorEmail: user.email,
    })
    .from(taskComment)
    .leftJoin(user, eq(taskComment.authorUserId, user.id))
    .where(
      and(
        eq(taskComment.taskId, taskId),
        inArray(taskComment.kind, ["comment", "report", "validation"]),
      ),
    )
    .orderBy(asc(taskComment.createdAt));
  return rows.map((row) => ({
    author: row.authorAgentRef ?? row.authorEmail ?? "desconhecido",
    kind: row.kind === "report" ? "report" : row.kind === "validation" ? "validation" : "comment",
    body: row.body,
    created_at: iso(row.createdAt),
  }));
}

/**
 * Resolves a project by uuid or by its card prefix (AGB), case-insensitively
 * and only inside the token's workspace. A non-uuid ref never reaches the
 * driver as a uuid: the cast error would surface as a raw "Failed query".
 */
async function findProject(
  db: Tx,
  ctx: AuthContext,
  projectRef: string,
  lock = false,
): Promise<ProjectRow | null> {
  const ref = projectRef.trim();
  if (!ref) return null;
  const identity = looksLikeUuid(ref)
    ? eq(project.id, ref)
    : sql`upper(${project.idPrefix}) = ${ref.toUpperCase()}`;

  const query = db
    .select()
    .from(project)
    .where(
      and(
        eq(project.workspaceId, ctx.workspaceId),
        projectScope(principalFromAuth(ctx)),
        identity,
      ),
    )
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  const row = rows[0];
  return row ?? null;
}

async function findMission(
  db: Tx,
  ctx: AuthContext,
  missionRef: string,
  lock = false,
) {
  // task_create.mission and mission_get take an existing mission id.
  // A missing or unknown id is a clean NOT_FOUND — we never match by title
  // and never invent a mission on the fly.
  if (!looksLikeUuid(missionRef)) {
    return null;
  }
  const query = db
    .select()
    .from(mission)
    .where(
      and(
        eq(mission.workspaceId, ctx.workspaceId),
        missionScope(principalFromAuth(ctx)),
        eq(mission.id, missionRef),
      ),
    )
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  const row = rows[0];
  return row ?? null;
}

async function findTask(
  db: Tx,
  ctx: AuthContext,
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
    .where(
      and(
        eq(project.workspaceId, ctx.workspaceId),
        projectScope(principalFromAuth(ctx)),
        taskScope(principalFromAuth(ctx)),
        identity,
      ),
    )
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

  // Keep legacy human reopen comments and explicit MCP rejection reports.
  // Ordinary agent reports cannot replace the rejection instructions.
  const [comment] = await db
    .select()
    .from(taskComment)
    .where(
      and(
        eq(taskComment.taskId, row.id),
        or(
          and(eq(taskComment.kind, "comment"), isNotNull(taskComment.authorUserId)),
          and(eq(taskComment.kind, "report"), eq(taskComment.reopens, true)),
        ),
        gt(taskComment.createdAt, latestHandoff.createdAt),
      ),
    )
    .orderBy(desc(taskComment.createdAt))
    .limit(1);
  return comment?.body ?? null;
}
