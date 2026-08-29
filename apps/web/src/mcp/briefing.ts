import type { UsageRecipe } from "@agent-board/db";
import type {
  BranchConvention,
  Mission,
  Task,
  TaskComment,
} from "@agent-board/mcp-core";

/**
 * How this executor measures the run it just did, taken from the board's
 * recipe for its CLI. It goes at the very end of the briefing, right before
 * the delivery contract, because that is the moment the agent needs it.
 */
function renderRecipe(recipe: UsageRecipe): string[] {
  // No language on the fence on purpose: the shipped commands are one node
  // invocation that bash, zsh and PowerShell all run, and labelling the block
  // bash told a Windows agent it needed a shell it does not have.
  const block = recipe.command
    ? ["```", recipe.command, "```"]
    : ["(no command for this CLI yet)"];
  return [
    `## Measuring this run — ${recipe.label}`,
    "",
    recipe.instructions,
    "",
    ...block,
    "",
  ];
}

/**
 * Comment is a live part of the contract: the owner corrects o_que/por_que/
 * como_confirmo after creation by commenting, not by editing the card. A
 * claim that never surfaces those corrections delivers the original,
 * already-superseded contract. Empty on purpose when there are none — no
 * section beats an empty one.
 */
function renderComments(comments: readonly TaskComment[]): string[] {
  if (comments.length === 0) return [];
  return [
    "## Comentários do card",
    "",
    "Os comentários abaixo alteram/refinam o contrato acima (o_que/por_que/como_confirmo); em caso de conflito, o comentário mais recente vence.",
    "",
    ...comments.map(
      (c) =>
        `- **${c.author}** (${c.created_at})${c.kind === "report" ? " [report]" : ""}: ${c.body}`,
    ),
    "",
  ];
}

function renderMissionTelemetry(): string[] {
  return [
    "## Mission orchestration telemetry",
    "",
    "If you are orchestrating this mission, keep planning and dispatch usage in a separate `mission_attempt`; a card-only worker must not open one.",
    "",
    "1. At mission start, call `mission_attempt_start` with the mission, optional primary project, effective CLI/model/session, and transcript reference. Save the returned `attempt_id` and sequence `0`.",
    "2. After every dispatch round—even a round that creates no card—call `mission_report_usage` with `checkpoint: \"rodada\"` and a cumulative snapshot since the attempt started. Never send a delta; increase `sequence` for each new snapshot.",
    "3. At close, send the final cumulative snapshot with `checkpoint: \"final\"` and `result: \"success\"` or `\"abandoned\"`. A successful attempt needs that final checkpoint to enter trusted totals.",
    "4. Put one entry per model in `usage.segments`, plus `duration_ms`, `turns`, and `estimated`:",
    "",
    "```json",
    "{",
    '  "mission_id": "<mission>",',
    '  "attempt_id": "<attempt>",',
    '  "sequence": 2,',
    '  "checkpoint": "rodada",',
    '  "usage": {',
    '    "segments": [{"model": "gpt-5.6-sol", "input": 70000, "output": 8000, "cache_read": 15000, "cache_write": 0}],',
    '    "duration_ms": 370000,',
    '    "turns": 5,',
    '    "estimated": false',
    "  }",
    "}",
    "```",
    "",
    "Use the server's attempt start as the usage boundary; work from this session before that point is not part of the mission attempt. Repeating an identical sequence and payload is safe, but a new snapshot must advance the sequence.",
    "",
    "If exact counters are unavailable, never send zero to mean unknown: use an honest estimate with `estimated: true`, or leave usage unreported so the board can show `not reported`. `estimated` qualifies an approximation, `unpriced` means the model has no price, and `suspect` means the window/session check found an inconsistency; none is silently turned into `$0`.",
    "",
    "If the same session also executes a card, declare the sharing; OCL-11 marks overlapping usage `suspect` instead of counting it twice. Card delivery reports only card execution. A mission attempt has no branch, PR, reviewer, or `task_deliver` of its own.",
    "",
  ];
}

export function renderBriefingMarkdown(input: {
  task: Task;
  mission: Mission | null;
  /**
   * The business the card's project belongs to. It comes before the project
   * block: a worker reads the rules of the company before the rules of the
   * repo.
   */
  organization?: {
    name: string;
    context: string | null;
  } | null;
  project?: {
    name: string;
    idPrefix: string;
    context: string | null;
    currentVersion: string | null;
  } | null;
  branchConvention: BranchConvention;
  /** All prose comments and reports on the card, oldest first. */
  comments?: readonly TaskComment[] | null;
  /** Recipe for the CLI running the card; omitted when none could be resolved. */
  recipe?: UsageRecipe | null;
  /**
   * The card's line of succession and where this claim sits on it. The worker
   * gets the whole line, not just the name it is on, so a model that cannot
   * finish knows what to escalate to without asking the board again.
   */
  chain?: readonly string[] | null;
  /** Which try this is, zero-based: 1 means the first delivery was rejected. */
  attempt?: number;
  /** Server boundary for this attempt's transcript and usage counters. */
  claimedAt?: string | null;
  /** The previous executor stopped renewing its lease and was abandoned. */
  reclaimedStale?: boolean;
}): string {
  const {
    task,
    mission,
    organization,
    project,
    branchConvention,
    comments,
    recipe,
    chain,
    attempt,
    claimedAt,
    reclaimedStale,
  } = input;
  const steps = task.como_confirmo
    .map((step, index) => `${index + 1}. ${step.step} → ${step.expected}`)
    .join("\n");

  const line = chain && chain.length > 1 ? chain.join(" → ") : null;
  const harness = task.harness
    ? [
        task.harness.cli ? `- CLI: ${task.harness.cli}` : null,
        `- modelo: ${task.harness.model}`,
        `- effort: ${task.harness.effort}`,
        line ? `- cadeia: ${line}` : null,
        attempt && attempt > 0
          ? `- tentativa ${attempt + 1}: a entrega anterior foi reprovada, então o card subiu um elo da cadeia`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "- (sem harness recomendado — cardápio sem executor compatível)";

  const missionBlock = mission
    ? [
        `## Missão — ${mission.title}`,
        "",
        mission.objective,
        mission.context && mission.context !== mission.objective
          ? `\n${mission.context}`
          : "",
        "",
        ...renderMissionTelemetry(),
      ].join("\n")
    : "## Missão\n\n(card solto — sem missão atribuída)";

  const organizationBlock = organization
    ? [
        "## Organization context",
        "",
        `- organization: ${organization.name}`,
        "",
        organization.context ?? "(organization context not configured)",
      ].join("\n")
    : null;

  const projectBlock = project
    ? [
        "## Project context",
        "",
        `- project: ${project.name} (${project.idPrefix})`,
        `- current_version: ${project.currentVersion ?? "(not set)"}`,
        "",
        project.context ?? "(project context not configured)",
      ].join("\n")
    : "## Project context\n\n(project context unavailable)";

  const contextEditingBlock = [
    "## Shared context edits",
    "",
    "To change one section or list line in project or mission markdown, use `context_ops` (or `objective_ops` for a mission objective) with `project_update`/`mission_update`.",
    "Do not resend the whole blob for a one-line change: granular operations apply to the current server value and preserve concurrent edits. Send `context` or `objective` only for an intentional full rewrite; use `expected_len` or `expected_hash` when guarding a legacy blob rewrite.",
  ].join("\n");

  const reopen = task.reopen_comment
    ? `\n## Comentário da reabertura\n\n${task.reopen_comment}\n`
    : "";

  return [
    `# ${task.short_id} — ${task.title}`,
    "",
    `**Tipo:** ${task.type} · **Prioridade:** ${task.priority} · **Status:** ${task.status.replace("_", " ")}`,
    "",
    "## O quê",
    "",
    task.o_que,
    "",
    "## Por quê",
    "",
    task.por_que,
    "",
    "## Como confirmo",
    "",
    steps || "(sem roteiro)",
    "",
    ...renderComments(comments ?? []),
    "## Harness",
    "",
    harness,
    "",
    missionBlock,
    "",
    ...(organizationBlock ? [organizationBlock, ""] : []),
    projectBlock,
    "",
    contextEditingBlock,
    "",
    "## Convenção Git",
    "",
    `- branch: \`${branchConvention.branch}\``,
    `- commit/PR: \`${branchConvention.commit_prefix}\``,
    reopen,
    "",
    ...(reclaimedStale
      ? [
          "## Expired claim takeover",
          "",
          "The previous executor stopped reporting activity and its claim expired. This attempt reclaimed the card automatically. Say that explicitly in `task_deliver` so the reviewer can distinguish a takeover from a clean first claim.",
          "",
        ]
      : []),
    ...(claimedAt
      ? [
          "## Usage window",
          "",
          `- claimed_at: \`${claimedAt}\``,
          "- Count only work recorded at or after claimed_at. If this session already had work before the claim, that work is not part of this card.",
          "",
        ]
      : []),
    // The briefing must END with the recipe and the executor contract: in
    // field tests, workers with board tools made zero calls because nothing
    // told them how to measure themselves or what to send.
    ...(recipe ? renderRecipe(recipe) : []),
    "## Executor contract",
    "",
    "Before `task_deliver`, create the commit and push it to the remote. A modified working tree is not a delivery. Then call `task_deliver` with summary, evidence, commit, branch and " +
      "usage. Send usage as `segments`, one per model that ran: " +
      "`{segments: [{model, input, output, cache_read, cache_write}], " +
      "duration_ms, turns}` — the command above prints that shape. " +
      "When it reports `estimated: false`, keep the measured model and counters. " +
      "Only when it reports `estimated: true` with a reason should you estimate; " +
      "never replace a missing model with an invented default. " +
      "Real numbers found later? Correct them with `task_update` passing usage.\n\n" +
      "If this executor dies or reaches its model limit, start the replacement with `task_create { supersedes: this_card, inherit: true }`; never leave this card in execution.\n\n" +
      "Send `transcript: {path}` too, with the transcript the command read. " +
      "The board stores the reference only, never the content: the file stays " +
      "on your machine, and the card gets a way back to this session for " +
      "auditing it, resuming it, or recomputing usage later.",
  ].join("\n");
}
