import { readFileSync, statSync } from "node:fs";
import { normalizeModelKey } from "@agent-board/db";

/** Last distinct model the transcript named, plus the chain for the timeline. */
export type TranscriptModelIdentity = {
  model: string;
  chain: string;
};

/**
 * Grok's turn_completed writes usage.modelUsage["grok-4.6-build"]. The price
 * table keys drop the -build suffix (grok-4-6, grok-4-5). normalizeModelKey
 * already aliases grok-4-6-build; grok-4-5-build has no alias yet, so the
 * suffix is stripped here instead of inventing a price-table change.
 */
export function canonicalTranscriptModel(raw: string): string {
  return normalizeModelKey(raw).replace(/-build$/, "");
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function pushCanon(models: string[], raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  const model = canonicalTranscriptModel(trimmed);
  if (model && !models.includes(model)) models.push(model);
}

function grokModels(file: string): string[] {
  const models: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = parseJsonLine(line) as {
      params?: { update?: { sessionUpdate?: string; usage?: { modelUsage?: Record<string, unknown> } } };
    } | null;
    const update = entry?.params?.update ?? {};
    if (update.sessionUpdate !== "turn_completed") continue;
    for (const key of Object.keys(update.usage?.modelUsage ?? {})) {
      pushCanon(models, key);
    }
  }
  return models;
}

function codexModels(file: string): string[] {
  const models: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = parseJsonLine(line) as {
      type?: string;
      payload?: { model?: unknown };
    } | null;
    if (entry?.type !== "turn_context") continue;
    if (typeof entry.payload?.model !== "string") continue;
    pushCanon(models, entry.payload.model);
  }
  return models;
}

function sniffKind(
  cli: string | null | undefined,
  path: string,
): "grok" | "codex" | null {
  const key = (cli ?? "").trim().toLowerCase();
  if (key.includes("grok")) return "grok";
  if (key.includes("codex")) return "codex";
  if (path.includes(".grok") && path.includes("updates.jsonl")) return "grok";
  if (path.includes(".codex") && path.includes("rollout-")) return "codex";
  return null;
}

/**
 * The model the session actually ran, read off the file the card points at.
 * Null when the path is missing, unreadable, or names no model: the board
 * then keeps the declared model instead of inventing one.
 */
export function identityFromTranscript(input: {
  cli?: string | null;
  path?: string | null;
}): TranscriptModelIdentity | null {
  const path = (input.path ?? "").trim();
  if (!path) return null;
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  const kind = sniffKind(input.cli, path);
  if (!kind) return null;
  let models: string[] = [];
  try {
    models = kind === "grok" ? grokModels(path) : codexModels(path);
  } catch {
    return null;
  }
  const model = models.at(-1);
  return model ? { model, chain: models.join(" to ") } : null;
}
