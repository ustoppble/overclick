/**
 * OCL-173 — "measured" só quando alguém mediu de fato.
 *
 * measuredModelIdentity (apps/web/src/mcp/tools.ts) used to read the segments
 * the agent itself reported in usage.segments and stamp modelSource:
 * "measured" on any divergence, whether or not the board could ever read the
 * transcript file the card points at. The fix (this same card) makes that
 * label depend on identityFromTranscript actually resolving a model off
 * disk: "measured" only when the transcript backs it, "declared" when the
 * model came only from the agent's word, "harness" unchanged otherwise. That
 * fix only governs writes from here on — every attempt already stamped
 * "measured" before it shipped keeps the old, looser verdict until this
 * script re-checks it.
 *
 * For every execution_attempt with model_source = 'measured', this script
 * re-runs the same transcript check the fixed code now uses (identical
 * sniffKind/grokModels/codexModels logic from
 * apps/web/src/mcp/transcript-model.ts, executed inside the app container so
 * it sees the same filesystem task_deliver/task_update saw). A transcript
 * that still resolves a model keeps model_source = 'measured'. Everything
 * else — no path, an unreadable file, a cli neither grok nor codex, a file
 * with no model in it — is relabeled model_source = 'declared'. The stored
 * `model` value itself is never touched: this only corrects how much
 * confidence the board claims for a value that was never in question.
 *
 * Usage:
 *   tsx scripts/ocl-173-backfill-measured-model-source.ts            # dry run (default)
 *   tsx scripts/ocl-173-backfill-measured-model-source.ts --apply    # writes to prod
 */
import { execFileSync } from "node:child_process";

const SSH_HOST = "gt40"; // alias from ~/.ssh/config — never the real address
const DB_CONTAINER = "overclick-overclick-db-1";
const APP_CONTAINER = "overclick-app-1";
const DB_USER = "overclick";
const DB_NAME = "overclick";

type TranscriptRef = {
  cli?: string | null;
  sessionId?: string | null;
  path?: string | null;
  resume?: string | null;
} | null;

type AttemptRow = {
  id: string;
  task_short_id: string;
  model: string | null;
  transcript: TranscriptRef;
};

/** Same stdin transport as OCL-155/156/160/165: a `-c` argument gets
 * re-parsed by the remote shell, which corrupts any query carrying double
 * quotes — a query with a jsonb literal always does. Stdin skips that second
 * parse. */
function psql(query: string): string {
  return execFileSync(
    "ssh",
    [
      "-o",
      "ConnectTimeout=5",
      SSH_HOST,
      `docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A -v ON_ERROR_STOP=1`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: query },
  );
}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function maskHost(hostAlias: string): string {
  return `SSH alias "${hostAlias}" (real address never printed)`;
}

/** Same safety check OCL-153/155/160/165 use: refuse to touch anything that
 * is not the real production database, and confirm the app container the
 * transcript check will run inside is the one actually serving traffic. */
function assertRealProductionDb(): number {
  const psList = sh("ssh", ["-o", "ConnectTimeout=5", SSH_HOST, "docker ps --format '{{.Names}}'"]);
  if (!psList.includes(APP_CONTAINER) || !psList.includes(DB_CONTAINER)) {
    throw new Error(
      `Expected containers ${APP_CONTAINER} and ${DB_CONTAINER} both running on ${maskHost(SSH_HOST)}; got: ${psList.trim()}. Stopping instead of writing to a database nothing serves.`,
    );
  }
  const countOut = psql("select count(*) from execution_attempt;");
  const count = Number.parseInt(countOut.trim(), 10);
  if (!Number.isFinite(count) || count < 500) {
    throw new Error(
      `execution_attempt has ${countOut.trim()} rows on ${maskHost(SSH_HOST)}/${DB_CONTAINER}:${DB_NAME}. That is not the size /insights has been reporting. Stopping instead of writing to the wrong database.`,
    );
  }
  return count;
}

/** Every attempt currently stamped model_source = 'measured'. */
function dumpCandidates(): AttemptRow[] {
  const query = `
select json_agg(row_to_json(t)) from (
  select ea.id, t.short_id as task_short_id, ea.model, ea.transcript
  from execution_attempt ea
  join task t on t.id = ea.task_id
  where ea.model_source = 'measured'
  order by ea.started_at asc
) t;`;
  const out = psql(query);
  return (JSON.parse(out.trim() || "null") ?? []) as AttemptRow[];
}

/**
 * The exact identityFromTranscript logic from
 * apps/web/src/mcp/transcript-model.ts, minus the model-key canonicalization
 * (normalizeModelKey lives in the db package and is not worth wiring across
 * this ssh boundary — this script only needs "does a model come back at
 * all", never the exact spelling). Runs inside the app container so
 * relative/mounted transcript paths resolve exactly as they did when
 * task_deliver/task_update wrote "measured" in the first place.
 */
const REMOTE_IDENTITY_SCRIPT = `
const fs = require('fs');
function sniffKind(cli, path) {
  const key = (cli || '').trim().toLowerCase();
  if (key.includes('grok')) return 'grok';
  if (key.includes('codex')) return 'codex';
  if (path.includes('.grok') && path.includes('updates.jsonl')) return 'grok';
  if (path.includes('.codex') && path.includes('rollout-')) return 'codex';
  return null;
}
function grokModels(file) {
  const models = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (e) { continue; }
    const update = (entry && entry.params && entry.params.update) || {};
    if (update.sessionUpdate !== 'turn_completed') continue;
    const modelUsage = (update.usage && update.usage.modelUsage) || {};
    for (const key of Object.keys(modelUsage)) {
      const trimmed = key.trim();
      if (trimmed && models.indexOf(trimmed) === -1) models.push(trimmed);
    }
  }
  return models;
}
function codexModels(file) {
  const models = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (e) { continue; }
    if (!entry || entry.type !== 'turn_context') continue;
    const model = entry.payload && entry.payload.model;
    if (typeof model === 'string' && model.trim() && models.indexOf(model.trim()) === -1) {
      models.push(model.trim());
    }
  }
  return models;
}
function identity(cli, path) {
  const p = (path || '').trim();
  if (!p) return null;
  try { if (!fs.statSync(p).isFile()) return null; } catch (e) { return null; }
  const kind = sniffKind(cli, p);
  if (!kind) return null;
  let models = [];
  try { models = kind === 'grok' ? grokModels(p) : codexModels(p); } catch (e) { return null; }
  return models.length > 0 ? models[models.length - 1] : null;
}

const items = __ITEMS__;
const out = items.map(function (it) {
  return { id: it.id, model: identity(it.cli, it.path) };
});
process.stdout.write(JSON.stringify(out));
`;

/** Runs the transcript check for every candidate inside the app container in
 * one round trip. Returns, per attempt id, the model the transcript still
 * names, or null when it is unreachable/unrecognized/empty. */
function checkTranscripts(
  items: { id: string; cli: string | null; path: string | null }[],
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  if (items.length === 0) return result;
  const script = REMOTE_IDENTITY_SCRIPT.replace("__ITEMS__", JSON.stringify(items));
  const out = execFileSync(
    "ssh",
    ["-o", "ConnectTimeout=5", SSH_HOST, `docker exec -i ${APP_CONTAINER} node`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: script },
  );
  const parsed = JSON.parse(out.trim() || "[]") as { id: string; model: string | null }[];
  for (const row of parsed) result.set(row.id, row.model);
  return result;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function applyDowngrade(id: string): void {
  psql(`update execution_attempt set model_source = 'declared' where id = ${sqlString(id)};`);
}

function main() {
  const apply = process.argv.includes("--apply");
  const rowCount = assertRealProductionDb();
  const candidates = dumpCandidates();

  console.log(
    `# OCL-173 — backfill de model_source "measured" sem transcript alcançável (${apply ? "APLICANDO" : "SIMULAÇÃO — nada será gravado"})`,
  );
  console.log("");
  console.log(
    `Banco: container \`${DB_CONTAINER}\`, banco \`${DB_NAME}\`, host ${maskHost(SSH_HOST)}. execution_attempt tem ${rowCount} linhas.`,
  );
  console.log(`Attempts hoje marcados measured (candidatos): ${candidates.length}`);
  console.log("");

  if (candidates.length === 0) {
    console.log("Nenhum attempt measured para conferir. Nada a fazer.");
    return;
  }

  const items = candidates.map((c) => ({
    id: c.id,
    cli: c.transcript?.cli ?? null,
    path: c.transcript?.path ?? null,
  }));
  const transcriptModels = checkTranscripts(items);

  type Row = { attempt: AttemptRow; stillReachable: boolean; transcriptModel: string | null };
  const rows: Row[] = candidates.map((attempt) => {
    const transcriptModel = transcriptModels.get(attempt.id) ?? null;
    return { attempt, stillReachable: transcriptModel !== null, transcriptModel };
  });

  const keep = rows.filter((r) => r.stillReachable);
  const downgrade = rows.filter((r) => !r.stillReachable);

  console.log(`## Resumo`);
  console.log("");
  console.log(`- Continuam measured (transcript ainda alcançável e nomeia um modelo): ${keep.length}`);
  console.log(`- Rebaixados para declared (sem transcript alcançável): ${downgrade.length}`);
  console.log("");

  console.log(`## Rebaixados para declared (${downgrade.length})`);
  console.log("");
  console.log("| Card | attempt | modelo | cli do transcript | path do transcript |");
  console.log("|------|---------|--------|--------------------|----------------------|");
  for (const { attempt } of downgrade) {
    console.log(
      `| ${attempt.task_short_id} | ${attempt.id} | ${attempt.model ?? "null"} | ${attempt.transcript?.cli ?? "null"} | ${attempt.transcript?.path ?? "null"} |`,
    );
  }
  console.log("");

  if (keep.length > 0) {
    console.log(`## Continuam measured (${keep.length})`);
    console.log("");
    console.log("| Card | attempt | modelo | transcript ainda nomeia |");
    console.log("|------|---------|--------|---------------------------|");
    for (const { attempt, transcriptModel } of keep) {
      console.log(`| ${attempt.task_short_id} | ${attempt.id} | ${attempt.model ?? "null"} | ${transcriptModel} |`);
    }
    console.log("");
  }

  if (!apply) {
    console.log("Simulação apenas — nada foi gravado. Rode com --apply para escrever as mudanças acima.");
    return;
  }

  console.log("Gravando as mudanças...");
  for (const { attempt } of downgrade) {
    applyDowngrade(attempt.id);
    console.log(`- ${attempt.task_short_id} (${attempt.id}) -> model_source=declared`);
  }
  console.log("");
  console.log(`Concluído: ${downgrade.length} attempts rebaixados, ${keep.length} mantidos measured.`);
}

main();
