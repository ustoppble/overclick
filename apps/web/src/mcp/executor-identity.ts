import { normalizeModelKey } from "@agent-board/db";

/**
 * "harness" is the historical name for a model the board inferred rather than
 * was told: from the card's planned harness before OCL-202, and still today
 * from a Codex legacy label that carries no version.
 */
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
 * stable id per connection. The board records the CLI the claim declared: it
 * has no planned harness to substitute for it (OCL-202).
 */
export function normalizeClaimCli(
  declared: string | null | undefined,
): string | undefined {
  const raw = declared?.trim();
  if (!raw) return undefined;
  if (raw.toLowerCase() === "codex cli") return "codex";
  return raw.toLowerCase();
}

/** True for labels that describe a family/launcher, not a runnable model. */
export function isGenericModelLabel(model: string | null | undefined): boolean {
  return GENERIC_MODELS.has(model?.trim().toLowerCase() ?? "");
}

/**
 * Resolves the executor identity stored by task_claim: what the card records
 * as the harness that ran it (OCL-202).
 *
 * Exact declarations canonicalize spelling aliases, never billing aliases.
 * A generic label records no model, so the usage measures one later; the one
 * exception is Codex's two legacy labels, whose fallback the owner confirmed.
 * Nothing is taken from a planned harness: the board no longer plans one.
 * Nor is the claim checked against a list (E2): the Overclock app decides
 * what runs, so any model is recorded, and this normalization alone keeps one
 * model from splitting into twin rows in Consumo (OCL-170).
 */
export function resolveClaimExecutor(
  input: ClaimExecutorInput | null | undefined,
): ResolvedClaimExecutor {
  const cli = normalizeClaimCli(input?.cli);
  const rawModel = input?.model?.trim();
  const generic = isGenericModelLabel(rawModel);
  const codexFallback =
    cli === "codex" && ["gpt-5", "o4-mini"].includes(rawModel?.toLowerCase() ?? "")
      ? DEFAULT_CODEX_MODEL
      : "";
  const model = generic ? codexFallback : normalizeModelKey(rawModel ?? "");
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
