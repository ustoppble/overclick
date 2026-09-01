/**
 * OCL-160 — recomputes cost for every attempt after the price table stopped
 * lying about cache write, sonnet-5, and (mid-fix, per a live amendment to
 * this card) the stale GPT-5.6 and Grok-4.6 rows.
 *
 * Unlike OCL-156, this is not limited to attempts whose cost_unpriced_models
 * was non-empty: the bug here was in already-"priced" attempts. Before this
 * fix, cache_read and cache_write shared one column seeded at the read rate,
 * so every attempt with a cache write was undercharged; sonnet-5 was seeded
 * at the cancelled 3/15 rate instead of the standing 2/10 one; and (found
 * live while working this card) gpt-5.6-sol/terra/luna and grok-4.6 were
 * seeded against a stale snapshot of their public price lists. Every one of
 * those is a correction to an attempt the board already believed it had
 * priced correctly, so this script pulls every attempt carrying usage
 * evidence — segments or the legacy flat counters — reruns the exact same
 * `assessAttemptCost` the app itself uses (packages/db/src/domain/pricing.ts)
 * against today's price table, and rewrites the five cost columns on the ones
 * that actually changed. An attempt whose recomputed answer matches what is
 * already stored is left alone.
 *
 * Usage:
 *   tsx scripts/ocl-160-recompute-cache-price.ts            # dry run (default)
 *   tsx scripts/ocl-160-recompute-cache-price.ts --apply    # writes to prod
 */
import { execFileSync } from "node:child_process";

import { assessAttemptCost, factoryModelPrices, normalizeModelKey, type ModelPriceRow } from "../packages/db/src/domain/pricing";
import type { UsageSegment } from "../packages/db/src/domain/usage";

const SSH_HOST = "gt40"; // alias from ~/.ssh/config — never the real address
const CONTAINER = "overclick-overclick-db-1";
const DB_USER = "overclick";
const DB_NAME = "overclick";

type AttemptRow = {
  id: string;
  task_short_id: string;
  usage_segments: UsageSegment[] | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache: number | null;
  reported_cost_usd: string | null;
  cost_usd: string | null;
  cost_source: string | null;
  cost_status: string | null;
  cost_unpriced_models: string[] | null;
  usage_estimated: boolean;
  usage_suspect: boolean;
};

/** Same stdin transport as OCL-155/OCL-156: a `-c` argument gets re-parsed
 * by the remote shell, which corrupts any query carrying double quotes — an
 * UPDATE with a JSON literal always does. Stdin skips that second parse. */
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

/** The workspace this board actually runs — every card and price row lives under it. */
function resolveWorkspaceId(): string {
  const out = psql("select id from workspace order by created_at asc limit 1;");
  const id = out.trim();
  if (!id) throw new Error("Could not resolve a workspace id from the workspace table.");
  return id;
}

/** Same merge loadModelPrices (apps/web/src/lib/prices.ts) does: seed, then any workspace custom row on top. */
function loadPrices(workspaceId: string): ModelPriceRow[] {
  const rows = new Map<string, ModelPriceRow>();
  for (const row of factoryModelPrices()) rows.set(row.model, row);

  const out = psql(
    `select json_agg(row_to_json(t)) from (select model, label, input_per_mtok, output_per_mtok, cache_per_mtok, cache_write_per_mtok, seeded_at, updated_by, updated_at from model_price where workspace_id = '${workspaceId}') t;`,
  );
  const custom = JSON.parse(out.trim() || "null") ?? [];
  for (const row of custom) {
    const key = normalizeModelKey(row.model);
    rows.set(key, {
      model: key,
      label: row.label,
      inputPerMtok: Number(row.input_per_mtok),
      outputPerMtok: Number(row.output_per_mtok),
      cachePerMtok: Number(row.cache_per_mtok),
      cacheWritePerMtok: Number(row.cache_write_per_mtok),
      source: "custom",
      seededAt: row.seeded_at,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    });
  }
  return [...rows.values()];
}

/**
 * Every attempt carrying usage evidence at all — segments or the legacy flat
 * counters. Unlike OCL-156 this is not filtered to cost_unpriced_models: the
 * bug fixed here hid inside attempts the board already believed it had
 * priced correctly.
 */
function dumpCandidates(): AttemptRow[] {
  const query = `
select json_agg(row_to_json(t)) from (
  select
    ea.id, t.short_id as task_short_id, ea.usage_segments, ea.tokens_in, ea.tokens_out,
    ea.tokens_cache, ea.reported_cost_usd, ea.cost_usd, ea.cost_source, ea.cost_status,
    ea.cost_unpriced_models, ea.usage_estimated, ea.usage_suspect
  from execution_attempt ea
  join task t on t.id = ea.task_id
  where jsonb_array_length(coalesce(ea.usage_segments, '[]'::jsonb)) > 0
     or ea.tokens_in is not null or ea.tokens_out is not null or ea.tokens_cache is not null
  order by ea.started_at asc
) t;`;
  const out = psql(query);
  return (JSON.parse(out.trim() || "null") ?? []) as AttemptRow[];
}

function tokensReported(attempt: AttemptRow): boolean {
  return (
    (attempt.usage_segments?.length ?? 0) > 0 ||
    attempt.tokens_in != null ||
    attempt.tokens_out != null ||
    attempt.tokens_cache != null
  );
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((v, i) => v === bs[i]);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function costsDiffer(oldCost: string | null, newCost: number | null): boolean {
  if (oldCost == null && newCost == null) return false;
  if (oldCost == null || newCost == null) return true;
  // Same rounding the column stores, so a float noise difference does not
  // read as a real change.
  return Math.round(Number(oldCost) * 1e6) !== Math.round(newCost * 1e6);
}

function applyUpdate(
  attempt: AttemptRow,
  assessment: ReturnType<typeof assessAttemptCost>,
): void {
  const setParts = [
    assessment.costUsd != null ? `cost_usd = ${assessment.costUsd}` : "cost_usd = null",
    assessment.source ? `cost_source = ${sqlString(assessment.source)}` : "cost_source = null",
    `cost_status = ${sqlString(assessment.status)}`,
    `cost_unpriced_models = '${JSON.stringify(assessment.unpricedModels).replace(/'/g, "''")}'::jsonb`,
    `cost_breakdown = '${JSON.stringify(assessment.breakdown).replace(/'/g, "''")}'::jsonb`,
  ];
  psql(`update execution_attempt set ${setParts.join(", ")} where id = '${attempt.id}';`);
}

function main() {
  const apply = process.argv.includes("--apply");
  const rowCount = assertRealProductionDb();
  const workspaceId = resolveWorkspaceId();
  const prices = loadPrices(workspaceId);
  const candidates = dumpCandidates();

  console.log(`# OCL-160 — recálculo de custo após cache write ganhar preço próprio (${apply ? "APLICANDO" : "SIMULAÇÃO — nada será gravado"})`);
  console.log("");
  console.log(`Banco: container \`${CONTAINER}\`, banco \`${DB_NAME}\`, host ${maskHost(SSH_HOST)}. execution_attempt tem ${rowCount} linhas.`);
  console.log(`Preços carregados: ${prices.length} (seed + custom da workspace ${workspaceId}).`);
  console.log(`Attempts com alguma evidência de uso (segments ou contadores legados): ${candidates.length}`);
  console.log("");

  type Row = {
    attempt: AttemptRow;
    assessment: ReturnType<typeof assessAttemptCost>;
    changed: boolean;
    gainedUsd: number;
  };
  const rows: Row[] = [];

  for (const attempt of candidates) {
    const assessment = assessAttemptCost(attempt.usage_segments ?? [], prices, {
      reportedCostUsd: attempt.reported_cost_usd != null ? Number(attempt.reported_cost_usd) : null,
      usageEstimated: attempt.usage_estimated,
      usageSuspect: attempt.usage_suspect,
      tokensReported: tokensReported(attempt),
    });
    const oldUnpriced = attempt.cost_unpriced_models ?? [];
    const changed =
      !sameStringSet(oldUnpriced, assessment.unpricedModels) ||
      costsDiffer(attempt.cost_usd, assessment.costUsd) ||
      attempt.cost_status !== assessment.status;
    const oldCost = attempt.cost_usd != null ? Number(attempt.cost_usd) : 0;
    const newCost = assessment.costUsd ?? 0;
    rows.push({ attempt, assessment, changed, gainedUsd: newCost - oldCost });
  }

  const toFix = rows.filter((r) => r.changed);
  const unchanged = rows.filter((r) => !r.changed);

  console.log(`## Recalculados de verdade (${toFix.length})`);
  console.log("");
  console.log("| Card | attempt | custo antes | custo depois | delta |");
  console.log("|------|---------|-------------|--------------|-------|");
  let totalGain = 0;
  for (const { attempt, assessment, gainedUsd } of toFix) {
    totalGain += gainedUsd;
    console.log(
      `| ${attempt.task_short_id} | ${attempt.id} | ${attempt.cost_usd ?? "null"} | ${assessment.costUsd ?? "null"} | ${gainedUsd >= 0 ? "+" : ""}${gainedUsd.toFixed(6)} |`,
    );
  }
  console.log("");
  console.log(`Total de dólar que entra (pode ser negativo, ex. sonnet-5 caindo de preço): $${totalGain.toFixed(6)}`);
  console.log("");

  // Grouped by model so the report can be checked against the specific
  // corrections this card made (cache write, sonnet-5, gpt-5.6-sol/terra/luna,
  // grok-4-6, gpt-daybreak-blue-latest folded into gpt-5.6-sol).
  const byModel = new Map<string, number>();
  for (const { attempt, gainedUsd } of toFix) {
    const models = (attempt.usage_segments ?? [])
      .map((s) => (s.model ? normalizeModelKey(s.model) : "unknown"))
      .filter((m, i, arr) => arr.indexOf(m) === i);
    const label = models.length > 0 ? models.join(" + ") : "unknown";
    byModel.set(label, (byModel.get(label) ?? 0) + gainedUsd);
  }
  console.log(`## Delta por combinação de modelo (${byModel.size})`);
  console.log("");
  console.log("| Modelo(s) | delta |");
  console.log("|-----------|-------|");
  for (const [label, gain] of [...byModel.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
    console.log(`| ${label} | ${gain >= 0 ? "+" : ""}${gain.toFixed(6)} |`);
  }
  console.log("");

  console.log(`## Sem mudança (${unchanged.length}) — recomputado, resultado idêntico ao já gravado`);
  console.log("");

  if (!apply) {
    console.log("Simulação apenas — nada foi gravado. Rode com --apply para escrever os recalculados acima.");
    return;
  }

  console.log("Gravando os recalculados...");
  for (const { attempt, assessment } of toFix) {
    applyUpdate(attempt, assessment);
    console.log(`- ${attempt.task_short_id} (${attempt.id}) -> cost_usd=${assessment.costUsd}, cost_status=${assessment.status}`);
  }
  console.log("");
  console.log(`Concluído: ${toFix.length} attempts recalculados, ${unchanged.length} sem mudança.`);
}

main();
