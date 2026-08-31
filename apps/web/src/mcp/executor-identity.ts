import {
  factoryModelPrices,
  findModelPrice,
  MODEL_KEY_ALIASES,
  normalizeModelKey,
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

/** Exact Codex `--model` names listed when a generic family label is refused. */
export const CODEX_EXACT_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.3-codex-spark",
] as const;

/** Family labels Codex agents send instead of the exact `--model` flag. */
const GENERIC_CODEX_MODELS = new Set(["gpt-5", "gpt-daybreak-blue-latest"]);

const GENERIC_MODELS = new Set(["", "gpt-5", "codex", "claude", "o4-mini"]);

/**
 * Error text when a claim declares a known generic Codex family instead of
 * the exact `--model`. Priced models and aliases pass: the refusal is only
 * for the names that historically landed unpriced.
 */
export function genericCodexModelRefusal(
  model: string | null | undefined,
): string | null {
  const raw = model?.trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (MODEL_KEY_ALIASES[lowered] || findModelPrice(factoryModelPrices(), raw)) {
    return null;
  }
  if (!GENERIC_CODEX_MODELS.has(lowered)) return null;
  return `Codex must declare the exact model from --model, never ${lowered}. Accepted names: ${CODEX_EXACT_MODELS.join(", ")}.`;
}

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
