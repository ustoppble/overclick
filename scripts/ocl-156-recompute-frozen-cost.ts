/**
 * OCL-156 — attempts whose cost was frozen "unpriced" get recomputed once
 * their model has a price.
 *
 * Cost is frozen on the attempt at delivery time (execution_attempt.cost_usd,
 * cost_source, cost_status, cost_unpriced_models, cost_breakdown). A model
 * that gets a price row later (OCL-151, OCL-152, and this same mission's
 * OCL-155 backfill) only changes cost for FUTURE deliveries — every attempt
 * already frozen keeps lying "sem preço" forever unless someone recomputes it
 * against today's price table. That is what this script does: for every
 * attempt whose cost_unpriced_models is non-empty, it reruns the exact same
 * `assessAttemptCost` the app itself uses (packages/db/src/domain/pricing.ts)
 * against usage_segments + today's price table (seed + any workspace custom
 * row, same merge loadModelPrices does), and rewrites the five cost columns.
 *
 * An attempt whose recomputed unpriced-models list is unchanged (still every
 * bit as unpriced as before — e.g. grok-4, which the xAI price list no longer
 * publishes at all) is left alone: this script never invents a price, it only
 * applies prices that already exist in the table.
 *
 * Usage:
 *   tsx scripts/ocl-156-recompute-frozen-cost.ts            # dry run (default)
 *   tsx scripts/ocl-156-recompute-frozen-cost.ts --apply    # writes to prod
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

/** Same stdin transport as OCL-155's backfill: a `-c` argument gets re-parsed
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
    `select json_agg(row_to_json(t)) from (select model, label, input_per_mtok, output_per_mtok, cache_per_mtok, seeded_at, updated_by, updated_at from model_price where workspace_id = '${workspaceId}') t;`,
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
      source: "custom",
      seededAt: row.seeded_at,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    });
  }
  return [...rows.values()];
}

function dumpCandidates(): AttemptRow[] {
  const query = `
select json_agg(row_to_json(t)) from (
  select
    ea.id, t.short_id as task_short_id, ea.usage_segments, ea.tokens_in, ea.tokens_out,
    ea.tokens_cache, ea.reported_cost_usd, ea.cost_usd, ea.cost_source, ea.cost_status,
    ea.cost_unpriced_models, ea.usage_estimated, ea.usage_suspect
  from execution_attempt ea
  join task t on t.id = ea.task_id
  where jsonb_array_length(coalesce(ea.cost_unpriced_models, '[]'::jsonb)) > 0
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

  console.log(`# OCL-156 — recálculo de custo congelado (${apply ? "APLICANDO" : "SIMULAÇÃO — nada será gravado"})`);
  console.log("");
  console.log(`Banco: container \`${CONTAINER}\`, banco \`${DB_NAME}\`, host ${maskHost(SSH_HOST)}. execution_attempt tem ${rowCount} linhas.`);
  console.log(`Preços carregados: ${prices.length} (seed + custom da workspace ${workspaceId}).`);
  console.log(`Attempts com cost_unpriced_models não-vazio: ${candidates.length}`);
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
    const changed = !sameStringSet(oldUnpriced, assessment.unpricedModels) || (attempt.cost_usd == null) !== (assessment.costUsd == null);
    const oldCost = attempt.cost_usd != null ? Number(attempt.cost_usd) : 0;
    const newCost = assessment.costUsd ?? 0;
    rows.push({ attempt, assessment, changed, gainedUsd: newCost - oldCost });
  }

  const toFix = rows.filter((r) => r.changed);
  const unchanged = rows.filter((r) => !r.changed);

  console.log(`## Recalculados de verdade (${toFix.length})`);
  console.log("");
  console.log("| Card | attempt | unpriced antes | unpriced depois | custo antes | custo depois |");
  console.log("|------|---------|-----------------|-------------------|-------------|--------------|");
  let totalGain = 0;
  for (const { attempt, assessment, gainedUsd } of toFix) {
    totalGain += gainedUsd;
    console.log(
      `| ${attempt.task_short_id} | ${attempt.id} | ${(attempt.cost_unpriced_models ?? []).join(", ") || "-"} | ${assessment.unpricedModels.join(", ") || "-"} | ${attempt.cost_usd ?? "null"} | ${assessment.costUsd ?? "null"} |`,
    );
  }
  console.log("");
  console.log(`Total de dólar que entra: $${totalGain.toFixed(6)}`);
  console.log("");

  console.log(`## Continuam sem preço de verdade, não tocados (${unchanged.length})`);
  console.log("");
  const byModel: Record<string, number> = {};
  for (const { attempt } of unchanged) {
    for (const model of attempt.cost_unpriced_models ?? []) byModel[model] = (byModel[model] ?? 0) + 1;
  }
  console.log("| Modelo sem preço | attempts |");
  console.log("|-------------------|----------|");
  for (const [model, count] of Object.entries(byModel).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${model} | ${count} |`);
  }
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
  console.log(`Concluído: ${toFix.length} attempts recalculados, ${unchanged.length} continuam sem preço de verdade.`);
}

main();
