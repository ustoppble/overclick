/**
 * OCL-166 — the `usage_suspect` mark from session reuse only applies when
 * execution windows overlap.
 *
 * usage_suspect and usage_suspect_reason are written once, at delivery time,
 * by usageGuardForAttempt (apps/web/src/mcp/tools.ts). Before this card, the
 * session_reused component fired whenever ANY other finished attempt shared
 * the same session_id, with no regard for whether the two execution windows
 * ever actually touched. The usage recipe counts from each card's own
 * claimed_at, so two cards worked back to back by the same session measure
 * disjoint stretches of work and cannot double-count anything — only an
 * actual overlap can. Measured in production on 2026-09-01: of 293 attempts
 * carrying the session_reused component, only 112 have a window that truly
 * crosses another attempt of the same session.
 *
 * This script recomputes only the SESSION-REUSE half of the mark: for every
 * finished attempt that has a session_id, it looks at every other finished
 * attempt in the same workspace and session (excluding attempts of the same
 * task — those are re-executions of the same card, not reuse across cards)
 * and checks interval overlap: started_at < other.finished_at AND
 * other.started_at < finished_at. When at least one overlaps, the attempt
 * gets `session_reused:<id1>+<id2>...` naming every attempt it overlaps
 * with; otherwise the session_reused component is dropped. Because the old
 * rule never marked the earlier side of a pair retroactively, this backfill
 * can both remove the mark from disjoint pairs AND add it to a first
 * attempt that overlaps a later one and had never been touched before.
 * claim_window_exceeded and session_reused_orchestration are carried over
 * untouched — orchestration reuse is out of scope, the overlap there is the
 * rule rather than the exception.
 *
 * Usage:
 *   tsx scripts/ocl-166-backfill-usage-suspect-overlap.ts            # dry run (default)
 *   tsx scripts/ocl-166-backfill-usage-suspect-overlap.ts --apply    # writes to prod
 */
import { execFileSync } from "node:child_process";

const SSH_HOST = "gt40"; // alias from ~/.ssh/config — never the real address
const CONTAINER = "overclick-overclick-db-1";
const DB_USER = "overclick";
const DB_NAME = "overclick";

type AttemptRow = {
  id: string;
  task_id: string;
  task_short_id: string;
  workspace_id: string;
  session_id: string;
  started_at: string;
  finished_at: string;
  usage_suspect: boolean;
  usage_suspect_reason: string | null;
};

/** Same stdin transport as OCL-155/156/160/165: a `-c` argument gets
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

/** Same safety check OCL-153/155/160/165 use: refuse to touch anything that is not the real production database. */
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

/** Every finished attempt that carries a session_id — the only population
 * the session-reuse component can ever apply to. Attempts with no
 * session_id are out of scope entirely, in both the old and new rule. */
function dumpCandidates(): AttemptRow[] {
  const query = `
select json_agg(row_to_json(t)) from (
  select
    ea.id, ea.task_id, t.short_id as task_short_id, p.workspace_id,
    ea.session_id, ea.started_at, ea.finished_at,
    ea.usage_suspect, ea.usage_suspect_reason
  from execution_attempt ea
  join task t on t.id = ea.task_id
  join project p on p.id = t.project_id
  where ea.finished_at is not null
    and ea.session_id is not null
  order by ea.started_at asc
) t;`;
  const out = psql(query);
  return (JSON.parse(out.trim() || "null") ?? []) as AttemptRow[];
}

function splitReasons(reason: string | null): string[] {
  return (reason ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isSessionReusedToken(token: string): boolean {
  return token === "session_reused" || token.startsWith("session_reused:");
}

/** Rebuilds the reason list with the session-reuse verdict recomputed and
 * every other existing reason (claim_window_exceeded, from OCL-165;
 * session_reused_orchestration) carried over untouched, in the same order
 * usageGuardForAttempt writes them at delivery: window, session reuse,
 * orchestration reuse. */
function recomputeReasons(existing: string[], overlappingIds: string[]): string[] {
  const hasWindow = existing.includes("claim_window_exceeded");
  const hasOrchestration = existing.includes("session_reused_orchestration");
  const reasons: string[] = [];
  if (hasWindow) reasons.push("claim_window_exceeded");
  if (overlappingIds.length > 0) reasons.push(`session_reused:${overlappingIds.join("+")}`);
  if (hasOrchestration) reasons.push("session_reused_orchestration");
  return reasons;
}

function overlaps(a: AttemptRow, b: AttemptRow): boolean {
  const aStart = Date.parse(a.started_at);
  const aEnd = Date.parse(a.finished_at);
  const bStart = Date.parse(b.started_at);
  const bEnd = Date.parse(b.finished_at);
  return bStart < aEnd && aStart < bEnd;
}

/** Every other finished attempt in the same workspace + session, excluding
 * attempts of the same task (re-executions of the same card, not reuse
 * across cards) — the same exclusion usageGuardForAttempt applies. */
function overlappingAttempts(attempt: AttemptRow, group: AttemptRow[]): AttemptRow[] {
  return group.filter((other) => other.id !== attempt.id && other.task_id !== attempt.task_id && overlaps(attempt, other));
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

  // Group by workspace + session: overlap only matters within the same
  // workspace's session id, same as the app's query scopes by project.workspaceId.
  const groups = new Map<string, AttemptRow[]>();
  for (const attempt of candidates) {
    const key = `${attempt.workspace_id}::${attempt.session_id}`;
    const list = groups.get(key) ?? [];
    list.push(attempt);
    groups.set(key, list);
  }

  console.log(`# OCL-166 — backfill de usage_suspect com a régua de sobreposição de janela (${apply ? "APLICANDO" : "SIMULAÇÃO — nada será gravado"})`);
  console.log("");
  console.log(`Banco: container \`${CONTAINER}\`, banco \`${DB_NAME}\`, host ${maskHost(SSH_HOST)}. execution_attempt tem ${rowCount} linhas.`);
  console.log(`Attempts finalizados com session_id (candidatos): ${candidates.length}`);
  console.log(`Sessões distintas (workspace + session_id): ${groups.size}`);
  console.log("");

  type Row = {
    attempt: AttemptRow;
    newSuspect: boolean;
    newReason: string | null;
    overlappingIds: string[];
    changed: boolean;
    movedOut: boolean;
    movedIn: boolean;
  };
  const rows: Row[] = [];

  for (const attempt of candidates) {
    const group = groups.get(`${attempt.workspace_id}::${attempt.session_id}`) ?? [];
    const overlappingIds = overlappingAttempts(attempt, group).map((o) => o.id);
    const existing = splitReasons(attempt.usage_suspect_reason);
    const existingWithoutSessionReuse = existing.filter((token) => !isSessionReusedToken(token));
    const newReasons = recomputeReasons(existingWithoutSessionReuse, overlappingIds);
    const newSuspect = newReasons.length > 0;
    const newReason = newReasons.length > 0 ? newReasons.join(",") : null;

    const oldSuspect = attempt.usage_suspect;
    const oldReason = attempt.usage_suspect_reason;
    const changed = oldSuspect !== newSuspect || oldReason !== newReason;
    const movedOut = oldSuspect && !newSuspect;
    const movedIn = !oldSuspect && newSuspect;

    rows.push({ attempt, newSuspect, newReason, overlappingIds, changed, movedOut, movedIn });
  }

  const toFix = rows.filter((r) => r.changed);
  const movedOut = rows.filter((r) => r.movedOut);
  const movedIn = rows.filter((r) => r.movedIn);
  const reasonOnlyChanged = toFix.filter((r) => !r.movedOut && !r.movedIn);
  const stillOverlapping = rows.filter((r) => r.overlappingIds.length > 0);

  console.log(`## Resumo`);
  console.log("");
  console.log(`- Deixam de ser suspeitos: ${movedOut.length}`);
  console.log(`- Passam a ser suspeitos (janela cruza e nunca tinha sido marcado — ex.: o lado "primeiro" de um par que se cruza): ${movedIn.length}`);
  console.log(`- Continuam suspeitos, mas o motivo muda: ${reasonOnlyChanged.length}`);
  console.log(`- Sem mudança nenhuma: ${rows.length - toFix.length}`);
  console.log(`- Attempts cuja janela de fato cruza outro attempt da mesma sessão (novo total session_reused): ${stillOverlapping.length}`);
  console.log("");

  console.log(`## Deixam de ser suspeitos por reuso de sessão (${movedOut.length})`);
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
