import {
  normalizeModelKey,
  type ExecutorConfig,
  type Harness as DbHarness,
} from "@agent-board/db";
import { resolveCatalogCli } from "../lib/executors";

export type AttemptModelSource = "declared" | "harness" | "measured";

export type ClaimExecutorInput = {
  cli?: string;
  model?: string;
  effort?: string;
  agent?: string;
  session_id?: string;
};

export type ResolvedClaimExecutor = ClaimExecutorInput & {
  cli?: string;
  model?: string;
  model_source?: AttemptModelSource;
};

/** The model Codex actually runs when its legacy labels carry no version. */
export const DEFAULT_CODEX_MODEL = "gpt-5-6-sol";

const GENERIC_MODELS = new Set(["", "gpt-5", "codex", "claude", "o4-mini"]);

/**
 * CLI names come from binaries and orchestrators, while the catalog uses one
 * stable id per connection. `overclock` is not an executor: when it appears
 * on a claim, the card's harness names the CLI that really received the work.
 */
export function normalizeClaimCli(
  declared: string | null | undefined,
  harnessCli?: string | null,
): string | undefined {
  const raw = declared?.trim();
  if (!raw) return harnessCli ? normalizeClaimCli(harnessCli) : undefined;
  if (raw.toLowerCase() === "overclock" && harnessCli) {
    return normalizeClaimCli(harnessCli);
  }
  if (raw.toLowerCase() === "codex cli") return "codex";
  return raw.toLowerCase();
}

/** True for labels that describe a family/launcher, not a runnable model. */
export function isGenericModelLabel(model: string | null | undefined): boolean {
  return GENERIC_MODELS.has(model?.trim().toLowerCase() ?? "");
}

/**
 * Resolves the executor identity stored by task_claim.
 *
 * Exact declarations are canonicalized through the same alias helper usage
 * pricing uses. Generic declarations inherit the card harness. Codex's two
 * legacy labels also have a safe no-harness fallback confirmed by the owner.
 */
export function resolveClaimExecutor(
  input: ClaimExecutorInput | null | undefined,
  harness: Pick<DbHarness, "cli" | "model"> | null | undefined,
): ResolvedClaimExecutor {
  const cli = normalizeClaimCli(input?.cli, harness?.cli);
  const rawModel = input?.model?.trim();
  const generic = isGenericModelLabel(rawModel);
  const harnessModel = harness?.model ? normalizeModelKey(harness.model) : "";
  const codexFallback =
    cli === "codex" && ["gpt-5", "o4-mini"].includes(rawModel?.toLowerCase() ?? "")
      ? DEFAULT_CODEX_MODEL
      : "";
  const model = generic
    ? harnessModel || codexFallback
    : normalizeModelKey(rawModel ?? "");
  const modelSource: AttemptModelSource | undefined = model
    ? generic
      ? "harness"
      : "declared"
    : undefined;

  return {
    ...(cli ? { cli } : {}),
    ...(model ? { model, model_source: modelSource } : {}),
    ...(input?.effort?.trim() ? { effort: input.effort.trim() } : {}),
    ...(input?.agent ? { agent: input.agent } : {}),
    ...(input?.session_id ? { session_id: input.session_id } : {}),
  };
}

/**
 * Normalizes an already observed pair before it reaches Connections. Generic
 * labels are deliberately rejected: they are not actionable catalog entries.
 */
export function normalizeObservedExecutor(
  executor: { cli?: string; model?: string } | null | undefined,
): { cli: string; model: string } | null {
  const claimCli = normalizeClaimCli(executor?.cli);
  const cli = claimCli ? (resolveCatalogCli(claimCli) ?? claimCli) : undefined;
  const rawModel = executor?.model?.trim();
  if (!cli || cli === "overclock" || isGenericModelLabel(rawModel)) return null;
  const model = normalizeModelKey(rawModel ?? "");
  return model ? { cli, model } : null;
}

/** Alias-aware membership check used before offering a connection as new. */
export function isExecutorPairConfigured(
  config: readonly { id: string; enabled: boolean; models: string[] }[],
  cli: string,
  model: string,
): boolean {
  const claimCli = normalizeClaimCli(cli);
  const resolvedCli = claimCli ? (resolveCatalogCli(claimCli) ?? claimCli) : undefined;
  const resolvedModel = normalizeModelKey(model);
  if (!resolvedCli || !resolvedModel) return false;
  return config.some(
    (row) =>
      row.enabled &&
      (resolveCatalogCli(row.id) ?? normalizeClaimCli(row.id)) === resolvedCli &&
      row.models.some((candidate) => normalizeModelKey(candidate) === resolvedModel),
  );
}

/**
 * True when the claim's cli resolves to an executor the workspace already
 * has at least one model registered under. A cli the board has never heard
 * of yet (or configured with zero models) has no catalog to validate
 * against, so it stays on the old learn-from-claims path (recordSeenExecutor)
 * instead of being blocked before the board can ever discover it.
 */
function isKnownClaimCli(
  cli: string | null | undefined,
  executors: readonly ExecutorConfig[] | undefined,
): boolean {
  const claimCli = normalizeClaimCli(cli ?? undefined);
  if (!claimCli) return false;
  const catalogCli = resolveCatalogCli(claimCli) ?? claimCli;
  return (executors ?? []).some(
    (item) => item.id.trim().toLowerCase() === catalogCli && item.models.length > 0,
  );
}

/**
 * Refuses a task_claim whose declared model matches nothing the workspace
 * has configured, for a cli the board already knows. Replaces the OCL-148
 * blacklist: that list only ever caught the four family names it already
 * knew about ("", gpt-5, codex, claude, o4-mini — left alone here since
 * resolveClaimExecutor's harness/Codex fallback already handles them), so
 * grok-4 and grok-4-fast, never listed, landed as if they were registered
 * models the board actually ran, splitting Insights into twin rows.
 *
 * A cli the workspace has not configured yet is left alone (see
 * isKnownClaimCli): blocking it here would foreclose ever discovering a
 * genuinely new connection through recordSeenExecutor.
 */
export function unregisteredClaimModelRefusal(
  cli: string | null | undefined,
  model: string | null | undefined,
  executors: readonly ExecutorConfig[] | undefined,
): string | null {
  const raw = model?.trim();
  if (!raw || isGenericModelLabel(raw)) return null;
  if (!isKnownClaimCli(cli, executors)) return null;

  const key = normalizeModelKey(raw);
  const registered = [...new Set((executors ?? []).flatMap((item) => item.models))];
  if (registered.some((candidate) => normalizeModelKey(candidate) === key)) {
    return null;
  }
  const list = registered.length > 0 ? registered.join(", ") : "no models registered yet";
  return `Model '${raw}' is not among this workspace's configured executors. Registered: ${list}. If '${raw}' is a real, legitimate model, ask a human to register it with executors_update — the agent does not register models on its own.`;
}
