import { z } from "zod";

export const CardStatusSchema = z.enum([
  "aberto",
  "em_execucao",
  "feito",
  "validado",
]);

export const TaskTypeSchema = z.enum(["feature", "bug", "rfc"]);

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

export const EffortSchema = z.enum(["low", "medium", "high"]);

export const ModelTierSchema = z.enum(["top", "mid", "cheap"]);

export const ExecutionModeSchema = z.enum(["solo", "team"]);

export const MissionStatusSchema = z.enum(["ativa", "pausada", "concluida"]);

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

export const MissionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: MissionStatusSchema,
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
});

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Card prefix: `AGB` gives `AGB-1`, `AGB-2`. Unique per workspace. */
  id_prefix: z.string().min(1),
  repo_url: z.string().nullable(),
  /** Number the next card in this project will get. */
  next_number: z.number().int().positive(),
  cards: ProjectCardCountsSchema,
  created_at: IsoDateTimeSchema,
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
  /**
   * Only comments with kind `report` are counted.
   * 0 by default in list payloads and detailed counts in get/update.
   */
  reports_count: z.number().int().nonnegative().default(0),
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

export const ExecutionAttemptSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  executor: z.object({
    token_id: z.string().min(1).optional(),
    cli: z.string().optional(),
    model: z.string().optional(),
    model_source: z.enum(["declared", "harness", "measured"]).optional(),
    agent: z.string().optional(),
    session_id: z.string().optional(),
  }),
  started_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.nullable(),
  usage: UsageSchema.nullable(),
  usage_suspect: z.boolean(),
  usage_suspect_reason: z.string().nullable(),
  result: z.enum(["success", "failure", "abandoned"]).nullable(),
  /** Null when the executor sent no session and its cli has no resume hint. */
  transcript: StoredTranscriptRefSchema.nullable().optional(),
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
  usage: UsageSchema.nullable(),
  telemetry_incomplete: z.boolean(),
  created_at: IsoDateTimeSchema,
});

export type CardStatus = z.infer<typeof CardStatusSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
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
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectCardCounts = z.infer<typeof ProjectCardCountsSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;
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
