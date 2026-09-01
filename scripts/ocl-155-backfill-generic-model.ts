/**
 * OCL-155 — attempts declared with a generic model name get the real model
 * their own transcript recorded.
 *
 * Scope, evidence-based (see task_get OCL-155 + the human's scope amendment):
 *  - "gpt-5": the generic Codex agents label. A scan of 1350 local Codex
 *    rollouts found gpt-5.6-sol/luna/terra, gpt-5.3-codex-spark and
 *    gpt-daybreak-blue-latest on disk, and zero sessions actually recorded as
 *    "gpt-5". 9 attempts carry "gpt-5" inside a usage_segments entry (only 1
 *    of those 9 also has it on the attempt-level model column — the rest
 *    already have the right model there, just one early segment slipped
 *    through before Codex's turn_context line named the real model).
 *  - "grok-4": xAI's models page (docs.x.ai, read 2026-09-01) no longer lists
 *    grok-4 or grok-4-fast; the board's own grok-4-6 (104 attempts) is what
 *    replaced it. 2 attempts carry "grok-4".
 *
 * For each candidate this script opens the transcript the board already
 * points to and looks for the ONE real model the session actually ran:
 *  - Codex: distinct `turn_context.payload.model` values across the rollout.
 *  - Grok: distinct keys of `usage.modelUsage` across turn_completed updates.
 * Exactly one distinct value → that is the real model, and it replaces the
 * generic label everywhere it appears (attempt.model AND every matching
 * usage_segments entry, never just one of the two). Zero, more than one, or
 * an unreachable transcript → the attempt is left untouched and reported as
 * unresolved. No attempt ever receives a model by guessing, and no price row
 * is invented for a resolved model that still has none (that is a pricing
 * decision, out of scope here — see OCL-156).
 *
 * Usage:
 *   tsx scripts/ocl-155-backfill-generic-model.ts            # dry run (default)
 *   tsx scripts/ocl-155-backfill-generic-model.ts --apply    # writes to prod
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SSH_HOST = "gt40"; // alias from ~/.ssh/config — never the real address
const CONTAINER = "overclick-overclick-db-1";
const DB_USER = "overclick";
const DB_NAME = "overclick";

/** The generic labels this card is scoped to fix. Compared trim+lowercased. */
const GENERIC_MODELS = new Set(["gpt-5", "grok-4"]);

type Segment = { model: string | null; [key: string]: unknown };

type AttemptRow = {
  id: string;
  task_short_id: string;
  model: string | null;
  model_source: string | null;
  transcript: { cli: string | null; path: string | null; sessionId: string | null } | null;
  usage_segments: Segment[] | null;
};

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Runs `query` through psql over SSH, piping it via stdin instead of a `-c`
 * command-line argument. A `-c` string travels through the remote shell's own
 * quoting before psql ever sees it, which corrupts any query that itself
 * contains double quotes — exactly what a JSON literal in an UPDATE does.
 * Stdin has no such second parsing pass.
 */
function psql(query: string): string {
  return execFileSync(
    "ssh",
    ["-o", "ConnectTimeout=5", SSH_HOST, `docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A -v ON_ERROR_STOP=1`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: query },
  );
}

function maskHost(hostAlias: string): string {
  return `SSH alias "${hostAlias}" (real address never printed)`;
}

/** Same safety check OCL-153 uses: refuse to touch anything that is not the real production database. */
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

function isGeneric(model: string | null | undefined): boolean {
  if (!model) return false;
  return GENERIC_MODELS.has(model.trim().toLowerCase());
}

function dumpCandidates(): AttemptRow[] {
  const genericList = [...GENERIC_MODELS].map((m) => `'${m}'`).join(", ");
  const query = `
select json_agg(row_to_json(t)) from (
  select ea.id, t.short_id as task_short_id, ea.model, ea.model_source, ea.transcript, ea.usage_segments
  from execution_attempt ea
  join task t on t.id = ea.task_id
  where lower(trim(ea.model)) in (${genericList})
     or exists (
       select 1 from jsonb_array_elements(coalesce(ea.usage_segments, '[]'::jsonb)) seg
       where lower(trim(seg->>'model')) in (${genericList})
     )
  order by ea.started_at asc
) t;`;
  const out = psql(query);
  const parsed = JSON.parse(out.trim());
  return (parsed ?? []) as AttemptRow[];
}

function readLines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n");
}

function parseJsonLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

type Resolution = { status: "resolved"; model: string; via: string } | { status: "unresolved"; reason: string };

/** Every rollout under ~/.codex/sessions whose first line's session id matches. */
function findCodexRolloutBySession(session: string): string | null {
  const root = path.join(process.env.HOME ?? "", ".codex", "sessions");
  function walk(dir: string): string[] {
    let entries: string[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return entries;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) entries = entries.concat(walk(full));
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) entries.push(full);
    }
    return entries;
  }
  for (const candidate of walk(root)) {
    if (path.basename(candidate).includes(session)) return candidate;
    const first = parseJsonLine(readLines(candidate)[0] ?? "");
    const payload = first?.payload ?? {};
    if (payload.id === session || payload.session_id === session) return candidate;
  }
  return null;
}

/** A session id worth searching for is a Codex-shaped UUID, never a human-typed placeholder like "session". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveTranscriptPath(attempt: AttemptRow): { file: string; kind: "codex" | "grok" } | { unresolved: string } {
  const rawPath = attempt.transcript?.path ?? null;
  if (rawPath) {
    if (!existsSync(rawPath)) return { unresolved: `arquivo não encontrado nesta máquina: ${rawPath}` };
    if (statSync(rawPath).isDirectory()) return { unresolved: `transcript.path é um diretório: ${rawPath}` };
    // Sniff by path shape rather than trusting transcript.cli: one grok-4
    // attempt has transcript.cli = "kimi" while its path is plainly a Grok
    // ~/.grok/sessions/.../updates.jsonl file.
    if (rawPath.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`)) return { file: rawPath, kind: "codex" };
    if (rawPath.includes(`${path.sep}.grok${path.sep}sessions${path.sep}`)) return { file: rawPath, kind: "grok" };
    return { unresolved: `transcript.path não é um rollout Codex nem uma sessão Grok reconhecível: ${rawPath}` };
  }
  const session = attempt.transcript?.sessionId ?? null;
  if (session && UUID_RE.test(session)) {
    const found = findCodexRolloutBySession(session);
    if (found) return { file: found, kind: "codex" };
    return { unresolved: `session id ${session} não bateu com nenhum rollout em ~/.codex/sessions` };
  }
  return {
    unresolved: session
      ? `transcript.path nulo e session id "${session}" é um placeholder de claim, não um id rastreável`
      : "transcript.path e session id ambos nulos",
  };
}

function realModelsInCodexRollout(file: string): string[] {
  const models = new Set<string>();
  for (const line of readLines(file)) {
    const entry = parseJsonLine(line);
    if (entry?.type !== "turn_context") continue;
    const model = entry.payload?.model;
    if (typeof model === "string" && model.trim()) models.add(model.trim());
  }
  return [...models];
}

function realModelsInGrokTranscript(file: string): string[] {
  const models = new Set<string>();
  for (const line of readLines(file)) {
    const entry = parseJsonLine(line);
    const update = entry?.params?.update ?? {};
    if (update.sessionUpdate !== "turn_completed") continue;
    const perModel = update.usage?.modelUsage ?? {};
    for (const key of Object.keys(perModel)) {
      if (key.trim()) models.add(key.trim());
    }
  }
  return [...models];
}

function resolveRealModel(attempt: AttemptRow): Resolution {
  const located = resolveTranscriptPath(attempt);
  if ("unresolved" in located) return { status: "unresolved", reason: located.unresolved };

  const models = located.kind === "codex" ? realModelsInCodexRollout(located.file) : realModelsInGrokTranscript(located.file);
  if (models.length === 0) {
    return {
      status: "unresolved",
      reason:
        located.kind === "codex"
          ? `rollout sem nenhuma linha turn_context com model: ${located.file}`
          : `sessão sem nenhum turn_completed com usage.modelUsage: ${located.file}`,
    };
  }
  if (models.length > 1) {
    return { status: "unresolved", reason: `sessão trocou de modelo (${models.join(", ")}) — ambíguo demais para atribuir sem chutar: ${located.file}` };
  }
  const [only] = models;
  if (isGeneric(only)) {
    return { status: "unresolved", reason: `o transcript confirma que o modelo real É "${only}" — não é um rótulo genérico errado, é um modelo sem preço publicado: ${located.file}` };
  }
  return { status: "resolved", model: only, via: located.file };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function applyFix(attempt: AttemptRow, realModel: string): void {
  const newModel = isGeneric(attempt.model) ? realModel : attempt.model;
  const newModelSource = isGeneric(attempt.model) ? "measured" : attempt.model_source;
  const newSegments = (attempt.usage_segments ?? []).map((segment) =>
    isGeneric(segment.model) ? { ...segment, model: realModel } : segment,
  );

  const setParts = [`model = ${sqlString(newModel ?? realModel)}`];
  if (newModelSource) setParts.push(`model_source = ${sqlString(newModelSource)}`);
  const segmentsJson = JSON.stringify(newSegments).replace(/\\/g, "\\\\");
  setParts.push(`usage_segments = '${segmentsJson.replace(/'/g, "''")}'::jsonb`);

  const query = `update execution_attempt set ${setParts.join(", ")} where id = '${attempt.id}';`;
  psql(query);
}

function main() {
  const apply = process.argv.includes("--apply");
  const rowCount = assertRealProductionDb();
  const candidates = dumpCandidates();

  console.log(`# OCL-155 — backfill de modelo genérico (${apply ? "APLICANDO" : "SIMULAÇÃO — nada será gravado"})`);
  console.log("");
  console.log(`Banco: container \`${CONTAINER}\`, banco \`${DB_NAME}\`, host ${maskHost(SSH_HOST)}. execution_attempt tem ${rowCount} linhas.`);
  console.log(`Candidatos encontrados (modelo do attempt OU de algum segment em ${[...GENERIC_MODELS].join(", ")}): ${candidates.length}`);
  console.log("");

  const resolved: { attempt: AttemptRow; model: string; via: string }[] = [];
  const unresolved: { attempt: AttemptRow; reason: string }[] = [];

  for (const attempt of candidates) {
    const resolution = resolveRealModel(attempt);
    if (resolution.status === "resolved") {
      resolved.push({ attempt, model: resolution.model, via: resolution.via });
    } else {
      unresolved.push({ attempt, reason: resolution.reason });
    }
  }

  console.log(`## Resolvidos (${resolved.length})`);
  console.log("");
  console.log("| Card | attempt | modelo atual (attempt) | segments genéricos | modelo real | lido de |");
  console.log("|------|---------|-------------------------|---------------------|-------------|---------|");
  for (const { attempt, model, via } of resolved) {
    const genericSegCount = (attempt.usage_segments ?? []).filter((s) => isGeneric(s.model)).length;
    console.log(
      `| ${attempt.task_short_id} | ${attempt.id} | ${attempt.model ?? "?"} | ${genericSegCount} | ${model} | ${via} |`,
    );
  }
  console.log("");

  console.log(`## Não resolvidos (${unresolved.length})`);
  console.log("");
  console.log("| Card | attempt | modelo atual (attempt) | motivo |");
  console.log("|------|---------|-------------------------|--------|");
  for (const { attempt, reason } of unresolved) {
    console.log(`| ${attempt.task_short_id} | ${attempt.id} | ${attempt.model ?? "?"} | ${reason} |`);
  }
  console.log("");

  if (!apply) {
    console.log("Simulação apenas — nada foi gravado. Rode com --apply para escrever os resolvidos acima.");
    return;
  }

  console.log("Gravando os resolvidos...");
  for (const { attempt, model } of resolved) {
    applyFix(attempt, model);
    console.log(`- ${attempt.task_short_id} (${attempt.id}) -> ${model}`);
  }
  console.log("");
  console.log(`Concluído: ${resolved.length} attempts corrigidos, ${unresolved.length} continuam sem modelo real identificável.`);
}

main();
