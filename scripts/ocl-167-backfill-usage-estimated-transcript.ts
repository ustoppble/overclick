/**
 * OCL-167 — an attempt delivered with an estimate gets the measured number
 * back, when the transcript it points at still exists on this machine.
 *
 * Measured in production on 2026-09-01: 392 attempts carry usage_estimated,
 * and 174 of them have transcript.path recorded — the executor pointed at a
 * real file on disk instead of leaving nothing to re-measure. This script
 * walks exactly those 174 and re-runs the same recipe command the CLI itself
 * would have run (packages/db/src/domain/usage-recipe.ts): the exact JSONL
 * parsing, per-model bucketing and cache-read/write math a live claim uses,
 * untouched.
 *
 * One thing the live path never has to handle: its claim window is only a
 * lower bound (entries at or after claimed_at) because it always runs right
 * after the work, so "now" already acts as the upper edge. A backfill runs
 * days or weeks later, and Claude Code/Grok/Codex/Kimi sessions keep
 * appending to the very same transcript file across every later card the
 * same session claims — confirmed on attempt 10cad915 (AGT-1): finished_at
 * was 2026-08-20 13:39 but the file's last line is 2026-09-01, the same day
 * this backfill ran. Handing the recipe the raw file with only claimed_at
 * bound would fold twelve days of unrelated work into a five-minute card.
 * So before invoking the recipe, this script trims a copy of the transcript
 * (or, for Kimi, of each agent's wire.jsonl inside the session directory) to
 * [started_at, finished_at] using the exact timestamp fields and epoch/ISO
 * detection claimWindow() already uses, then points the unmodified recipe
 * command at that copy. That is the real "claim window" this codebase means
 * elsewhere (checkUsageWindow, claim_window_exceeded): the span between
 * claim and delivery, not "claimed_at through whenever this script happens
 * to run." No CLI-specific parsing is reimplemented — only which lines ever
 * reach the recipe changes.
 *
 * An attempt whose recipe still comes back with estimated: false is
 * rewritten. A transcript that will not open, a CLI whose recipe cannot
 * yield tokens_per_model at all (gemini-cli, generic), or a readable file
 * with no entry inside [started_at, finished_at] all fall through untouched
 * and land in the "not recovered" list with the exact reason — never a guess
 * standing in for a measurement.
 *
 * This script never touches cost: usage_estimated flipping to false changes
 * what assessAttemptCost should answer, so run
 * scripts/ocl-160-recompute-cache-price.ts right after applying this one, on
 * the same --apply/dry-run switch, or the cost columns keep the old guess's
 * number sitting on top of the new measured tokens.
 *
 * Usage:
 *   tsx scripts/ocl-167-backfill-usage-estimated-transcript.ts            # dry run (default)
 *   tsx scripts/ocl-167-backfill-usage-estimated-transcript.ts --apply    # writes to prod
 */
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindRecipeSettings, factoryUsageRecipes, findUsageRecipe } from "../packages/db/src/domain/usage-recipe";
import { flattenUsageSegments, type UsageSegment } from "../packages/db/src/domain/usage";

const SSH_HOST = "gt40"; // alias from ~/.ssh/config — never the real address
const CONTAINER = "overclick-overclick-db-1";
const DB_USER = "overclick";
const DB_NAME = "overclick";

/** Same alias table apps/web/src/lib/executors.ts (CLI_ALIASES) keeps for the
 * live claim path, copied here instead of importing the Next.js app into a
 * database script: an agent sends the binary name ("claude"), the recipe
 * catalog is keyed by the catalog id ("claude-code"). */
const CLI_ALIASES: Record<string, string> = {
  claude: "claude-code",
  "codex cli": "codex",
  "codex-cli": "codex",
  gemini: "gemini-cli",
  copilot: "github-copilot",
  "grok-cli": "grok",
  "kimi-code": "kimi",
};
const CATALOG_IDS = new Set([
  "claude-code",
  "gemini-cli",
  "codex",
  "kimi",
  "grok",
  "github-copilot",
  "opencode",
  "generic-mcp",
]);
function resolveCatalogCli(cli: string): string | null {
  const needle = cli.trim().toLowerCase();
  if (!needle) return null;
  if (CATALOG_IDS.has(needle)) return needle;
  return CLI_ALIASES[needle] ?? null;
}

type TranscriptRef = {
  cli: string | null;
  sessionId: string | null;
  path: string | null;
  resume: string | null;
} | null;

type AttemptRow = {
  id: string;
  task_short_id: string;
  executor: string | null;
  model: string | null;
  transcript: TranscriptRef;
  started_at: string;
  finished_at: string | null;
  usage_segments: UsageSegment[] | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache: number | null;
  usage_estimated: boolean;
};

/** Same stdin transport as OCL-155/156/160/165/166: a `-c` argument gets
 * re-parsed by the remote shell, which corrupts any query carrying double
 * quotes — an UPDATE with a JSON literal always does. Stdin skips that
 * second parse. */
function psql(query: string): string {
  return execFileSync(
    "ssh",
    ["-o", "ConnectTimeout=5", SSH_HOST, `docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A -v ON_ERROR_STOP=1`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: query },
  );
}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function maskHost(hostAlias: string): string {
  return `SSH alias "${hostAlias}" (real address never printed)`;
}

/** Same safety check OCL-153/155/160/165/166 use: refuse to touch anything that is not the real production database. */
function assertRealProductionDb(): number {
  const psList = sh("ssh", ["-o", "ConnectTimeout=5", SSH_HOST, "docker ps --format '{{.Names}}'"]);
  if (!psList.includes("overclick-app-1") || !psList.includes(CONTAINER)) {
    throw new Error(
      `Expected containers overclick-app-1 and ${CONTAINER} both running on ${maskHost(SSH_HOST)}; got: ${psList.trim()}. Stopping instead of writing to a database nothing serves.`,
    );
  }
  const countOut = psql("select count(*) from execution_attempt;");
  const count = Number.parseInt(countOut.trim(), 10);
  if (!Number.isFinite(count) || count < 500) {
    throw new Error(
      `execution_attempt has ${countOut.trim()} rows on ${maskHost(SSH_HOST)}/${CONTAINER}:${DB_NAME}. That is not the size /insights has been reporting. Stopping instead of writing to the wrong database.`,
    );
  }
  return count;
}

/** Every attempt whose usage was reported as an estimate AND that carries a
 * transcript.path — the only population this backfill can ever recover,
 * since a card with no path never told the board where to look. */
function dumpCandidates(): AttemptRow[] {
  const query = `
select json_agg(row_to_json(t)) from (
  select
    ea.id, t.short_id as task_short_id, ea.executor, ea.model, ea.transcript,
    ea.started_at, ea.finished_at, ea.usage_segments, ea.tokens_in, ea.tokens_out,
    ea.tokens_cache, ea.usage_estimated
  from execution_attempt ea
  join task t on t.id = ea.task_id
  where ea.usage_estimated = true
    and ea.transcript is not null
    and coalesce(trim(ea.transcript->>'path'), '') != ''
  order by ea.started_at asc
) t;`;
  const out = psql(query);
  return (JSON.parse(out.trim() || "null") ?? []) as AttemptRow[];
}

function executorCli(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { cli?: unknown };
    return typeof parsed.cli === "string" ? parsed.cli : null;
  } catch {
    return null;
  }
}

type Outcome =
  | { kind: "recovered"; segments: UsageSegment[]; turns: number }
  | { kind: "unrecovered"; reason: string };

/** Same field priority and epoch/ISO detection as claimWindow() in
 * usage-recipe.ts's PRELUDE, kept identical on purpose: trimming has to drop
 * exactly the entries the live recipe would already consider timestampless
 * (excluded once claimed_at is set), never a rule of its own. */
function entryTimestampMs(entry: Record<string, unknown>, extraField?: string): number | null {
  let value: unknown = entry.timestamp;
  if (value === undefined) value = entry.created_at;
  if (value === undefined) value = entry.createdAt;
  if (value === undefined && extraField) value = entry[extraField];
  if (value === undefined || value === null) return null;
  const at =
    typeof value === "number"
      ? value > 100_000_000_000
        ? value
        : value * 1000
      : Date.parse(String(value));
  return Number.isNaN(at) ? null : at;
}

/** Copies one JSONL file, keeping only the lines whose timestamp falls
 * inside [startMs, endMs] — the actual claim-to-delivery window, since a
 * session file keeps growing long after any one card that shared it closed. */
function trimJsonlToWindow(srcPath: string, startMs: number, endMs: number, extraField?: string): string {
  const lines = readFileSync(srcPath, "utf8").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = entryTimestampMs(entry, extraField);
    if (at === null || at < startMs || at > endMs) continue;
    kept.push(line);
  }
  const dst = join(mkdtempSync(join(tmpdir(), "ocl-167-")), "transcript.jsonl");
  writeFileSync(dst, kept.length > 0 ? kept.join("\n") + "\n" : "");
  return dst;
}

/** Kimi's transcript is a session directory holding one wire.jsonl per agent
 * (main plus every subagent it spawned). Only those files are ever read, so
 * only they need trimming; the rest of the directory is irrelevant here. */
function trimKimiSessionToWindow(srcDir: string, startMs: number, endMs: number): string {
  const dstDir = mkdtempSync(join(tmpdir(), "ocl-167-kimi-"));
  mkdirSync(join(dstDir, "agents"), { recursive: true });
  let agents: string[] = [];
  try {
    agents = readdirSync(join(srcDir, "agents"));
  } catch {
    agents = [];
  }
  for (const agent of agents) {
    const src = join(srcDir, "agents", agent, "wire.jsonl");
    if (!existsSync(src)) continue;
    const trimmed = trimJsonlToWindow(src, startMs, endMs, "time");
    const agentDir = join(dstDir, "agents", agent);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "wire.jsonl"), readFileSync(trimmed, "utf8"));
    rmSync(join(trimmed, ".."), { recursive: true, force: true });
  }
  return dstDir;
}

/** Trims the transcript this attempt points at down to [started_at,
 * finished_at] before handing it to the recipe, returning the temp copy's
 * path plus a cleanup callback. A missing finished_at (should not happen for
 * a delivered attempt) falls back to no upper bound rather than guessing one. */
function windowedTranscript(
  recipeCli: string,
  attempt: AttemptRow,
  originalPath: string,
): { path: string; cleanup: () => void } {
  const startMs = Date.parse(attempt.started_at);
  const endMs = attempt.finished_at ? Date.parse(attempt.finished_at) : Number.POSITIVE_INFINITY;
  const isKimi = recipeCli === "kimi";
  const trimmedPath = isKimi
    ? trimKimiSessionToWindow(originalPath, startMs, endMs)
    : trimJsonlToWindow(originalPath, startMs, endMs);
  const root = isKimi ? trimmedPath : join(trimmedPath, "..");
  return { path: trimmedPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Measures one attempt by literally running the recipe command its CLI
 * ships — never a parser of our own — pinned to a copy of its transcript
 * trimmed to [started_at, finished_at] (see windowedTranscript above) and to
 * the same claimed_at setting the live path binds (bindUsageRecipe in
 * apps/web/src/lib/recipes.ts). */
function measure(attempt: AttemptRow): Outcome {
  const rawCli = attempt.transcript?.cli ?? executorCli(attempt.executor);
  const resolvedCli = rawCli ? (resolveCatalogCli(rawCli) ?? rawCli) : null;
  const recipe = findUsageRecipe(factoryUsageRecipes(), resolvedCli);
  if (!recipe || recipe.yields !== "tokens_per_model") {
    return {
      kind: "unrecovered",
      reason: `cli "${rawCli ?? "desconhecido"}" não tem receita que meça tokens (yields=${recipe?.yields ?? "nenhuma"})`,
    };
  }
  const originalPath = attempt.transcript?.path;
  if (!originalPath) return { kind: "unrecovered", reason: "transcript.path vazio" };
  if (!existsSync(originalPath)) {
    return { kind: "unrecovered", reason: `transcript ${originalPath} não existe nesta máquina` };
  }

  const { path: windowedPath, cleanup } = windowedTranscript(recipe.cli, attempt, originalPath);
  try {
    const settings: Record<string, string | null | undefined> = {
      claimed_at: new Date(attempt.started_at).toISOString(),
      transcript: windowedPath,
    };
    if (recipe.cli === "codex") {
      settings.codex_session = attempt.transcript?.sessionId ?? undefined;
      settings.codex_model = attempt.model ?? undefined;
    }
    const command = bindRecipeSettings(recipe.command, settings);

    let stdout: string;
    try {
      stdout = execSync(command, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: "/bin/bash" });
    } catch (error) {
      return { kind: "unrecovered", reason: `comando da receita falhou: ${(error as Error).message}` };
    }

    let payload: { segments?: UsageSegment[]; turns?: number; estimated?: boolean; reason?: string };
    try {
      payload = JSON.parse(stdout);
    } catch {
      return { kind: "unrecovered", reason: "saída da receita não é JSON válido" };
    }
    if (payload.estimated) {
      return { kind: "unrecovered", reason: payload.reason ?? "receita respondeu estimated:true sem motivo" };
    }
    const segments = payload.segments ?? [];
    if (segments.length === 0) {
      return { kind: "unrecovered", reason: "receita não retornou nenhum segment" };
    }
    return { kind: "recovered", segments, turns: payload.turns ?? 0 };
  } finally {
    cleanup();
  }
}

function totalTokens(segments: readonly UsageSegment[]): number {
  const flat = flattenUsageSegments(segments);
  return flat.tokens_in + flat.tokens_out + flat.tokens_cache;
}

/** The tokens already on the row before this backfill: segments when present
 * (some estimates still arrive shaped as segments), otherwise the legacy flat
 * counters — never both, or the same tokens would count twice. */
function tokensBefore(attempt: AttemptRow): number {
  if (attempt.usage_segments && attempt.usage_segments.length > 0) {
    return totalTokens(attempt.usage_segments);
  }
  return (attempt.tokens_in ?? 0) + (attempt.tokens_out ?? 0) + (attempt.tokens_cache ?? 0);
}

function applyUpdate(attempt: AttemptRow, segments: UsageSegment[]): void {
  const flat = flattenUsageSegments(segments);
  const setParts = [
    `usage_segments = '${JSON.stringify(segments).replace(/'/g, "''")}'::jsonb`,
    `tokens_in = ${flat.tokens_in}`,
    `tokens_out = ${flat.tokens_out}`,
    `tokens_cache = ${flat.tokens_cache}`,
    `usage_estimated = false`,
  ];
  psql(`update execution_attempt set ${setParts.join(", ")} where id = '${attempt.id}';`);
}

function main() {
  const apply = process.argv.includes("--apply");
  const rowCount = assertRealProductionDb();
  const candidates = dumpCandidates();

  console.log(
    `# OCL-167 — estimativa vira medição quando o transcript ainda está no disco (${apply ? "APLICANDO" : "SIMULAÇÃO — nada será gravado"})`,
  );
  console.log("");
  console.log(`Banco: container \`${CONTAINER}\`, banco \`${DB_NAME}\`, host ${maskHost(SSH_HOST)}. execution_attempt tem ${rowCount} linhas.`);
  console.log(`Attempts com usage_estimated=true e transcript.path informado (candidatos): ${candidates.length}`);
  console.log("");

  type Row = {
    attempt: AttemptRow;
    outcome: Outcome;
    beforeTokens: number;
    afterTokens: number;
  };
  const rows: Row[] = [];

  for (const attempt of candidates) {
    const outcome = measure(attempt);
    const beforeTokens = tokensBefore(attempt);
    const afterTokens = outcome.kind === "recovered" ? totalTokens(outcome.segments) : beforeTokens;
    rows.push({ attempt, outcome, beforeTokens, afterTokens });
  }

  const recovered = rows.filter((r): r is Row & { outcome: { kind: "recovered"; segments: UsageSegment[]; turns: number } } => r.outcome.kind === "recovered");
  const unrecovered = rows.filter((r) => r.outcome.kind === "unrecovered");
  const increased = recovered.filter((r) => r.afterTokens > r.beforeTokens);
  const decreased = recovered.filter((r) => r.afterTokens < r.beforeTokens);
  const unchanged = recovered.filter((r) => r.afterTokens === r.beforeTokens);
  const tokenDeltaSum = recovered.reduce((sum, r) => sum + (r.afterTokens - r.beforeTokens), 0);

  console.log(`## Resumo`);
  console.log("");
  console.log(`- Recuperados (transcript abriu e mediu na janela do claim): ${recovered.length}`);
  console.log(`  - chute estava para baixo do medido (tokens sobem): ${increased.length}`);
  console.log(`  - chute estava para cima do medido (tokens descem): ${decreased.length}`);
  console.log(`  - chute já batia com o medido: ${unchanged.length}`);
  console.log(`- Não recuperados (ficam como estimativa): ${unrecovered.length}`);
  console.log(`- Delta líquido de tokens entre os recuperados: ${tokenDeltaSum >= 0 ? "+" : ""}${tokenDeltaSum}`);
  console.log("");

  const reasonCounts = new Map<string, number>();
  for (const r of unrecovered) {
    const reason = (r.outcome as { reason: string }).reason;
    const bucket = reason.split(":")[0];
    reasonCounts.set(bucket, (reasonCounts.get(bucket) ?? 0) + 1);
  }
  if (reasonCounts.size > 0) {
    console.log(`## Não recuperados, por motivo (${unrecovered.length})`);
    console.log("");
    console.log("| Motivo | Quantidade |");
    console.log("|--------|------------|");
    for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`| ${reason} | ${count} |`);
    }
    console.log("");
  }

  console.log(`## Recuperados — tokens sobem (${increased.length})`);
  console.log("");
  console.log("| Card | attempt | cli | antes | depois | delta |");
  console.log("|------|---------|-----|-------|--------|-------|");
  for (const r of increased) {
    const cli = r.attempt.transcript?.cli ?? executorCli(r.attempt.executor) ?? "?";
    console.log(`| ${r.attempt.task_short_id} | ${r.attempt.id} | ${cli} | ${r.beforeTokens} | ${r.afterTokens} | +${r.afterTokens - r.beforeTokens} |`);
  }
  console.log("");

  console.log(`## Recuperados — tokens descem (${decreased.length})`);
  console.log("");
  console.log("| Card | attempt | cli | antes | depois | delta |");
  console.log("|------|---------|-----|-------|--------|-------|");
  for (const r of decreased) {
    const cli = r.attempt.transcript?.cli ?? executorCli(r.attempt.executor) ?? "?";
    console.log(`| ${r.attempt.task_short_id} | ${r.attempt.id} | ${cli} | ${r.beforeTokens} | ${r.afterTokens} | ${r.afterTokens - r.beforeTokens} |`);
  }
  console.log("");

  console.log(`## Não recuperados, detalhado (${unrecovered.length})`);
  console.log("");
  console.log("| Card | attempt | cli | motivo |");
  console.log("|------|---------|-----|--------|");
  for (const r of unrecovered) {
    const cli = r.attempt.transcript?.cli ?? executorCli(r.attempt.executor) ?? "?";
    console.log(`| ${r.attempt.task_short_id} | ${r.attempt.id} | ${cli} | ${(r.outcome as { reason: string }).reason} |`);
  }
  console.log("");

  if (!apply) {
    console.log("Simulação apenas — nada foi gravado. Rode com --apply para escrever as mudanças acima.");
    console.log(
      "Lembrete: depois do --apply deste script, rode `tsx scripts/ocl-160-recompute-cache-price.ts --apply` para o custo deixar de refletir o chute antigo.",
    );
    return;
  }

  console.log("Gravando os recuperados...");
  for (const r of recovered) {
    applyUpdate(r.attempt, r.outcome.segments);
    console.log(`- ${r.attempt.task_short_id} (${r.attempt.id}) -> usage_estimated=false, tokens=${r.afterTokens}`);
  }
  console.log("");
  console.log(`Concluído: ${recovered.length} attempts regravados, ${unrecovered.length} continuam como estimativa.`);
  console.log("Custo ainda não foi recalculado — rode agora `tsx scripts/ocl-160-recompute-cache-price.ts --apply`.");
}

main();
