/**
 * OCL-165 — the `usage_suspect` mark is refreshed with the ceiling that
 * ignores cache read.
 *
 * usage_suspect and usage_suspect_reason are written once, at delivery time,
 * by usageGuardForAttempt (apps/web/src/mcp/tools.ts). OCL-161 changed
 * checkUsageWindow (packages/db/src/domain/usage-suspect.ts) to stop counting
 * cache reads toward the per-second ceiling, but that only changed the
 * verdict for deliveries that happen after the deploy — every attempt
 * finished before it still carries the old verdict. Measured after v0.3.7
 * shipped: the honesty note still says 314 suspects out of 1068 attempts,
 * practically the same 29% as before.
 *
 * This script recomputes only the WINDOW half of the mark: for every
 * finished attempt that has usage_segments, it reruns checkUsageWindow with
 * those segments and the window between started_at (claim time) and
 * finished_at (server_duration_ms when the server measured it directly,
 * which is the same precedence apps/web/src/mcp/tools.ts uses at delivery).
 * The "claim_window_exceeded" reason is added or removed based on that
 * result; any other reason already on the attempt — session_reused,
 * session_reused_orchestration — is neither this script's business nor
 * touched. An attempt keeps its old mark entirely when it has no
 * usage_segments: the flat tokens_cache counter merges read and write into
 * one bucket, so there is no honest way to tell which half it was.
 *
 * Usage:
 *   tsx scripts/ocl-165-backfill-usage-suspect-window.ts            # dry run (default)
 *   tsx scripts/ocl-165-backfill-usage-suspect-window.ts --apply    # writes to prod
 */
import { execFileSync } from "node:child_process";

import { checkUsageWindow } from "../packages/db/src/domain/usage-suspect";
import type { UsageSegment } from "../packages/db/src/domain/usage";

const SSH_HOST = "gt40"; // alias from ~/.ssh/config — never the real address
const CONTAINER = "overclick-overclick-db-1";
const DB_USER = "overclick";
const DB_NAME = "overclick";

const WINDOW_REASON = "claim_window_exceeded";

type AttemptRow = {
  id: string;
  task_short_id: string;
  usage_segments: UsageSegment[] | null;
  started_at: string;
  finished_at: string;
  server_duration_ms: number | null;
  usage_suspect: boolean;
  usage_suspect_reason: string | null;
};

/** Same stdin transport as OCL-155/156/160: a `-c` argument gets re-parsed by
 * the remote shell, which corrupts any query carrying double quotes — an
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

/** Same safety check OCL-153/155/160 use: refuse to touch anything that is not the real production database. */
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

/** Every finished attempt carrying at least one usage segment. Attempts with
 * only the legacy flat counters are left out entirely: this script has
 * nothing honest to say about them. */
function dumpCandidates(): AttemptRow[] {
  const query = `
select json_agg(row_to_json(t)) from (
  select
    ea.id, t.short_id as task_short_id, ea.usage_segments, ea.started_at,
    ea.finished_at, ea.server_duration_ms, ea.usage_suspect, ea.usage_suspect_reason
  from execution_attempt ea
  join task t on t.id = ea.task_id
  where ea.finished_at is not null
    and jsonb_array_length(coalesce(ea.usage_segments, '[]'::jsonb)) > 0
  order by ea.started_at asc
) t;`;
  const out = psql(query);
  return (JSON.parse(out.trim() || "null") ?? []) as AttemptRow[];
}

/** Count of finished attempts with no usage_segments — never touched by this
 * script, reported only so the simulation output is legible against the
 * total the honesty note counts. */
function countNoSegments(): number {
  const out = psql(`
select count(*) from execution_attempt ea
where ea.finished_at is not null
  and jsonb_array_length(coalesce(ea.usage_segments, '[]'::jsonb)) = 0;`);
  return Number.parseInt(out.trim(), 10);
}

function splitReasons(reason: string | null): string[] {
  return (reason ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Same measuredWindowMs precedence apps/web/src/mcp/tools.ts uses at
 * delivery: the server-measured duration when it exists, else the wall clock
 * between claim (started_at) and finish. */
function measuredWindowMs(attempt: AttemptRow): number {
  if (attempt.server_duration_ms != null) return attempt.server_duration_ms;
  const started = Date.parse(attempt.started_at);
  const finished = Date.parse(attempt.finished_at);
  return Math.max(0, finished - started);
}

/** Rebuilds the reason list with the window verdict recomputed and every
 * other existing reason (session_reused, session_reused_orchestration)
 * carried over untouched, in the same order usageGuardForAttempt writes them
 * at delivery: window first, then session reuse reasons. */
function recomputeReasons(existing: string[], windowSuspect: boolean): string[] {
  const others = existing.filter((r) => r !== WINDOW_REASON);
  return windowSuspect ? [WINDOW_REASON, ...others] : others;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function applyUpdate(attempt: AttemptRow, suspect: boolean, reason: string | null): void {
  const setParts = [
    `usage_suspect = ${suspect ? "true" : "false"}`,
    reason ? `usage_suspect_reason = ${sqlString(reason)}` : "usage_suspect_reason = null",
  ];
  psql(`update execution_attempt set ${setParts.join(", ")} where id = '${attempt.id}';`);
}

function main() {
  const apply = process.argv.includes("--apply");
  const rowCount = assertRealProductionDb();
  const candidates = dumpCandidates();
  const noSegmentsCount = countNoSegments();

  console.log(`# OCL-165 — backfill de usage_suspect com a régua sem cache read (${apply ? "APLICANDO" : "SIMULAÇÃO — nada será gravado"})`);
  console.log("");
  console.log(`Banco: container \`${CONTAINER}\`, banco \`${DB_NAME}\`, host ${maskHost(SSH_HOST)}. execution_attempt tem ${rowCount} linhas.`);
  console.log(`Attempts finalizados com usage_segments (candidatos): ${candidates.length}`);
  console.log(`Attempts finalizados sem usage_segments (fora de escopo, marca mantida): ${noSegmentsCount}`);
  console.log("");

  type Row = {
    attempt: AttemptRow;
    newSuspect: boolean;
    newReason: string | null;
    changed: boolean;
    movedOut: boolean;
    movedIn: boolean;
  };
  const rows: Row[] = [];

  for (const attempt of candidates) {
    const window = checkUsageWindow({ segments: attempt.usage_segments ?? [] }, measuredWindowMs(attempt));
    const existing = splitReasons(attempt.usage_suspect_reason);
    const newReasons = recomputeReasons(existing, window.suspect);
    const newSuspect = newReasons.length > 0;
    const newReason = newReasons.length > 0 ? newReasons.join(",") : null;

    const oldSuspect = attempt.usage_suspect;
    const oldReason = attempt.usage_suspect_reason;
    const changed = oldSuspect !== newSuspect || oldReason !== newReason;
    const movedOut = oldSuspect && !newSuspect;
    const movedIn = !oldSuspect && newSuspect;

    rows.push({ attempt, newSuspect, newReason, changed, movedOut, movedIn });
  }

  const toFix = rows.filter((r) => r.changed);
  const movedOut = rows.filter((r) => r.movedOut);
  const movedIn = rows.filter((r) => r.movedIn);
  const reasonOnlyChanged = toFix.filter((r) => !r.movedOut && !r.movedIn);

  console.log(`## Resumo`);
  console.log("");
  console.log(`- Deixam de ser suspeitos: ${movedOut.length}`);
  console.log(`- Passam a ser suspeitos: ${movedIn.length}`);
  console.log(`- Continuam suspeitos, mas o motivo muda (ex.: perdem claim_window_exceeded e sobra session_reused): ${reasonOnlyChanged.length}`);
  console.log(`- Sem mudança nenhuma: ${rows.length - toFix.length}`);
  console.log("");

  console.log(`## Deixam de ser suspeitos (${movedOut.length})`);
  console.log("");
  console.log("| Card | attempt | motivo antes | motivo depois |");
  console.log("|------|---------|---------------|----------------|");
  for (const { attempt, newReason } of movedOut) {
    console.log(`| ${attempt.task_short_id} | ${attempt.id} | ${attempt.usage_suspect_reason ?? "null"} | ${newReason ?? "null"} |`);
  }
  console.log("");

  console.log(`## Passam a ser suspeitos (${movedIn.length})`);
  console.log("");
  console.log("| Card | attempt | motivo antes | motivo depois |");
  console.log("|------|---------|---------------|----------------|");
  for (const { attempt, newReason } of movedIn) {
    console.log(`| ${attempt.task_short_id} | ${attempt.id} | ${attempt.usage_suspect_reason ?? "null"} | ${newReason ?? "null"} |`);
  }
  console.log("");

  if (reasonOnlyChanged.length > 0) {
    console.log(`## Continuam suspeitos, motivo muda (${reasonOnlyChanged.length})`);
    console.log("");
    console.log("| Card | attempt | motivo antes | motivo depois |");
    console.log("|------|---------|---------------|----------------|");
    for (const { attempt, newReason } of reasonOnlyChanged) {
      console.log(`| ${attempt.task_short_id} | ${attempt.id} | ${attempt.usage_suspect_reason ?? "null"} | ${newReason ?? "null"} |`);
    }
    console.log("");
  }

  if (!apply) {
    console.log("Simulação apenas — nada foi gravado. Rode com --apply para escrever as mudanças acima.");
    return;
  }

  console.log("Gravando as mudanças...");
  for (const { attempt, newSuspect, newReason } of toFix) {
    applyUpdate(attempt, newSuspect, newReason);
    console.log(`- ${attempt.task_short_id} (${attempt.id}) -> usage_suspect=${newSuspect}, usage_suspect_reason=${newReason ?? "null"}`);
  }
  console.log("");
  console.log(`Concluído: ${toFix.length} attempts regravados, ${rows.length - toFix.length} sem mudança.`);
}

main();
