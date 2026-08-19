import { z } from "zod";
import {
  ArtifactSchema,
  BranchConventionSchema,
  CardapioTaskTypeSchema,
  CardStatusSchema,
  ConfirmationStepSchema,
  EffortSchema,
  EvidenceSchema,
  ExecutionAttemptSchema,
  ExecutionModeSchema,
  HandoffSchema,
  HarnessSchema,
  IsoDateTimeSchema,
  MissionSchema,
  MissionStatusSchema,
  MissionSummarySchema,
  OrigemSchema,
  PrioritySchema,
  ProjectDetailSchema,
  ProjectSchema,
  ReviewerSchema,
  StoredTranscriptRefSchema,
  SubtaskCreateSchema,
  TaskSchema,
  TaskSummarySchema,
  TaskTypeSchema,
  TranscriptRefSchema,
  UsageSchema,
} from "./common.js";

export const MissionListInputSchema = z.object({
  status: MissionStatusSchema.optional(),
}).strict();

export const MissionListOutputSchema = z.object({
  missions: z.array(MissionSummarySchema),
});

export const MissionGetInputSchema = z.object({
  mission_id: z.string().min(1),
}).strict();

export const MissionGetOutputSchema = z.object({
  mission: MissionSchema,
});

/**
 * Canonical mission_create input.
 * Workspace is resolved from the MCP bearer token — never sent in the body.
 * `objective` and `context` are markdown. Omit either and the other fills it.
 */
export const MissionCreateInputSchema = z.object({
  title: z.string().min(1).max(200),
  objective: z.string().optional(),
  context: z.string().optional(),
  status: MissionStatusSchema.optional(),
}).strict();

export const MissionCreateOutputSchema = z.object({
  mission: MissionSchema,
});

/**
 * Partial mission edits. Omitted fields stay untouched; markdown fields may
 * intentionally be cleared with an empty string. The title is trimmed before
 * validation so whitespace cannot become a mission name.
 */
export const MissionUpdateInputSchema = z.object({
  mission_id: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  objective: z.string().optional(),
  context: z.string().optional(),
  status: MissionStatusSchema.optional(),
}).strict();

export const MissionUpdateOutputSchema = z.object({
  mission: MissionSchema,
});

/**
 * Empty missions can be removed directly. A mission holding cards is refused
 * unless force explicitly asks to detach those cards first.
 */
export const MissionDeleteInputSchema = z.object({
  mission_id: z.string().min(1),
  force: z
    .boolean()
    .optional()
    .describe(
      "Deletes the mission even when it holds cards, detaching them first. Omitted or false, a mission with cards is refused with the count that blocks it.",
    ),
}).strict();

export const MissionDeleteOutputSchema = z.object({
  deleted: z.literal(true),
  mission_id: z.string().min(1),
  title: z.string().min(1),
  tasks_detached: z.number().int().min(0),
});

const ProjectRefSchema = z
  .string()
  .min(1)
  .describe(
    "Project uuid or its card prefix (e.g. AGB). Resolved in the token workspace; call project_list to see both.",
  );

export const ProjectListInputSchema = z.object({}).strict();

export const ProjectListOutputSchema = z.object({
  projects: z.array(ProjectSchema),
});

export const PROJECT_CONTEXT_MAX_CHARS = 32_000;

const ProjectContextSchema = z
  .string()
  .max(
    PROJECT_CONTEXT_MAX_CHARS,
    `Project context cannot exceed ${PROJECT_CONTEXT_MAX_CHARS} characters.`,
  );

const ProjectVersionSchema = z.string().max(200);

export const ProjectGetInputSchema = z.object({
  project_id: ProjectRefSchema,
}).strict();

export const ProjectGetOutputSchema = z.object({
  project: ProjectDetailSchema,
});

/**
 * Canonical project_create input.
 * Workspace is resolved from the MCP bearer token — never sent in the body.
 * `id_prefix` is derived from the name when omitted (`Agent Board` → `AGB`
 * style initials) and is unique per workspace.
 */
export const ProjectCreateInputSchema = z.object({
  name: z.string().min(1).max(200),
  repo_url: z.string().url().optional(),
  context: ProjectContextSchema.optional(),
  current_version: ProjectVersionSchema.optional(),
  id_prefix: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Card prefix, 2 to 4 letters or digits (e.g. AGB). Derived from the name when omitted.",
    ),
}).strict();

export const ProjectCreateOutputSchema = z.object({
  project: ProjectDetailSchema,
});

/**
 * Canonical project_update input: renames and reconfigures a project in place.
 * Send at least one mutable field. `repo_url`, `context` and
 * `current_version` accept null to clear them.
 *
 * `id_prefix` is only editable while the project has no cards. Every card
 * already carries the prefix in its short id (`FUN-1`), so changing it later
 * would leave the board pointing at ids that never existed. Reorganizing a
 * project that already holds cards is done by moving the cards to another
 * project (`task_update` with `project_id`), which restamps each short id and
 * returns the old-to-new mapping.
 */
export const ProjectUpdateInputSchema = z
  .object({
    project_id: ProjectRefSchema,
    name: z.string().min(1).max(200).optional(),
    repo_url: z.string().url().nullable().optional(),
    context: ProjectContextSchema.nullable().optional(),
    current_version: ProjectVersionSchema.nullable().optional(),
    id_prefix: z
      .string()
      .min(1)
      .optional()
      .describe(
        "New card prefix, 2 to 4 letters or digits. Only accepted while the project has no cards.",
      ),
  }).strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.repo_url !== undefined ||
      value.context !== undefined ||
      value.current_version !== undefined ||
      value.id_prefix !== undefined,
    {
      message:
        "provide name, repo_url, context, current_version or id_prefix",
    },
  );

export const ProjectUpdateOutputSchema = z.object({
  project: ProjectDetailSchema,
});

/**
 * Canonical project_delete input.
 * Hard delete: the project row is removed and the database cascades over its
 * cards, and with them their attempts, handoffs, comments and subtasks. There
 * is no archive flag and no undo, which is why a project holding cards is
 * refused unless `force: true` says the cascade is the intent.
 */
export const ProjectDeleteInputSchema = z.object({
  project_id: ProjectRefSchema,
  force: z
    .boolean()
    .optional()
    .describe(
      "Deletes the project even when it holds cards, destroying every card in it. Omitted or false, a project with cards is refused with the count that blocks it.",
    ),
}).strict();

export const ProjectDeleteOutputSchema = z.object({
  deleted: z.literal(true),
  project_id: z.string().min(1),
  id_prefix: z.string().min(1),
  name: z.string().min(1),
  /** Cards destroyed with the project, subtasks included. Zero unless force. */
  tasks_deleted: z.number().int().min(0),
  attempts_deleted: z.number().int().min(0),
  handoffs_deleted: z.number().int().min(0),
});

export const TaskListInputSchema = z.object({
  project_id: ProjectRefSchema.optional(),
  mission_id: z.string().min(1).optional(),
  status: z.union([CardStatusSchema, z.array(CardStatusSchema)]).optional(),
  priority: PrioritySchema.optional(),
  type: TaskTypeSchema.optional(),
  awaiting_review_by: z.union([z.literal("me"), z.string().min(1)]).optional(),
}).strict();

export const TaskListOutputSchema = z.object({
  tasks: z.array(TaskSummarySchema),
});

const TaskIdSchema = z
  .string()
  .min(1)
  .describe(
    "Task uuid or workspace short id (e.g. AGB-5, OVK-5.4). Resolved in the token workspace.",
  );

export const TaskGetInputSchema = z.object({
  task_id: TaskIdSchema,
}).strict();

/**
 * The board's recipe for measuring a run on this CLI. It rides in the briefing
 * so the agent never has to guess how to count itself, and it also comes back
 * structured for callers that want to run it without parsing markdown.
 */
export const UsageRecipeSchema = z.object({
  /** Executor catalog id, or "generic" for the fallback. */
  cli: z.string().min(1),
  label: z.string().min(1),
  /** What the recipe can honestly produce. */
  yields: z.enum(["tokens_per_model", "no_tokens"]),
  instructions: z.string().min(1),
  /** Empty when this CLI has no command that measures anything. */
  command: z.string(),
});

export const TaskGetOutputSchema = z.object({
  task: TaskSchema,
  briefing_markdown: z.string(),
  mission: MissionSchema.nullable(),
  branch_convention: BranchConventionSchema,
  usage_recipe: UsageRecipeSchema.nullable().optional(),
  /** Latest attempt reported usage outside the trustworthy claim window. */
  usage_suspect: z.boolean(),
  usage_suspect_reason: z.string().nullable(),
  /** Frozen board-owned cost, distinct from the executor's reported figure. */
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
  /** Discarded run whose abandoned attempt still needs usage telemetry. */
  usage_warning: z.string().optional(),
});

/**
 * Canonical task_search input. Free-text lookup over the cards of the token's
 * workspace: title, o_que, por_que and comment bodies. Made for the question
 * "is there already a card about this?" before task_create.
 */
export const TaskSearchInputSchema = z.object({
  q: z.string().min(1).max(500),
  project_id: ProjectRefSchema.optional(),
  type: TaskTypeSchema.optional(),
  status: z.union([CardStatusSchema, z.array(CardStatusSchema)]).optional(),
  /** Hits to return, best match first. Default 5, at most 20. */
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

/** One search hit: enough to decide "same thing or not" without a task_get. */
export const TaskSearchHitSchema = z.object({
  id: z.string().min(1),
  short_id: z.string().min(1),
  title: z.string().min(1),
  type: TaskTypeSchema,
  status: CardStatusSchema,
  resolved_in: z.string().nullable(),
  /** The card's "what", cut at 300 characters. */
  o_que: z.string(),
  comments_count: z.number().int().nonnegative(),
  reports_count: z.number().int().nonnegative(),
  updated_at: IsoDateTimeSchema,
});

export const TaskSearchOutputSchema = z.object({
  tasks: z.array(TaskSearchHitSchema),
});

/**
 * Canonical task_create input (§4.1).
 * Workspace is resolved from the MCP bearer token — never sent in the body.
 * `mission` is the id of an existing mission (from mission_create / mission_list).
 * Missing id → NOT_FOUND. Omitted → card is born loose.
 * `project_id` takes the project uuid or its card prefix (from project_list /
 * project_create).
 */
export const TaskCreateInputSchema = z
  .object({
    mission: z.string().min(1).optional(),
    project_id: ProjectRefSchema,
    title: z.string().min(1).max(200),
    type: TaskTypeSchema,
    o_que: z.string().min(1).optional(),
    por_que: z.string().min(1).optional(),
    como_confirmo: z.array(ConfirmationStepSchema).min(1).optional(),
    /** Existing in-execution card replaced atomically by this one. */
    supersedes: TaskIdSchema.optional(),
    /** Reuse the superseded card contract fields omitted by this request. */
    inherit: z.boolean().optional(),
    priority: PrioritySchema.optional(),
    parent: z.string().min(1).optional(),
    mode: ExecutionModeSchema.default("solo"),
    subtasks: z.array(SubtaskCreateSchema).optional(),
    devolve_para: ReviewerSchema.optional(),
    harness: HarnessSchema.optional(),
    origem: OrigemSchema,
  }).strict()
  .superRefine((value, ctx) => {
    if (value.inherit && !value.supersedes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inherit"],
        message: "inherit requires supersedes",
      });
    }
    for (const key of ["o_que", "por_que", "como_confirmo"] as const) {
      if (value[key] === undefined && !value.inherit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required unless inherit: true reuses it from supersedes`,
        });
      }
    }
    if (value.mode === "team" && (!value.subtasks || value.subtasks.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subtasks"],
        message: "mode team exige subtasks com escopo e fronteira próprios",
      });
    }
    if (value.mode === "solo" && value.subtasks && value.subtasks.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subtasks"],
        message: "mode solo cria 1 card — não envie subtasks",
      });
    }
  });

export const TaskCreateOutputSchema = z.object({
  task: TaskSchema,
  subtasks: z.array(TaskSchema),
});

export const TaskClaimInputSchema = z.object({
  task_id: TaskIdSchema,
  force: z.boolean().optional(),
  executor: z
    .object({
      cli: z.string().optional(),
      model: z.string().optional(),
      agent: z.string().optional(),
      session_id: z.string().optional(),
    })
    .optional(),
  /**
   * Pointer to this run's transcript. Omit it and the board still builds one
   * from the executor's cli and session_id; send the path at deliver time,
   * when the usage recipe has printed it.
   */
  transcript: TranscriptRefSchema.optional(),
}).strict();

export const HarnessDivergenceSchema = z.object({
  recommended: HarnessSchema,
  actual: HarnessSchema.partial(),
  warning: z.string().min(1),
});

export const TaskClaimOutputSchema = z.object({
  task: TaskSchema,
  attempt: ExecutionAttemptSchema,
  briefing_markdown: z.string(),
  branch_convention: BranchConventionSchema,
  harness_divergence: HarnessDivergenceSchema.optional(),
  /** Recipe for the CLI that claimed, already appended to the briefing. */
  usage_recipe: UsageRecipeSchema.nullable().optional(),
  /** True when this claim replaced an expired lease rather than an open card. */
  reclaimed_stale: z.boolean().optional(),
});

/** Releases an open claim without losing its attempt telemetry. */
export const TaskReleaseInputSchema = z.object({
  task_id: TaskIdSchema,
  reason: z.string().trim().min(1).max(1_000),
}).strict();

export const TaskReleaseOutputSchema = z.object({
  task: TaskSchema,
  attempt: ExecutionAttemptSchema,
});

/** Extends the lease of a long-running executor without adding timeline prose. */
export const TaskHeartbeatInputSchema = z.object({
  task_id: TaskIdSchema,
}).strict();

export const TaskHeartbeatOutputSchema = z.object({
  task_id: z.string().min(1),
  last_activity_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
});

export const TaskUpdateInputSchema = z
  .object({
    task_id: TaskIdSchema,
    comment: z.string().min(1).optional(),
    comment_kind: z
      .enum(["comment", "report"])
      .describe(
        "Timeline kind for this comment. Omit or use `comment` for prose updates.",
      )
      .optional(),
    progress: z.string().min(1).optional(),
    revisado: z.boolean().optional(),
    /**
     * Moves the card between missions after it was created: the id of a
     * mission of the same workspace, or null to detach it. Omitted leaves the
     * card where it is. An id from another workspace is a NOT_FOUND, never a
     * silent no-op.
     */
    mission_id: z.string().min(1).nullable().optional(),
    /**
     * Moves the card to another project of the same workspace. The card is
     * restamped with the destination prefix (`FUN-1` landing in `MKT` becomes
     * `MKT-7`), the id it had is kept in `previous_short_ids`, and the
     * response returns the old-to-new mapping in `project_move` so external
     * references can be fixed. Subtasks travel with their parent; a subtask
     * cannot be moved on its own. `mission_id` is untouched: missions are
     * workspace wide and cross projects by design.
     */
    project_id: ProjectRefSchema.optional(),
    /** Reclassifies the card. Validated against the configured executors. */
    harness: HarnessSchema.optional(),
    /**
     * Reports or corrects usage after the fact: fills or overwrites the
     * latest attempt's usage, even on a delivered card. Real numbers found
     * later belong here, never in a comment.
    */
    usage: UsageSchema.optional(),
    /**
     * Boot-failure trace: the planned executor never started (CLI missing,
     * crash on boot). An orchestrator posts what happened and the card
     * timeline records it as a typed spawn failure entry.
     */
    spawn_failure: z.string().min(1).optional(),
    /**
     * Version, tag or release the card was resolved in. Fills or corrects
     * what the delivery said (a fix that only shipped in a later release);
     * null clears it. Empty string is refused: send null to clear.
     */
    resolved_in: z.string().min(1).nullable().optional(),
    /** Discard an in-execution card, optionally linking its existing continuation. */
    status: z.literal("descartado").optional(),
    superseded_by: TaskIdSchema.optional(),
  }).strict()
  .refine(
    (value) =>
      value.comment !== undefined ||
      value.progress !== undefined ||
      value.revisado !== undefined ||
      value.mission_id !== undefined ||
      value.project_id !== undefined ||
      value.harness !== undefined ||
      value.usage !== undefined ||
      value.spawn_failure !== undefined ||
      value.resolved_in !== undefined ||
      value.status !== undefined ||
      value.superseded_by !== undefined,
    {
      message:
        "provide comment, progress, revisado, mission_id, project_id, harness, usage, spawn_failure, resolved_in, or status descartado",
    },
  )
  .refine(
    (value) => value.comment !== undefined || value.comment_kind === undefined,
    { message: "comment_kind requires comment", path: ["comment_kind"] },
  )
  .refine(
    (value) => value.status !== undefined || value.superseded_by === undefined,
    { message: "superseded_by requires status: descartado", path: ["superseded_by"] },
  );

/** One card's short id before and after a move between projects. */
export const ShortIdChangeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

/**
 * What a move between projects did, returned so the caller can fix branches,
 * commits and PR titles that name the old ids. The parent comes first, its
 * subtasks after, in the order they were restamped.
 */
export const ProjectMoveSchema = z.object({
  from_project_id: z.string().min(1),
  from_prefix: z.string().min(1),
  to_project_id: z.string().min(1),
  to_prefix: z.string().min(1),
  short_ids: z.array(ShortIdChangeSchema),
});

export const TaskUpdateOutputSchema = z.object({
  task: TaskSchema,
  /** Present when a usage block was applied to the latest attempt. */
  usage_recorded: z.boolean().optional(),
  usage_suspect: z.boolean(),
  usage_suspect_reason: z.string().nullable(),
  /**
   * Subtasks that followed the parent card into the mission, or into the
   * destination project. Present only on a move, so the caller sees the whole
   * effect.
   */
  subtasks_moved: z.number().int().nonnegative().optional(),
  /**
   * Present when the card changed project. Absent when `project_id` named the
   * project the card is already in, because nothing was restamped.
   */
  project_move: ProjectMoveSchema.optional(),
});

export const TaskDeliverInputSchema = z.object({
  task_id: TaskIdSchema,
  summary: z.string().min(1),
  /**
   * Lay validation entry point: a URL, command or screenshot reference the
   * reviewer opens first ("For checking, open..."). Shown on top of the
   * validation panel in the board's Done detail.
   */
  how_to_verify: z.string().min(1).optional(),
  evidence: z.array(EvidenceSchema).default([]),
  artifacts: z.array(ArtifactSchema).default([]),
  branch: z.string().min(1).optional(),
  pull_request_url: z.string().url().optional(),
  /**
   * Version, tag or release this delivery lands in, when the agent knows it
   * ("1.4.0"). Stored on the card as resolved_in; task_update can fill or
   * correct it later.
   */
  resolved_in: z.string().min(1).optional(),
  /**
   * Required by contract: report exact numbers when the harness exposes
   * them, otherwise ESTIMATE tokens, turns and cost and set estimated: true.
   * The schema still accepts a missing block so a delivery is never lost,
   * but the response then carries usage_warning and the card shows
   * "usage not reported". Duration is measured server-side regardless.
   */
  usage: UsageSchema.optional(),
  /**
   * Where this run's transcript ended up. Send `path` here: the card then
   * links back to the session that did the work, and whoever reviews it can
   * reopen it or recompute the usage on the machine that ran it. Fields you
   * omit keep whatever the claim recorded.
   */
  transcript: TranscriptRefSchema.optional(),
}).strict();

export const TaskDeliverOutputSchema = z.object({
  task: TaskSchema,
  handoff: HandoffSchema,
  telemetry_incomplete: z.boolean(),
  usage_suspect: z.boolean(),
  usage_suspect_reason: z.string().nullable(),
  /** Actionable warning returned when the delivery came without usage. */
  usage_warning: z.string().optional(),
  /** The reference the card now shows, claim and delivery merged. */
  transcript: StoredTranscriptRefSchema.nullable().optional(),
  routed_to: ReviewerSchema,
});

/**
 * task_delete is a hard delete by owner decision: the card row is removed and the
 * database cascades over execution_attempts, handoffs, comments and subtasks.
 * There is no archive flag and no undo.
 */
export const TaskDeleteInputSchema = z.object({
  task_id: TaskIdSchema,
}).strict();

export const TaskDeleteOutputSchema = z.object({
  deleted: z.literal(true),
  task_id: z.string().min(1),
  short_id: z.string().min(1),
  attempts_deleted: z.number().int().min(0),
  handoffs_deleted: z.number().int().min(0),
});

export const BranchRegisterInputSchema = z.object({
  task_id: TaskIdSchema,
  branch: z.string().min(1),
}).strict();

export const BranchRegisterOutputSchema = z.object({
  task: TaskSchema,
});

export const HarnessRecommendInputSchema = z.object({
  type: CardapioTaskTypeSchema,
}).strict();

export const HarnessRecommendOutputSchema = z.object({
  harness: z.object({
    cli: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    effort: EffortSchema,
  }),
  model_tier: z.enum(["top", "mid", "cheap"]),
  available: z.boolean(),
  source: z.enum(["cardapio", "explicit"]),
  matched_executor: z
    .object({
      id: z.string(),
      cli: z.string(),
      model: z.string(),
    })
    .nullable(),
  /** The declared line of succession for this activity, best first. */
  chain: z.array(z.string().min(1)).optional(),
  /** Where in that line the answer came from: 0 is the first choice. */
  chain_position: z.number().int().min(0).optional(),
  divergence: z.string().optional(),
});

export const CardapioPolicyEntrySchema = z.object({
  type: z.string().min(1),
  cli: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  /**
   * The line of succession for this activity, best first, `model` included as
   * its head. The board claims the first entry the workspace can actually run,
   * so switching an executor off degrades the policy instead of voiding it.
   */
  chain: z.array(z.string().min(1)).max(8).optional(),
  effort: EffortSchema,
  /**
   * Who wrote this line last and when: an email when it came from Settings,
   * the token label when it came from harness_set. Null on a factory default
   * nobody has touched yet.
   */
  updated_by: z.string().min(1).nullable().optional(),
  updated_at: IsoDateTimeSchema.nullable().optional(),
});

/**
 * Writes one policy line. Guarded by the token's manage flag: a worker token
 * gets PERMISSION_DENIED instead of promoting itself to a better model.
 * `cli` null or omitted means no preference; the model still has to exist on
 * one of the workspace's enabled executors.
 */
export const HarnessSetInputSchema = z
  .object({
    type: CardapioTaskTypeSchema,
    cli: z.string().min(1).nullable().optional(),
    model: z.string().min(1).optional(),
    /**
     * The whole line of succession for this activity, best first. Send this
     * instead of `model` to declare a fallback: the board claims the first
     * entry it can run. `model` alone still works and reads as a chain of one.
     */
    chain: z.array(z.string().min(1)).min(1).max(8).optional(),
    effort: EffortSchema,
  }).strict()
  .refine((input) => Boolean(input.model) || Boolean(input.chain?.length), {
    message: "Send a model, a chain, or both.",
    path: ["model"],
  });

export const HarnessSetOutputSchema = z.object({
  policy: CardapioPolicyEntrySchema,
});

export const ConfiguredExecutorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean(),
  /** Checked models: what a card harness may actually ask for. */
  models: z.array(z.string()),
  /** Editable model list the board's selects offer for this CLI. */
  catalog: z.array(z.string()).optional(),
});

/**
 * One model's price, in US dollars per million tokens. `cache_per_mtok`
 * prices the `tokens_cache` counter of the usage contract. `seeded_at` is the
 * date the public price was captured, and is null on a row a human edited.
 */
export const ModelPriceSchema = z.object({
  model: z.string().min(1),
  label: z.string().min(1),
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  cache_per_mtok: z.number().nonnegative(),
  source: z.enum(["seed", "custom"]),
  seeded_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export const HarnessListInputSchema = z.object({}).strict();

export const HarnessListOutputSchema = z.object({
  policy: z.array(CardapioPolicyEntrySchema),
  executors: z.array(ConfiguredExecutorSchema),
  /**
   * The board's price table, so an orchestrator can reason about cost before
   * it picks a harness. A model that is absent has no price on this board and
   * its cost will only ever be what the agent reports.
   */
  prices: z.array(ModelPriceSchema),
});

/**
 * Adds or removes CLIs and models in the workspace executor config, in the
 * same shape the Settings grid saves. Guarded by the token's manage flag.
 * Adding models turns the CLI on unless `enabled: false` says otherwise: an
 * unchecked model is invisible to the policy selects and to card harnesses.
 * `remove: true` drops the whole CLI and cannot be combined with the others.
 */
export const ExecutorsUpdateInputSchema = z
  .object({
    cli: z
      .string()
      .min(1)
      .describe(
        "Executor id (claude-code, codex, ...) or the binary name an agent sends (claude, gemini). Resolved to the board's id.",
      ),
    label: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    add_models: z.array(z.string().min(1)).optional(),
    remove_models: z.array(z.string().min(1)).optional(),
    remove: z.boolean().optional(),
  }).strict()
  .superRefine((value, ctx) => {
    if (
      value.remove &&
      (value.enabled !== undefined ||
        value.add_models?.length ||
        value.remove_models?.length ||
        value.label)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remove"],
        message:
          "remove drops the whole executor; send it alone, without label, enabled, add_models or remove_models",
      });
    }
    if (
      !value.remove &&
      value.enabled === undefined &&
      !value.add_models?.length &&
      !value.remove_models?.length &&
      !value.label
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cli"],
        message:
          "provide at least one of label, enabled, add_models, remove_models or remove",
      });
    }
  });

export const ExecutorsUpdateOutputSchema = z.object({
  /** The whole config after the change, the shape Settings reads. */
  executors: z.array(ConfiguredExecutorSchema),
  /** Id the cli resolved to, which may differ from what was sent. */
  updated: z.string().min(1),
  removed: z.boolean(),
  /**
   * Policy lines left pointing at a cli/model this change took away. The write
   * still happened; this says what to fix with harness_set.
   */
  policy_warnings: z.array(z.string()).optional(),
});

/**
 * Usage totals over a set of finished attempts. Tokens and time are the
 * primary unit; the cost fields are filled only when the workspace turned the
 * money layer on. `estimated` and `missing` are counts of attempts, not money:
 * they say how much of the totals to trust. The board never silently folds a
 * guess or a blank into a number.
 */
export const UsageTotalsSchema = z.object({
  /**
   * Null when the workspace keeps the money layer off, which is the default:
   * tokens and time are facts on every plan, a dollar figure is not. Never a
   * zero standing in for "no cost to report".
   */
  cost_usd: z.number().nullable(),
  /** Attempts whose cost the board computed from the price table. */
  cost_computed: z.number().int().nonnegative(),
  /** Attempts that contributed the cost figure the agent sent. */
  cost_reported: z.number().int().nonnegative(),
  /** Same, where the agent flagged its own numbers as an estimate. */
  cost_estimated: z.number().int().nonnegative(),
  /** Attempts with tokens the board could not price: no row for the model. */
  cost_unpriced: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /**
   * Execution time: the sum of the durations the agents reported working. An
   * attempt that reported none adds nothing here, so a claim left open over a
   * weekend never reads as work.
   */
  duration_ms: z.number().int().nonnegative(),
  /**
   * Claim to deliver on the attempts that reported no execution time. A
   * different clock, counted apart and never folded into `duration_ms`.
   */
  elapsed_ms: z.number().int().nonnegative(),
  /** How many attempts contributed to `elapsed_ms` instead of `duration_ms`. */
  elapsed_only: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  /** Attempts whose executor flagged the numbers as an estimate. */
  estimated: z.number().int().nonnegative(),
  /** Attempts that finished reporting no usage at all. */
  missing: z.number().int().nonnegative(),
  /** Attempts that explicitly reported token counters summing to zero. */
  zero_usage: z.number().int().nonnegative(),
  /** Attempts excluded from trusted sums by the claim-window/session guard. */
  suspect: z.number().int().nonnegative(),
  /** Reported tokens on suspect attempts, counted apart from `tokens`. */
  suspect_tokens: z.number().int().nonnegative(),
  /** Reported execution time on suspect attempts, outside `duration_ms`. */
  suspect_duration_ms: z.number().int().nonnegative(),
  /** Suspect cost when it can be established; never folded into cost_usd. */
  suspect_cost_usd: z.number().nullable(),
});

export const InsightGroupSchema = UsageTotalsSchema.extend({
  key: z.string().min(1),
  /** null when the dimension is absent: card without mission, model not reported. */
  label: z.string().nullable(),
  /**
   * Only on group_by=model: attempts in this group that also ran another
   * model. Their tokens are split per segment, but the board has no way to
   * know how the wall clock split, so the whole duration lands in every model
   * the run touched. Non-zero means the durations across models overlap and do
   * not add up to the total.
   */
  shared_attempts: z.number().int().nonnegative().optional(),
});

export const InsightCardSchema = z.object({
  task_id: z.string().min(1),
  short_id: z.string().min(1),
  title: z.string(),
  project: z.string(),
  mission: z.string().nullable(),
  models: z.array(z.string()),
  model_origins: z.array(
    z.object({
      model: z.string().min(1),
      source: z.enum(["declared", "harness", "measured"]),
    }),
  ),
  /** null when no attempt on the card has a cost. Not the same as $0. */
  cost_usd: z.number().nullable(),
  /** Where that figure came from; "mixed" when the attempts disagree. */
  cost_source: z.enum(["computed", "reported", "estimated", "mixed"]).nullable(),
  /** Tokens whose model had no price when this attempt's cost was frozen. */
  unpriced_tokens: z.number().int().nonnegative(),
  /** Canonical model keys missing from that frozen price lookup. */
  unpriced_models: z.array(z.string()),
  tokens: z.number().int().nonnegative(),
  /** Execution time the agents reported on this card. */
  duration_ms: z.number().int().nonnegative(),
  /** Claim to deliver, on the attempts of this card that reported no time. */
  elapsed_ms: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  estimated: z.boolean(),
  missing: z.boolean(),
  zero_usage: z.boolean(),
  suspect: z.boolean(),
  suspect_tokens: z.number().int().nonnegative(),
  suspect_duration_ms: z.number().int().nonnegative(),
  suspect_cost_usd: z.number().nullable(),
});

export const ModelReopenSchema = z.object({
  model: z.string().nullable(),
  deliveries: z.number().int().nonnegative(),
  reopened: z.number().int().nonnegative(),
  /** reopened / deliveries, 0..1. */
  rate: z.number(),
});

/**
 * The aggregate questions the Insights page answers, over MCP. Same rows, same
 * aggregation: only finished attempts count, example cards stay out, and the
 * period narrows attempts by when they finished (reopens are not narrowed, so
 * a delivery reopened later still counts as reopened).
 */
export const InsightsQueryInputSchema = z.object({
  group_by: z
    .enum(["project", "mission", "model", "card"])
    .optional()
    .describe("Omit for totals and the reopen rate only."),
  since: z
    .string()
    .datetime()
    .optional()
    .describe("ISO timestamp; attempts that finished before it are excluded."),
  until: z
    .string()
    .datetime()
    .optional()
    .describe("ISO timestamp; attempts that finished after it are excluded."),
}).strict();

export const InsightsQueryOutputSchema = z.object({
  period: z.object({
    since: IsoDateTimeSchema.nullable(),
    until: IsoDateTimeSchema.nullable(),
  }),
  totals: UsageTotalsSchema,
  /** Abandoned cost kept visible but never mixed into successful work. */
  discarded: z.object({
    totals: UsageTotalsSchema,
    by_executor: z.array(InsightGroupSchema),
    by_mission: z.array(InsightGroupSchema),
    by_model: z.array(InsightGroupSchema),
  }),
  /**
   * False by default: this workspace reports tokens and time only, and every
   * cost field comes back null. Turn the money layer on in Settings and the
   * board fills them with approximate figures from its price table.
   */
  pricing_enabled: z.boolean(),
  /** Plain-language honesty note, the same one the Insights page prints. */
  note: z.string().min(1),
  /** Where the dollars came from: "3 computed · 1 agent reported". */
  cost_note: z.string().min(1),
  /** Present when group_by is project, mission or model. Cost descending. */
  groups: z.array(InsightGroupSchema).optional(),
  /** Present when group_by is card. */
  cards: z.array(InsightCardSchema).optional(),
  /** Reopened rate per model, highest first. */
  reopened_by_model: z.array(ModelReopenSchema),
});

export const MCP_TOOL_NAMES = [
  "project_list",
  "project_get",
  "project_create",
  "project_update",
  "project_delete",
  "mission_list",
  "mission_get",
  "mission_create",
  "mission_update",
  "mission_delete",
  "task_list",
  "task_get",
  "task_search",
  "task_create",
  "task_claim",
  "task_release",
  "task_heartbeat",
  "task_update",
  "task_deliver",
  "task_delete",
  "branch_register",
  "harness_recommend",
  "harness_list",
  "harness_set",
  "executors_update",
  "insights_query",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const toolContracts = {
  project_list: {
    input: ProjectListInputSchema,
    output: ProjectListOutputSchema,
  },
  project_get: {
    input: ProjectGetInputSchema,
    output: ProjectGetOutputSchema,
  },
  project_create: {
    input: ProjectCreateInputSchema,
    output: ProjectCreateOutputSchema,
  },
  project_update: {
    input: ProjectUpdateInputSchema,
    output: ProjectUpdateOutputSchema,
  },
  project_delete: {
    input: ProjectDeleteInputSchema,
    output: ProjectDeleteOutputSchema,
  },
  mission_list: {
    input: MissionListInputSchema,
    output: MissionListOutputSchema,
  },
  mission_get: {
    input: MissionGetInputSchema,
    output: MissionGetOutputSchema,
  },
  mission_create: {
    input: MissionCreateInputSchema,
    output: MissionCreateOutputSchema,
  },
  mission_update: {
    input: MissionUpdateInputSchema,
    output: MissionUpdateOutputSchema,
  },
  mission_delete: {
    input: MissionDeleteInputSchema,
    output: MissionDeleteOutputSchema,
  },
  task_list: {
    input: TaskListInputSchema,
    output: TaskListOutputSchema,
  },
  task_get: {
    input: TaskGetInputSchema,
    output: TaskGetOutputSchema,
  },
  task_search: {
    input: TaskSearchInputSchema,
    output: TaskSearchOutputSchema,
  },
  task_create: {
    input: TaskCreateInputSchema,
    output: TaskCreateOutputSchema,
  },
  task_claim: {
    input: TaskClaimInputSchema,
    output: TaskClaimOutputSchema,
  },
  task_release: {
    input: TaskReleaseInputSchema,
    output: TaskReleaseOutputSchema,
  },
  task_heartbeat: {
    input: TaskHeartbeatInputSchema,
    output: TaskHeartbeatOutputSchema,
  },
  task_update: {
    input: TaskUpdateInputSchema,
    output: TaskUpdateOutputSchema,
  },
  task_deliver: {
    input: TaskDeliverInputSchema,
    output: TaskDeliverOutputSchema,
  },
  task_delete: {
    input: TaskDeleteInputSchema,
    output: TaskDeleteOutputSchema,
  },
  branch_register: {
    input: BranchRegisterInputSchema,
    output: BranchRegisterOutputSchema,
  },
  harness_recommend: {
    input: HarnessRecommendInputSchema,
    output: HarnessRecommendOutputSchema,
  },
  harness_list: {
    input: HarnessListInputSchema,
    output: HarnessListOutputSchema,
  },
  harness_set: {
    input: HarnessSetInputSchema,
    output: HarnessSetOutputSchema,
  },
  executors_update: {
    input: ExecutorsUpdateInputSchema,
    output: ExecutorsUpdateOutputSchema,
  },
  insights_query: {
    input: InsightsQueryInputSchema,
    output: InsightsQueryOutputSchema,
  },
} as const;

export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;
export type TaskCreateOutput = z.infer<typeof TaskCreateOutputSchema>;
export type TaskClaimInput = z.infer<typeof TaskClaimInputSchema>;
export type TaskClaimOutput = z.infer<typeof TaskClaimOutputSchema>;
export type TaskReleaseInput = z.infer<typeof TaskReleaseInputSchema>;
export type TaskReleaseOutput = z.infer<typeof TaskReleaseOutputSchema>;
export type TaskHeartbeatInput = z.infer<typeof TaskHeartbeatInputSchema>;
export type TaskHeartbeatOutput = z.infer<typeof TaskHeartbeatOutputSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;
export type TaskDeliverInput = z.infer<typeof TaskDeliverInputSchema>;
export type TaskDeliverOutput = z.infer<typeof TaskDeliverOutputSchema>;
export type TaskDeleteInput = z.infer<typeof TaskDeleteInputSchema>;
export type TaskDeleteOutput = z.infer<typeof TaskDeleteOutputSchema>;
export type MissionListInput = z.infer<typeof MissionListInputSchema>;
export type MissionGetInput = z.infer<typeof MissionGetInputSchema>;
export type MissionCreateInput = z.infer<typeof MissionCreateInputSchema>;
export type MissionCreateOutput = z.infer<typeof MissionCreateOutputSchema>;
export type MissionUpdateInput = z.infer<typeof MissionUpdateInputSchema>;
export type MissionUpdateOutput = z.infer<typeof MissionUpdateOutputSchema>;
export type MissionDeleteInput = z.infer<typeof MissionDeleteInputSchema>;
export type MissionDeleteOutput = z.infer<typeof MissionDeleteOutputSchema>;
export type TaskListInput = z.infer<typeof TaskListInputSchema>;
export type TaskGetInput = z.infer<typeof TaskGetInputSchema>;
export type TaskSearchInput = z.infer<typeof TaskSearchInputSchema>;
export type TaskSearchOutput = z.infer<typeof TaskSearchOutputSchema>;
export type TaskSearchHit = z.infer<typeof TaskSearchHitSchema>;
export type BranchRegisterInput = z.infer<typeof BranchRegisterInputSchema>;
export type HarnessRecommendInput = z.infer<typeof HarnessRecommendInputSchema>;
export type HarnessListInput = z.infer<typeof HarnessListInputSchema>;
export type HarnessListOutput = z.infer<typeof HarnessListOutputSchema>;
export type CardapioPolicyEntryContract = z.infer<typeof CardapioPolicyEntrySchema>;
export type ConfiguredExecutorContract = z.infer<typeof ConfiguredExecutorSchema>;
export type ModelPriceContract = z.infer<typeof ModelPriceSchema>;
export type ExecutorsUpdateInput = z.infer<typeof ExecutorsUpdateInputSchema>;
export type ExecutorsUpdateOutput = z.infer<typeof ExecutorsUpdateOutputSchema>;
export type InsightsQueryInput = z.infer<typeof InsightsQueryInputSchema>;
export type InsightsQueryOutput = z.infer<typeof InsightsQueryOutputSchema>;
export type InsightGroupContract = z.infer<typeof InsightGroupSchema>;
export type InsightCardContract = z.infer<typeof InsightCardSchema>;
export type HarnessSetInput = z.infer<typeof HarnessSetInputSchema>;
export type HarnessSetOutput = z.infer<typeof HarnessSetOutputSchema>;
export type ProjectListInput = z.infer<typeof ProjectListInputSchema>;
export type ProjectListOutput = z.infer<typeof ProjectListOutputSchema>;
export type ProjectGetInput = z.infer<typeof ProjectGetInputSchema>;
export type ProjectGetOutput = z.infer<typeof ProjectGetOutputSchema>;
export type ProjectCreateInput = z.infer<typeof ProjectCreateInputSchema>;
export type ProjectCreateOutput = z.infer<typeof ProjectCreateOutputSchema>;
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInputSchema>;
export type ProjectUpdateOutput = z.infer<typeof ProjectUpdateOutputSchema>;
export type ProjectDeleteInput = z.infer<typeof ProjectDeleteInputSchema>;
export type ProjectDeleteOutput = z.infer<typeof ProjectDeleteOutputSchema>;
export type ProjectMove = z.infer<typeof ProjectMoveSchema>;
