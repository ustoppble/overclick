import { z } from "zod";
import { RELEASE_VERSION_PATTERN } from "../release.js";

export const CardStatusSchema = z.enum([
  "aberto",
  "em_execucao",
  "feito",
  "validado",
  "descartado",
]);

export const TaskTypeSchema = z.enum(["feature", "bug", "rfc"]);

/**
 * The release a card shipped in, as it is written (OCL-128). A delivery that
 * put its branch there ("ovka-78-...-f@68218bba") turned the branch into an
 * option on the board's RELEASE filter, beside v0.2.2 and with no cards under
 * it. A delivery already carries `branch` and `commit`; this field is the
 * release, so it takes a version and says so when it does not get one.
 *
 * Only the write paths use it. Reading filters (task_list, task_search) stay
 * permissive, so cards stamped before this guard remain findable by the exact
 * value they carry.
 */
export const ReleaseVersionSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    RELEASE_VERSION_PATTERN,
    "resolved_in is a release version (v1.4.0, 1.4.0, v1.0.0-rc.1); send a branch name in branch and a commit in commit",
  );

/** Keep in step with CARDAPIO_TASK_TYPES: the routing table is the source. */
export const CardapioTaskTypeSchema = z.enum([
  "feature",
  "tweak",
  "contract",
  "refactor",
  "bug",
  "deep_bug",
  "fleet_triage",
  "showpiece",
  "visual_fix",
  "publish",
  "page_copy",
  "docs",
  "microcopy",
  "rfc",
  "fanout",
  "doctrine",
  "review",
  "drone",
  "ship",
  "research",
]);

export const PrioritySchema = z.enum(["urgente", "alta", "media", "baixa"]);

/** Effort names belong to each provider/model, so the wire contract is open. */
export const EffortSchema = z.string().trim().min(1).max(32);

export const ModelTierSchema = z.enum(["top", "mid", "cheap"]);

export const ExecutionModeSchema = z.enum(["solo", "team"]);

/** Outcome of checking a delivered commit against the project's remote. */
export const DeliveryVerificationSchema = z.enum(["verified", "unverified"]);

export const MissionStatusSchema = z.enum(["ativa", "pausada", "concluida"]);

/** Lifecycle of an orchestration run attached to a mission. */
export const MissionAttemptStatusSchema = z.enum([
  "aberto",
  "sucesso",
  "abandonado",
]);

/** A usage snapshot either advances a live run or closes it. */
export const MissionAttemptCheckpointSchema = z.enum(["rodada", "final"]);

/** Final result recorded by the closing snapshot. */
export const MissionAttemptResultSchema = z.enum(["success", "abandoned"]);

/**
 * Shared read controls. Reads default to the compact contract/summary view;
 * callers opt into the expensive prompt material explicitly.
 */
export const ReadViewSchema = z.enum(["contract", "briefing", "full"]);

export const ReadIncludeSchema = z.enum([
  "briefing",
  "usage_recipe",
  "mission",
  "project",
  "context",
  "comments",
]);

export const ReadOptionsSchema = z.object({
  /** `briefing` and `full` are aliases for all heavy content. */
  view: ReadViewSchema.optional(),
  /** Add individual heavy sections without opting into every section. */
  include: z.array(ReadIncludeSchema).min(1).max(5).optional(),
}).strict();

/**
 * Row-scoped groups for task_list/task_search. The default row answers "what
 * exists and in what state"; every uuid, delivery flag and the planned
 * harness ride behind one of these instead of paying for a screenful of ids
 * nobody reads (every tool already accepts `short_id`).
 */
export const ListIncludeSchema = z.enum([
  /** The planned harness (cli, model, effort) — needed to dispatch a card. */
  "harness",
  /** Uuids: the card's own `id`. */
  "ids",
  /** commit, delivery_verification, delivery_warning, reports_count, revisado, devolve_para. */
  "delivery",
  /** mission_id, project_id, branch, claimed_by. */
  "refs",
  /** Every group above, at once. */
  "all",
]);

export const ListOptionsSchema = z.object({
  include: z.array(ListIncludeSchema).min(1).max(5).optional(),
}).strict();

/**
 * Write responses are compact by default. `full` is the explicit escape hatch
 * for callers that need the complete object after a mutation.
 *
 * Reads use `view`; writes use `return` so the two controls cannot be confused
 * when a caller composes a read and a mutation in the same workflow.
 */
export const WriteReturnSchema = z.enum(["ack", "full"]);

export const CliNameSchema = z.enum([
  "overclock",
  "claude-code",
  "codex",
  "gemini-cli",
  "cursor",
  "aider",
  "other",
]);

export const ConfirmationStepSchema = z.object({
  step: z.string().min(1),
  expected: z.string().min(1),
});

export const OrigemSchema = z
  .object({
    pane_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    cli: z.string().min(1).optional(),
    reportado_por: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.pane_id ||
          value.session_id ||
          value.agent ||
          value.cli ||
          value.reportado_por,
      ),
    { message: "origem precisa de ao menos um identificador (pane, session, agent, cli ou reportado_por)" },
  );

export const ReviewerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("human"),
    user_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal("agent"),
    session_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal("workspace_queue"),
  }),
]);

export const DEFAULT_REVIEWER = {
  kind: "workspace_queue",
} as const;

export const HarnessSchema = z.object({
  cli: z.string().min(1).optional(),
  model: z.string().min(1),
  effort: EffortSchema,
  /**
   * Which account/provider of `cli` runs this card (e.g. a second Claude
   * OAuth account). Optional and retrocompatible: omitted means any account
   * of that cli, today's behavior. Free text and leniently validated — the
   * board does not own the canonical account list, Overclock does.
   */
  account: z.string().min(1).nullable().optional(),
});

/**
 * What one model spent inside a run. A conversation that switched model sends
 * one segment per model instead of a single bucket that would credit the whole
 * run to whichever model was recorded first.
 */
export const UsageSegmentSchema = z.object({
  /**
   * Null only on a segment the board folded out of a flat usage block for an
   * attempt whose executor never named a model. Agents sending segments name
   * the model: that is the whole point of sending them.
   */
  model: z.string().min(1).nullable(),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
  cache_read: z.number().int().nonnegative().optional(),
  cache_write: z.number().int().nonnegative().optional(),
});

export const UsageSchema = z.object({
  /**
   * Tokens per model. Preferred over the flat counters below: the board keeps
   * both, deriving the flat totals from the segments. The flat shape alone is
   * still accepted and is stored as a single segment.
   */
  segments: z.array(UsageSegmentSchema).optional(),
  tokens_in: z.number().int().nonnegative().optional(),
  tokens_out: z.number().int().nonnegative().optional(),
  tokens_cache: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
  /**
   * True when the numbers are the executor's estimate instead of exact
   * telemetry. Estimates are welcome: the card labels them "estimated"
   * rather than showing nothing.
   */
  estimated: z.boolean().optional(),
});

/**
 * Where the run's own transcript lives. The board stores this reference and
 * never the content: the file is on the machine that ran the card, which is
 * also the only machine where the resume and recompute commands make sense.
 * `path` is usually only known at deliver time, so a claim may send just the
 * session and fill the rest later.
 */
export const TranscriptRefSchema = z.object({
  /** CLI that owns the session. Defaults to the claim executor's cli. */
  cli: z.string().min(1).nullable().optional(),
  /** Defaults to the claim executor's session_id. */
  session_id: z.string().min(1).nullable().optional(),
  /** Path on the agent machine, as the usage recipe prints it. */
  path: z.string().min(1).nullable().optional(),
  /** Command that reopens the session. Derived for known CLIs when omitted. */
  resume: z.string().min(1).nullable().optional(),
});

/** The stored reference, with every field resolved or explicitly absent. */
export const StoredTranscriptRefSchema = z.object({
  cli: z.string().min(1).nullable(),
  session_id: z.string().min(1).nullable(),
  path: z.string().min(1).nullable(),
  resume: z.string().min(1).nullable(),
});

export const EvidenceSchema = z
  .object({
    text: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .refine((value) => Boolean(value.text || value.url), {
    message: "evidência precisa de text ou url",
  });

export const ArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rfc_markdown"),
    name: z.string().min(1),
    markdown: z.string().min(1),
  }),
  z.object({
    kind: z.literal("markdown"),
    name: z.string().min(1),
    markdown: z.string().min(1),
  }),
  z.object({
    kind: z.literal("link"),
    name: z.string().min(1),
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal("file"),
    name: z.string().min(1),
    content: z.string().optional(),
    url: z.string().url().optional(),
    mime_type: z.string().optional(),
  }),
]);

export const SubtaskCreateSchema = z.object({
  title: z.string().min(1),
  scope: z.string().min(1),
  boundary: z.string().min(1),
  o_que: z.string().min(1).optional(),
  por_que: z.string().min(1).optional(),
  como_confirmo: z.array(ConfirmationStepSchema).optional(),
  harness: HarnessSchema.optional(),
  devolve_para: ReviewerSchema.optional(),
});

export const BranchConventionSchema = z.object({
  branch: z.string().min(1),
  commit_prefix: z.string().min(1),
});

export const IsoDateTimeSchema = z.string().datetime();

/** Common shape for the small acknowledgement returned by write tools. */
export const WriteAckSchema = z.object({
  /** Task writes identify the card with its stable human-facing id. */
  short_id: z.string().min(1).optional(),
  /** Non-task writes identify their resource with its uuid or policy key. */
  id: z.string().min(1).optional(),
  updated_at: IsoDateTimeSchema,
  /** Only values changed or produced by the mutation; never the full object. */
  changed: z.record(z.unknown()),
});

/**
 * What an organization holds. Enough to tell a live business from an empty
 * shell without a second call, and exactly what organization_delete counts
 * when it refuses.
 */
export const OrganizationCountsSchema = z.object({
  projects: z.number().int().nonnegative(),
  missions: z.number().int().nonnegative(),
  /** Cards across the projects of this organization. */
  cards: z.number().int().nonnegative(),
});

export const OrganizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Summary-only signal: organization_list never sends the markdown itself. */
  has_context: z.boolean(),
  counts: OrganizationCountsSchema,
  created_at: IsoDateTimeSchema,
});

/** The complete payload: organization_get and the write tools send the markdown. */
export const OrganizationDetailSchema = OrganizationSchema.extend({
  context: z.string().nullable(),
});

export const MissionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: MissionStatusSchema,
  /** The business this mission runs for. Never null: the column is not. */
  organization_id: z.string().min(1),
  organization_name: z.string().min(1),
  task_count: z.number().int().nonnegative().optional(),
});

export const MissionSchema = MissionSummarySchema.extend({
  objective: z.string(),
  context: z.string(),
});

/** Cards in a project, split by status so the totals never hide the queue. */
export const ProjectCardCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  aberto: z.number().int().nonnegative(),
  em_execucao: z.number().int().nonnegative(),
  feito: z.number().int().nonnegative(),
  validado: z.number().int().nonnegative(),
  descartado: z.number().int().nonnegative(),
});

const GitHubRepoRefSchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/[^:/\s]+(?:\.git)?$/, "use owner/repo");

const GitHubContextFileRefSchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/[^:/\s]+:[^\s]+$/, "use owner/repo:path/to/context.md");

export const ProjectContextRefreshSchema = z.enum([
  "on_release",
  "daily",
  "manual",
]);

/** Optional sources that can update a project's managed context. */
export const ProjectContextSourceSchema = z
  .object({
    releases_repo: GitHubRepoRefSchema.optional(),
    context_file: GitHubContextFileRefSchema.optional(),
    refresh: ProjectContextRefreshSchema.default("manual"),
  })
  .strict()
  .refine(
    (value) => Boolean(value.releases_repo || value.context_file),
    "context_source needs releases_repo or context_file",
  );

export type ProjectContextSource = z.infer<typeof ProjectContextSourceSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Card prefix: `AGB` gives `AGB-1`, `AGB-2`. Unique per workspace. */
  id_prefix: z.string().min(1),
  /** The business this project belongs to. Never null: the column is not. */
  organization_id: z.string().min(1),
  organization_name: z.string().min(1),
  repo_url: z.string().nullable(),
  /** Summary-only signal: project_list never sends the markdown itself. */
  has_context: z.boolean(),
  /** Number the next card in this project will get. */
  next_number: z.number().int().positive(),
  cards: ProjectCardCountsSchema,
  created_at: IsoDateTimeSchema,
});

/** The complete project payload returned by project_get and write tools. */
export const ProjectDetailSchema = ProjectSchema.extend({
  context: z.string().nullable(),
  current_version: z.string().nullable(),
  latest_prerelease: z.string().nullable(),
  context_updated_at: IsoDateTimeSchema.nullable(),
  context_source: ProjectContextSourceSchema.nullable(),
});

export const TaskSummarySchema = z.object({
  id: z.string().min(1),
  short_id: z.string().min(1),
  title: z.string().min(1),
  type: TaskTypeSchema,
  status: CardStatusSchema,
  revisado: z.boolean(),
  priority: PrioritySchema,
  project_id: z.string().min(1),
  mission_id: z.string().min(1).nullable(),
  devolve_para: ReviewerSchema,
  /** Commit hash reported at the latest delivery, when one was sent. */
  commit: z.string().min(1).nullable(),
  /** True when a project remote exists but the latest delivery was not verified. */
  delivery_unverified: z.boolean(),
  delivery_verification: DeliveryVerificationSchema.nullable(),
  delivery_warning: z.string().nullable(),
  /**
   * Only comments with kind `report` are counted.
   * 0 by default in list payloads and detailed counts in get/update.
   */
  reports_count: z.number().int().nonnegative().default(0),
});

/**
 * A prose comment or delivery report attached to a card, in the order they
 * were written. Typed timeline events (executor swaps, stale-claim
 * takeovers) are operational traces, not contract corrections, and are left
 * out: this is only what a human or agent deliberately said about the card.
 */
export const TaskCommentSchema = z.object({
  author: z.string().min(1),
  kind: z.enum(["comment", "report"]),
  body: z.string().min(1),
  created_at: IsoDateTimeSchema,
});

export const TaskSchema = TaskSummarySchema.extend({
  workspace_id: z.string().min(1),
  /**
   * Short ids this card carried before, oldest first. A move between projects
   * restamps `short_id` with the destination prefix and leaves the old one
   * here, so a branch or PR named after it is still traceable.
   */
  previous_short_ids: z.array(z.string().min(1)),
  parent_id: z.string().min(1).nullable(),
  /** Card this one continues, if it replaced an abandoned execution. */
  supersedes: z.string().min(1).nullable(),
  /** Replacement card, when this card was discarded. */
  superseded_by: z.string().min(1).nullable(),
  o_que: z.string(),
  por_que: z.string(),
  como_confirmo: z.array(ConfirmationStepSchema),
  harness: HarnessSchema.nullable(),
  origem: OrigemSchema,
  mode: ExecutionModeSchema,
  branch: z.string().min(1).nullable(),
  pull_request_url: z.string().url().nullable(),
  /**
   * Version, tag or release the card was resolved in, free text. Null until
   * a delivery or a later task_update says so. Lets a caller compare "which
   * build has this" against a version someone reports.
   */
  resolved_in: z.string().nullable(),
  reopen_comment: z.string().nullable(),
  claimed_by: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});

/**
 * Read payload for task_get. Workspace identity and absent optional values do
 * not belong in a card read: the MCP token already scopes the workspace, and
 * callers can distinguish an unset field from an empty string without paying
 * for a collection of null placeholders.
 */
export const TaskReadSchema = TaskSchema.omit({
  workspace_id: true,
  mission_id: true,
  commit: true,
  delivery_verification: true,
  delivery_warning: true,
  previous_short_ids: true,
  parent_id: true,
  supersedes: true,
  superseded_by: true,
  harness: true,
  branch: true,
  pull_request_url: true,
  resolved_in: true,
  reopen_comment: true,
  claimed_by: true,
  reports_count: true,
}).extend({
  mission_id: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
  delivery_verification: DeliveryVerificationSchema.optional(),
  delivery_warning: z.string().min(1).optional(),
  previous_short_ids: z.array(z.string().min(1)).min(1).optional(),
  parent_id: z.string().min(1).optional(),
  supersedes: z.string().min(1).optional(),
  superseded_by: z.string().min(1).optional(),
  harness: HarnessSchema.optional(),
  branch: z.string().min(1).optional(),
  pull_request_url: z.string().url().optional(),
  resolved_in: z.string().min(1).optional(),
  reopen_comment: z.string().min(1).optional(),
  claimed_by: z.string().min(1).optional(),
  reports_count: z.number().int().positive().optional(),
});

/** Queue rows stay metadata-only while carrying the planned harness. */
/**
 * The task_list default row: the operational minimum that answers "what
 * exists and in what state" without a single uuid. Everything else — ids,
 * refs, delivery flags, the planned harness — rides behind `include`; see
 * `ListIncludeSchema`. `include: ["all"]` reproduces every field below.
 */
export const TaskListItemSchema = TaskReadSchema.pick({
  short_id: true,
  title: true,
  type: true,
  status: true,
  priority: true,
}).extend({
  /** Attention flag: present only when true, never `false`. */
  delivery_unverified: z.boolean().optional(),
  cost_usd: z.number().optional(),
  // include: ["ids"]
  id: z.string().min(1).optional(),
  // include: ["refs"]
  project_id: z.string().min(1).optional(),
  mission_id: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  claimed_by: z.string().min(1).optional(),
  // include: ["delivery"]
  revisado: z.boolean().optional(),
  devolve_para: ReviewerSchema.optional(),
  commit: z.string().min(1).optional(),
  delivery_verification: DeliveryVerificationSchema.optional(),
  delivery_warning: z.string().min(1).optional(),
  reports_count: z.number().int().positive().optional(),
  // include: ["harness"]
  harness: HarnessSchema.optional(),
});

export const ExecutionAttemptSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  executor: z.object({
    token_id: z.string().min(1).optional(),
    cli: z.string().optional(),
    model: z.string().optional(),
    model_source: z.enum(["declared", "harness", "measured"]).optional(),
    effort: EffortSchema.optional(),
    agent: z.string().optional(),
    session_id: z.string().optional(),
  }),
  started_at: IsoDateTimeSchema,
  last_activity_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.nullable(),
  usage: UsageSchema.nullable(),
  usage_suspect: z.boolean(),
  usage_suspect_reason: z.string().nullable(),
  delivery_unverified: z.boolean(),
  delivery_verification: DeliveryVerificationSchema.nullable(),
  delivery_warning: z.string().nullable(),
  result: z.enum(["success", "failure", "abandoned"]).nullable(),
  /** Why an attempt failed or was abandoned; usage remains on the attempt. */
  result_note: z.string().nullable(),
  /** Null when the executor sent no session and its cli has no resume hint. */
  transcript: StoredTranscriptRefSchema.nullable().optional(),
});

/** Executor identity captured when an orchestration attempt starts. */
export const MissionAttemptExecutorSchema = z.object({
  cli: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  model_source: z.enum(["declared", "harness", "measured"]).optional(),
  effort: EffortSchema.optional(),
  agent: z.string().min(1).optional(),
  session_id: z.string().min(1),
});

/** Public snapshot of a mission-level orchestration attempt. */
export const MissionAttemptSchema = z.object({
  id: z.string().min(1),
  mission_id: z.string().min(1),
  project_id: z.string().min(1).nullable(),
  executor: MissionAttemptExecutorSchema,
  transcript: StoredTranscriptRefSchema.nullable(),
  status: MissionAttemptStatusSchema,
  started_at: IsoDateTimeSchema,
  last_activity_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.nullable(),
  usage: UsageSchema.nullable(),
  server_duration_ms: z.number().int().nonnegative().nullable(),
  last_report_sequence: z.number().int().nonnegative(),
  usage_suspect: z.boolean(),
  usage_suspect_reason: z.string().nullable(),
  cost_usd: z.number().nullable(),
  cost_source: z.enum(["computed", "reported", "estimated"]).nullable(),
  cost_status: z
    .enum([
      "computed",
      "reported",
      "estimated",
      "unpriced",
      "not_reported",
      "zero_usage",
      "suspect",
    ])
    .nullable(),
  cost_unpriced_models: z.array(z.string()),
  result: MissionAttemptResultSchema.nullable(),
  result_note: z.string().nullable(),
});

export const HandoffSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  attempt_id: z.string().min(1).optional(),
  summary: z.string().min(1),
  how_to_verify: z.string().min(1).nullable(),
  evidence: z.array(EvidenceSchema),
  artifacts: z.array(ArtifactSchema),
  branch: z.string().min(1).nullable(),
  pull_request_url: z.string().url().nullable(),
  commit: z.string().min(1).nullable(),
  delivery_unverified: z.boolean(),
  delivery_verification: DeliveryVerificationSchema.nullable(),
  delivery_warning: z.string().nullable(),
  usage: UsageSchema.nullable(),
  telemetry_incomplete: z.boolean(),
  created_at: IsoDateTimeSchema,
});

export type CardStatus = z.infer<typeof CardStatusSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type DeliveryVerification = z.infer<typeof DeliveryVerificationSchema>;
export type ConfirmationStep = z.infer<typeof ConfirmationStepSchema>;
export type Origem = z.infer<typeof OrigemSchema>;
export type Reviewer = z.infer<typeof ReviewerSchema>;
export type Harness = z.infer<typeof HarnessSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type UsageSegment = z.infer<typeof UsageSegmentSchema>;
export type TranscriptRefWire = z.infer<typeof TranscriptRefSchema>;
export type StoredTranscriptRefWire = z.infer<typeof StoredTranscriptRefSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type SubtaskCreate = z.infer<typeof SubtaskCreateSchema>;
export type Mission = z.infer<typeof MissionSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type OrganizationDetail = z.infer<typeof OrganizationDetailSchema>;
export type OrganizationCounts = z.infer<typeof OrganizationCountsSchema>;
export type ReadView = z.infer<typeof ReadViewSchema>;
export type ReadInclude = z.infer<typeof ReadIncludeSchema>;
export type ReadOptions = z.infer<typeof ReadOptionsSchema>;
export type ListInclude = z.infer<typeof ListIncludeSchema>;
export type ListOptions = z.infer<typeof ListOptionsSchema>;
export type WriteReturn = z.infer<typeof WriteReturnSchema>;
export type WriteAck = z.infer<typeof WriteAckSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;
export type ProjectCardCounts = z.infer<typeof ProjectCardCountsSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskComment = z.infer<typeof TaskCommentSchema>;
export type TaskRead = z.infer<typeof TaskReadSchema>;
export type TaskListItem = z.infer<typeof TaskListItemSchema>;
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;
export type MissionAttemptExecutor = z.infer<typeof MissionAttemptExecutorSchema>;
export type MissionAttempt = z.infer<typeof MissionAttemptSchema>;
export type Handoff = z.infer<typeof HandoffSchema>;
export type BranchConvention = z.infer<typeof BranchConventionSchema>;

/**
 * Structural on purpose: the stored usage block allows a segment with no model
 * (an attempt whose executor never named one), which the wire schema does not.
 * Both shapes answer the same question about what is missing.
 */
export type TelemetryUsage = {
  segments?: readonly unknown[];
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  duration_ms?: number;
  turns?: number;
};

/**
 * What the delivery still owes, field by field.
 *
 * `telemetry_incomplete: true` on its own tells an agent that something is
 * missing without saying what, which is a flag it can only answer by guessing.
 * Naming the fields turns it into a fix: send turns, send duration_ms, run the
 * recipe again.
 */
export function telemetryGaps(usage?: TelemetryUsage | null): string[] {
  if (!usage) return ["usage"];
  const hasSegments = (usage.segments?.length ?? 0) > 0;
  const gaps: string[] = [];
  if (!hasSegments) {
    if (usage.tokens_in === undefined) gaps.push("tokens_in");
    if (usage.tokens_out === undefined) gaps.push("tokens_out");
  }
  if (usage.duration_ms === undefined) gaps.push("duration_ms");
  if (usage.turns === undefined) gaps.push("turns");
  return gaps;
}

/** One line saying what is missing, or null when nothing is. */
export function telemetryIncompleteReason(
  usage?: TelemetryUsage | null,
): string | null {
  const gaps = telemetryGaps(usage);
  if (gaps.length === 0) return null;
  return gaps[0] === "usage"
    ? "no usage was sent — send it with task_update, measured or estimated"
    : `usage is missing ${gaps.join(", ")} — send them with task_update`;
}

export function isTelemetryIncomplete(usage?: TelemetryUsage | null): boolean {
  if (!usage) {
    return true;
  }
  // Segments carry the same tokens the flat counters used to: a run that
  // reported per-model numbers reported its tokens. `cost_usd` is not part of
  // the bar: money is an opt-in layer the board computes itself, so a delivery
  // that reports tokens, time and turns is complete without naming a price.
  const hasSegments = (usage.segments?.length ?? 0) > 0;
  return (
    (usage.tokens_in === undefined && !hasSegments) ||
    (usage.tokens_out === undefined && !hasSegments) ||
    usage.duration_ms === undefined ||
    usage.turns === undefined
  );
}

export function branchConvention(
  shortId: string,
  title: string,
): BranchConvention {
  const slug = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return {
    branch: `${shortId.toLowerCase()}-${slug}`,
    commit_prefix: `[${shortId.toUpperCase()}]`,
  };
}
