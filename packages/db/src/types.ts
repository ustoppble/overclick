import type { UsageSegment } from "./domain/usage";

export type Effort = "low" | "medium" | "high";

/** Where the model identity on an execution attempt came from. */
export type AttemptModelSource = "declared" | "harness" | "measured";

export type Harness = {
  cli?: string | null;
  model: string | null;
  effort: Effort | null;
  modelTier?: "cheap" | "mid" | "top";
};

export type CardapioPolicyEntry = {
  type: string;
  cli: string | null;
  model: string | null;
  /** Line of succession for this activity, best first, `model` as its head. */
  chain?: string[] | null;
  effort: Effort;
};

export type ExecutorConfig = {
  id: string;
  label: string;
  enabled: boolean;
  models: string[];
  /**
   * Editable model list for this CLI. The built-in catalog is only the initial
   * suggestion; users add and remove models as free text. Absent on configs
   * saved before this field existed.
   */
  catalog?: string[];
};

export type Cardapio = {
  feature: Harness;
  bug: Harness;
  rfc: Harness;
};

export type TaskOrigin = {
  paneId?: string;
  sessionId?: string;
  agent?: string;
  cli?: string;
};

export type HandoffEvidence = {
  kind: "text" | "link";
  value: string;
};

export type HandoffArtifact = {
  name: string;
  mime?: string;
  content: string;
};

/**
 * Snapshot of the MCP usage contract as stored on the handoff jsonb. The MCP
 * layer is the only writer and it writes snake_case; estimated marks numbers
 * the executor guessed instead of measured.
 */
export type UsageReport = {
  tokens_in?: number;
  tokens_out?: number;
  tokens_cache?: number;
  cost_usd?: number;
  duration_ms?: number;
  turns?: number;
  estimated?: boolean;
  /**
   * One entry per model that ran, so a conversation that switched model is
   * recorded truthfully. The flat counters above stay filled with what the
   * segments add up to, for every reader written before segments existed.
   */
  segments?: UsageSegment[];
};

/**
 * A cli/model pair observed on a real claim or deliver that is not part of the
 * workspace executor config. Settings offers it as a one-click suggestion.
 */
export type SeenExecutor = {
  cli: string;
  model: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
};

/** One ticked How-to-confirm step during human validation of a done card. */
export type ValidationTick = {
  index: number;
  byUserId: string;
  byEmail: string;
  at: string;
};

/**
 * What this instance is allowed to do about new releases.
 *
 * `off` is the default and the zero phone-home promise: no request leaves the
 * server. `check` is the opt-in that reads the latest release tag and tells the
 * owner, who decides. `auto` lets the instance apply the update by itself on
 * the same interval, under exactly the rules the manual path follows.
 */
export type UpdateMode = "off" | "check" | "auto";

/** What an automatic update did, kept so the panel can say what and when. */
export type AutoUpdateRecord = {
  /** When the attempt finished, ISO. */
  at: string;
  /** Release tag that triggered it, when a check named one. */
  version: string | null;
  outcome: "updated" | "current" | "refused" | "failed";
  /** Why it would not run, on a refusal. */
  reason: string | null;
  /** Commits it moved between, when it moved at all. */
  from: string | null;
  to: string | null;
  /**
   * Step ids with their result, small enough to keep on the row. The note is
   * what the step concluded on its own, which is how the panel says whether a
   * restart already happened or is still owed.
   */
  steps: { id: string; status: string; note?: string }[];
};

export type TaskType = "feature" | "bug" | "rfc";
export type TaskPriority = "urgente" | "alta" | "media" | "baixa";
export type ReviewerKind = "human" | "agent" | "workspace_queue";
export type ExecutionMode = "solo" | "team";
export type MissionStatus = "ativa" | "pausada" | "concluida";
