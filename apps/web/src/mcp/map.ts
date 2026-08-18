import type {
  Cardapio,
  ExecutorConfig,
  Harness as DbHarness,
  TranscriptRef,
} from "@agent-board/db";
import {
  DEFAULT_CARDAPIO,
  DEFAULT_REVIEWER,
  type Cardapio as McpCardapio,
  type ConfirmationStep,
  type ConfiguredExecutor,
  type Harness,
  type Mission,
  type Origem,
  type Project,
  type ProjectCardCounts,
  type Reviewer,
  type StoredTranscriptRefWire,
  type Task,
  type Usage,
} from "@agent-board/mcp-core";
import type { mission, project, task } from "@agent-board/db/schema";

export type TaskRow = typeof task.$inferSelect;
export type ProjectRow = typeof project.$inferSelect;
export type MissionRow = typeof mission.$inferSelect;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function looksLikeUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function serializeComoConfirmo(steps: ConfirmationStep[]): string {
  return JSON.stringify(steps);
}

export function parseComoConfirmo(raw: string): ConfirmationStep[] {
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof (item as { step?: unknown }).step === "string" &&
          typeof (item as { expected?: unknown }).expected === "string",
      )
    ) {
      return parsed as ConfirmationStep[];
    }
  } catch {
    // plain text from the seed / UI
  }
  return [{ step: raw, expected: "conforme o contrato" }];
}

export function originToDb(origem: Origem): Record<string, string> {
  const out: Record<string, string> = {};
  if (origem.pane_id) out.pane_id = origem.pane_id;
  if (origem.session_id) out.session_id = origem.session_id;
  if (origem.agent) out.agent = origem.agent;
  if (origem.cli) out.cli = origem.cli;
  if (origem.reportado_por) out.reportado_por = origem.reportado_por;
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function originFromDb(raw: unknown): Origem {
  if (!raw || typeof raw !== "object") {
    return { cli: "board" };
  }
  const rec = raw as Record<string, unknown>;
  const origem: Origem = {
    pane_id: asString(rec.pane_id) ?? asString(rec.paneId),
    session_id: asString(rec.session_id) ?? asString(rec.sessionId),
    agent: asString(rec.agent),
    cli: asString(rec.cli),
    reportado_por: asString(rec.reportado_por),
  };
  if (
    origem.pane_id ||
    origem.session_id ||
    origem.agent ||
    origem.cli ||
    origem.reportado_por
  ) {
    return origem;
  }
  return { cli: "board" };
}

export function reviewerFromRow(row: TaskRow): Reviewer {
  if (row.devolveParaKind === "human" && row.devolveParaUserId) {
    return { kind: "human", user_id: row.devolveParaUserId };
  }
  if (row.devolveParaKind === "agent" && row.devolveParaAgentRef) {
    return { kind: "agent", session_id: row.devolveParaAgentRef };
  }
  return { ...DEFAULT_REVIEWER };
}

export function reviewerToColumns(reviewer: Reviewer | undefined): {
  devolveParaKind: "human" | "agent" | "workspace_queue";
  devolveParaUserId: string | null;
  devolveParaAgentRef: string | null;
} {
  const value = reviewer ?? DEFAULT_REVIEWER;
  if (value.kind === "human") {
    return {
      devolveParaKind: "human",
      devolveParaUserId: value.user_id,
      devolveParaAgentRef: null,
    };
  }
  if (value.kind === "agent") {
    return {
      devolveParaKind: "agent",
      devolveParaUserId: null,
      devolveParaAgentRef: value.session_id,
    };
  }
  return {
    devolveParaKind: "workspace_queue",
    devolveParaUserId: null,
    devolveParaAgentRef: null,
  };
}

export function harnessFromDb(raw: DbHarness | null | undefined): Harness | null {
  if (!raw?.model) return null;
  return {
    ...(raw.cli ? { cli: raw.cli } : {}),
    model: raw.model,
    effort: raw.effort ?? "medium",
  };
}

export function harnessToDb(
  harness: {
    cli?: string | null;
    model: string | null;
    effort: Harness["effort"] | null;
  } | null,
): DbHarness | null {
  if (!harness) return null;
  return {
    cli: harness.cli ?? null,
    model: harness.model,
    effort: harness.effort,
  };
}

export function mapMission(row: MissionRow, taskCount?: number): Mission {
  const objective = row.objective;
  const context = row.context || row.objective;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    objective,
    context,
    ...(taskCount !== undefined ? { task_count: taskCount } : {}),
  };
}

export function emptyCardCounts(): ProjectCardCounts {
  return { total: 0, aberto: 0, em_execucao: 0, feito: 0, validado: 0 };
}

export function mapProject(
  row: ProjectRow,
  cards: ProjectCardCounts = emptyCardCounts(),
): Project {
  return {
    id: row.id,
    name: row.name,
    id_prefix: row.idPrefix,
    repo_url: row.repoUrl,
    next_number: row.nextNumber,
    cards,
    created_at: iso(row.createdAt),
  };
}

export function mapTask(
  row: TaskRow,
  proj: ProjectRow,
  extras: { reopenComment?: string | null; reportsCount?: number } = {},
): Task {
  const pr = row.prUrl && /^https?:\/\//.test(row.prUrl) ? row.prUrl : null;
  return {
    id: row.id,
    short_id: row.shortId,
    title: row.title,
    type: row.tipo,
    status: row.status,
    revisado: row.revisado,
    priority: row.priority,
    project_id: row.projectId,
    mission_id: row.missionId,
    devolve_para: reviewerFromRow(row),
    workspace_id: proj.workspaceId,
    previous_short_ids: row.previousShortIds ?? [],
    parent_id: row.parentId,
    o_que: row.oQue,
    por_que: row.porQue,
    como_confirmo: parseComoConfirmo(row.comoConfirmo),
    harness: harnessFromDb(row.harness),
    origem: originFromDb(row.origin),
    mode: row.mode,
    branch: row.branch,
    pull_request_url: pr,
    resolved_in: row.resolvedIn ?? null,
    reports_count: extras.reportsCount ?? 0,
    reopen_comment: extras.reopenComment ?? null,
    claimed_by: row.claimedByTokenId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function executorsFromWorkspace(
  executors: ExecutorConfig[],
): ConfiguredExecutor[] {
  return executors
    .filter((item) => item.enabled)
    .map((item) => ({
      id: item.id,
      cli: item.id,
      models: item.models,
    }));
}

export function cardapioFromWorkspace(cardapio: Cardapio): McpCardapio {
  const entry = (
    stored: DbHarness | undefined,
    fallback: McpCardapio["bug"],
  ): McpCardapio["bug"] => ({
    model_tier: stored?.modelTier ?? fallback.model_tier,
    effort: stored?.effort ?? fallback.effort,
  });
  return {
    ...DEFAULT_CARDAPIO,
    bug: entry(cardapio.bug, DEFAULT_CARDAPIO.bug),
    feature: entry(cardapio.feature, DEFAULT_CARDAPIO.feature),
    rfc: entry(cardapio.rfc, DEFAULT_CARDAPIO.rfc),
  };
}

export function usageFromUnknown(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const value = rec[key];
    return typeof value === "number" ? value : undefined;
  };
  return {
    tokens_in: num("tokens_in") ?? num("tokensIn"),
    tokens_out: num("tokens_out") ?? num("tokensOut"),
    tokens_cache: num("tokens_cache") ?? num("tokensCache"),
    cost_usd: num("cost_usd") ?? num("costUsd"),
    duration_ms: num("duration_ms") ?? num("durationMs"),
    turns: num("turns"),
    estimated: typeof rec.estimated === "boolean" ? rec.estimated : undefined,
  };
}

/**
 * The stored transcript reference on the wire: camelCase column, snake_case
 * contract. Null stays null so a card with nothing to point at says so.
 */
export function transcriptToWire(
  ref: TranscriptRef | null | undefined,
): StoredTranscriptRefWire | null {
  if (!ref) return null;
  return {
    cli: ref.cli,
    session_id: ref.sessionId,
    path: ref.path,
    resume: ref.resume,
  };
}

export function encodeExecutor(input: {
  token_id: string;
  cli?: string;
  agent?: string;
  session_id?: string;
}): string {
  return JSON.stringify(input);
}

export function decodeExecutor(
  raw: string | null,
  model: string | null,
  modelSource?: "declared" | "harness" | "measured" | null,
): {
  token_id?: string;
  cli?: string;
  model?: string;
  model_source?: "declared" | "harness" | "measured";
  agent?: string;
  session_id?: string;
} {
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object") {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = { cli: raw };
    }
  }
  return {
    token_id: asString(parsed.token_id),
    cli: asString(parsed.cli),
    agent: asString(parsed.agent),
    session_id: asString(parsed.session_id),
    ...(model ? { model } : {}),
    ...(modelSource ? { model_source: modelSource } : {}),
  };
}
