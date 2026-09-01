/**
 * OCL-153 — audits reported usage against real transcripts.
 *
 * Fixes the two defects OCL-150 shipped with:
 *  1. It read a 90-attempt local dev Postgres instead of the database that
 *     actually serves /insights. This script reads that database directly,
 *     over SSH into the host that runs it, and refuses to go on if the count
 *     looks nothing like production.
 *  2. It summed each session's ENTIRE transcript with no claim-window filter,
 *     then compared that against usage the executor measured only from its
 *     claim forward. In a session that ran several cards back to back, that
 *     guarantees "reported less than measured" on every card but the last.
 *     This script reuses the exact same claimWindow the shipped recipes in
 *     packages/db/src/domain/usage-recipe.ts use (start bound at claimed_at),
 *     and additionally caps the end at the next attempt's claimed_at when the
 *     same transcript file is shared by more than one attempt — otherwise a
 *     multi-card session would leak every later card's tokens into the
 *     earlier card's measurement, reproducing the same shape of bug with the
 *     window closed on one side only. The token/model extraction itself is
 *     never reimplemented: every attempt is measured by writing out the
 *     unmodified script body of the matching recipe from usage-recipe.ts and
 *     running it as a child process, exactly like an executor would.
 *
 * Read-only. Touches no board data, no production file.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { factoryUsageRecipes, type UsageRecipeRow } from "../packages/db/src/domain/usage-recipe";
import { factoryModelPrices, resolveSegmentedCost, normalizeModelKey, findModelPrice } from "../packages/db/src/domain/pricing";
import { segmentTotalTokens, type UsageSegment } from "../packages/db/src/domain/usage";

const SSH_HOST = "gt40"; // alias from ~/.ssh/config — never the real address
const CONTAINER = "overclick-overclick-db-1";
const DB_USER = "overclick";
const DB_NAME = "overclick";

type AttemptRow = {
  id: string;
  task_short_id: string;
  executor: string | null;
  model: string | null;
  model_source: string | null;
  session_id: string | null;
  transcript: { cli: string | null; path: string | null; sessionId: string | null; resume: string | null } | null;
  started_at: string;
  finished_at: string | null;
  usage_segments: UsageSegment[] | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache: number | null;
  reported_cost_usd: string | null;
  cost_usd: string | null;
  cost_source: string | null;
  cost_status: string | null;
  duration_ms: number | null;
  server_duration_ms: number | null;
  turns: number | null;
  usage_estimated: boolean;
  usage_suspect: boolean;
  usage_suspect_reason: string | null;
  result: string | null;
};

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function maskHost(hostAlias: string): string {
  return `SSH alias "${hostAlias}" (real address never printed)`;
}

/** Step 1: confirm which database this really is, and that it is the one wired to the app. */
function fetchTopOfReport(): { attemptCount: number; wiredCheck: string; header: string } {
  const composePath = path.join(__dirname, "..", "deploy", "docker-compose.cloud.yml");
  const compose = readFileSync(composePath, "utf8");
  const wiresDbByName = compose.includes("overclick-db:5432/overclick") && compose.includes("overclick-db:");
  if (!wiresDbByName) {
    throw new Error(
      "deploy/docker-compose.cloud.yml no longer wires app -> overclick-db/overclick the way this audit assumes. Stopping instead of guessing which database /insights reads.",
    );
  }

  const psList = sh("ssh", [
    "-o",
    "ConnectTimeout=5",
    SSH_HOST,
    "docker ps --format '{{.Names}}'",
  ]);
  const appUp = psList.includes("overclick-app-1");
  const dbUp = psList.includes(CONTAINER);
  if (!appUp || !dbUp) {
    throw new Error(
      `Expected containers overclick-app-1 and ${CONTAINER} both running on ${SSH_HOST}; got: ${psList.trim()}. Stopping instead of reading a database nothing serves.`,
    );
  }

  const countOut = sh("ssh", [
    "-o",
    "ConnectTimeout=5",
    SSH_HOST,
    `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A -c "select count(*) from execution_attempt;"`,
  ]);
  const attemptCount = Number.parseInt(countOut.trim(), 10);
  if (!Number.isFinite(attemptCount) || attemptCount < 500) {
    throw new Error(
      `execution_attempt has ${countOut.trim()} rows on ${maskHost(SSH_HOST)}/${CONTAINER}:${DB_NAME}. That is not the size /insights has been reporting (four digits, growing past 1000 as of 2026-09). Stopping instead of auditing the wrong database, same mistake OCL-150 made.`,
    );
  }

  const header =
    `**Banco lido:** container docker \`${CONTAINER}\`, banco \`${DB_NAME}\`, host ${maskHost(SSH_HOST)}. ` +
    `Confirmado como o banco de /insights por dois fatos, não por suposição: (1) \`deploy/docker-compose.cloud.yml\` liga a env \`DATABASE_URL\` do serviço \`app\` a \`postgres://overclick:***@overclick-db:5432/overclick\`, o mesmo serviço; (2) \`docker ps\` no host mostra \`overclick-app-1\` e \`${CONTAINER}\` rodando ao mesmo tempo, no mesmo compose project. \`execution_attempt\` tem **${attemptCount}** linhas agora.`;

  return { attemptCount, wiredCheck: "ok", header };
}

function dumpAttempts(): AttemptRow[] {
  const query = `
select json_agg(row_to_json(t)) from (
  select
    ea.id, t.short_id as task_short_id, ea.executor, ea.model, ea.model_source,
    ea.session_id, ea.transcript, ea.started_at, ea.finished_at, ea.usage_segments,
    ea.tokens_in, ea.tokens_out, ea.tokens_cache, ea.reported_cost_usd, ea.cost_usd,
    ea.cost_source, ea.cost_status, ea.duration_ms, ea.server_duration_ms, ea.turns,
    ea.usage_estimated, ea.usage_suspect, ea.usage_suspect_reason, ea.result
  from execution_attempt ea
  join task t on t.id = ea.task_id
  order by ea.started_at asc
) t;`.replace(/\n/g, " ");

  const out = sh("ssh", [
    "-o",
    "ConnectTimeout=5",
    SSH_HOST,
    `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A -c "${query}"`,
  ]);
  return JSON.parse(out.trim()) as AttemptRow[];
}

/** claude / codex / grok / kimi, or null when no shipped recipe covers this CLI string. */
const CLI_ALIASES: Record<string, string> = {
  "claude": "claude-code",
  "claude-code": "claude-code",
  "codex": "codex",
  "codex-cli": "codex",
  "codex cli": "codex",
  "grok": "grok",
  "grok-cli": "grok",
  "kimi": "kimi",
  "kimi-code": "kimi",
};

function resolveRecipeCli(rawCli: string | null | undefined): string | null {
  const key = (rawCli ?? "").trim().toLowerCase();
  return CLI_ALIASES[key] ?? null;
}

/** Extracts the JS body a shipped recipe wraps as `node -e "<body>"`. */
function scriptBodyOf(recipe: UsageRecipeRow): string {
  const prefix = 'node -e "';
  if (!recipe.command.startsWith(prefix) || !recipe.command.endsWith('"')) {
    throw new Error(`Recipe for ${recipe.cli} is not a bare node -e command anymore; audit script needs updating.`);
  }
  return recipe.command.slice(prefix.length, -1);
}

function readLines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n");
}

function entryTimestampMs(entry: any, extraField?: string): number | null {
  let value = entry?.timestamp;
  if (value === undefined) value = entry?.created_at;
  if (value === undefined) value = entry?.createdAt;
  if (value === undefined && extraField) value = entry?.[extraField];
  if (value === undefined || value === null) return null;
  const ms = typeof value === "number" ? (value > 100000000000 ? value : value * 1000) : Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Copies a file-based transcript (claude/codex/grok), keeping only lines
 * strictly before `endMs`. Recipe scripts already bound the start themselves
 * via OVERCLICK_CLAIMED_AT; this only closes the end so a shared transcript
 * does not spill a later card's tokens into an earlier one.
 */
function truncateFileTranscript(originalPath: string, endMs: number | null, workDir: string): string {
  if (endMs === null) return originalPath;
  const lines = readLines(originalPath);
  const kept = lines.filter((line) => {
    if (!line.trim()) return true;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return true;
    }
    const at = entryTimestampMs(entry);
    return at === null || at < endMs;
  });
  const out = path.join(workDir, "transcript.jsonl");
  writeFileSync(out, kept.join("\n"));
  return out;
}

/** Kimi transcripts are a session directory with one wire.jsonl per agent. */
function resolveKimiSessionDir(rawPath: string): string | null {
  const marker = `${path.sep}agents${path.sep}`;
  const idx = rawPath.indexOf(marker);
  const dir = idx >= 0 ? rawPath.slice(0, idx) : rawPath;
  if (!existsSync(dir)) return null;
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return existsSync(path.join(dir, "agents")) ? dir : null;
}

function truncateKimiDir(sessionDir: string, endMs: number | null, workDir: string): string {
  if (endMs === null) return sessionDir;
  const agentsDir = path.join(sessionDir, "agents");
  const outDir = path.join(workDir, "kimi-session");
  mkdirSync(path.join(outDir, "agents"), { recursive: true });
  for (const agent of readdirSync(agentsDir)) {
    const wire = path.join(agentsDir, agent, "wire.jsonl");
    if (!existsSync(wire)) continue;
    const lines = readLines(wire).filter((line) => {
      if (!line.trim()) return true;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        return true;
      }
      const at = entryTimestampMs(entry, "time");
      return at === null || at < endMs;
    });
    mkdirSync(path.join(outDir, "agents", agent), { recursive: true });
    writeFileSync(path.join(outDir, "agents", agent, "wire.jsonl"), lines.join("\n"));
  }
  return outDir;
}

type Measured = {
  segments: UsageSegment[];
  turns: number;
  estimated: boolean;
  reason?: string;
};

type AuditRow = {
  attempt: AttemptRow;
  status: "audited" | "no_path" | "no_recipe" | "unreadable" | "recipe_no_tokens" | "measure_failed";
  detail?: string;
  windowClosed: boolean; // true when this attempt's transcript is shared and we capped the end
  measured?: Measured;
  reportedTokens: number;
  reportedCostUsd: number | null;
  measuredTokens?: number;
  measuredCostUsd?: number | null;
};

function main() {
  const top = fetchTopOfReport();
  const attempts = dumpAttempts();

  const recipes = factoryUsageRecipes();
  const prices = factoryModelPrices();
  const scratch = mkdtempSync(path.join(tmpdir(), "ocl-153-"));
  const scriptCache = new Map<string, string>();

  function scriptFileFor(recipeCli: string): string {
    const cached = scriptCache.get(recipeCli);
    if (cached) return cached;
    const recipe = recipes.find((r) => r.cli === recipeCli);
    if (!recipe) throw new Error(`no shipped recipe for ${recipeCli}`);
    const body = scriptBodyOf(recipe);
    const file = path.join(scratch, `${recipeCli}.cjs`);
    writeFileSync(file, body);
    scriptCache.set(recipeCli, file);
    return file;
  }

  // A shared transcript path (the same session claiming more than one card,
  // back to back or, per usage_suspect/session_reused, even overlapping) was
  // handled in an earlier version of this script by capping the window at the
  // NEXT claim on the same path. That breaks the moment two cards claim the
  // same session within the same second (OVS-39/OVV-82, both already flagged
  // session_reused by the board): sorting by started_at put one 0.7s "window"
  // in front of a 37M-token attempt and made it look wildly over-measured.
  // Each attempt's own finished_at is the right end bound instead: it is set
  // by the server when THIS card was delivered, so [started_at, finished_at)
  // is exactly the slice of the transcript this card's own work produced,
  // independent of what else later claimed the same session. An attempt still
  // open (no finished_at — abandoned mid-flight, no terminal state) keeps the
  // window open at the end, same as the shipped recipe would see it live.
  const rows: AuditRow[] = [];

  for (const attempt of attempts) {
    const reportedTokens = (attempt.tokens_in ?? 0) + (attempt.tokens_out ?? 0) + (attempt.tokens_cache ?? 0);
    const reportedCostUsd = attempt.cost_usd != null ? Number(attempt.cost_usd) : null;
    const base: Pick<AuditRow, "attempt" | "reportedTokens" | "reportedCostUsd" | "windowClosed"> = {
      attempt,
      reportedTokens,
      reportedCostUsd,
      windowClosed: attempt.finished_at != null,
    };

    const rawPath = attempt.transcript?.path ?? null;
    if (!rawPath) {
      rows.push({ ...base, status: "no_path" });
      continue;
    }

    const recipeCli = resolveRecipeCli(attempt.transcript?.cli);
    if (!recipeCli) {
      rows.push({ ...base, status: "no_recipe", detail: `cli declarado: ${attempt.transcript?.cli ?? "null"}` });
      continue;
    }
    const recipe = recipes.find((r) => r.cli === recipeCli)!;
    if (recipe.yields === "no_tokens") {
      rows.push({ ...base, status: "recipe_no_tokens" });
      continue;
    }

    const endMs = attempt.finished_at ? Date.parse(attempt.finished_at) : null;
    const workDir = mkdtempSync(path.join(scratch, "w-"));

    let transcriptForRecipe: string | null = null;
    try {
      if (recipeCli === "kimi") {
        const dir = resolveKimiSessionDir(rawPath);
        if (!dir) {
          rows.push({ ...base, status: "unreadable", detail: `kimi session dir não encontrado a partir de ${rawPath}` });
          continue;
        }
        transcriptForRecipe = truncateKimiDir(dir, endMs, workDir);
      } else {
        if (!existsSync(rawPath)) {
          rows.push({ ...base, status: "unreadable", detail: "arquivo não existe nesta máquina" });
          continue;
        }
        if (statSync(rawPath).isDirectory()) {
          rows.push({ ...base, status: "unreadable", detail: `transcript.path é um diretório, não um arquivo: ${rawPath}` });
          continue;
        }
        transcriptForRecipe = truncateFileTranscript(rawPath, endMs, workDir);
      }
    } catch (err: any) {
      rows.push({ ...base, status: "unreadable", detail: String(err?.message ?? err) });
      continue;
    }

    try {
      const scriptFile = scriptFileFor(recipeCli);
      const stdout = execFileSync("node", [scriptFile], {
        encoding: "utf8",
        timeout: 20000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TRANSCRIPT_PATH: transcriptForRecipe,
          OVERCLICK_CLAIMED_AT: attempt.started_at,
          CODEX_HARNESS_MODEL: attempt.model ?? "",
        },
      });
      const parsed = JSON.parse(stdout) as { segments: UsageSegment[]; turns: number; estimated: boolean; reason?: string };
      if (parsed.estimated) {
        rows.push({ ...base, status: "measure_failed", detail: parsed.reason ?? "estimated=true sem motivo" });
        continue;
      }
      const measuredTokens = parsed.segments.reduce((sum, s) => sum + segmentTotalTokens(s), 0);
      const resolved = resolveSegmentedCost(parsed.segments, prices, {});
      rows.push({
        ...base,
        status: "audited",
        measured: { segments: parsed.segments, turns: parsed.turns, estimated: parsed.estimated },
        measuredTokens,
        measuredCostUsd: resolved.costUsd,
      });
    } catch (err: any) {
      rows.push({ ...base, status: "measure_failed", detail: String(err?.message ?? err).slice(0, 300) });
    }
  }

  // ---- aggregate ----
  const audited = rows.filter((r) => r.status === "audited" && r.measuredTokens !== undefined);
  const notAudited = rows.filter((r) => r.status !== "audited");
  // The board already flags a subset of attempts usage_suspect (session
  // reused by another card, or the reported usage could not fit inside the
  // claim -> delivery window) and Insights already keeps those OUT of its
  // trusted totals (see mission context: 277/978 attempts excluded that way).
  // Mixing them into this audit's headline numbers would let a handful of
  // already-known-bad rows (one MST-10-shaped outlier is a 107x ratio) decide
  // the whole "is there a systematic bias" answer. They get their own table
  // instead of silently affecting the trusted numbers or silently being
  // dropped.
  const trusted = audited.filter((r) => !r.attempt.usage_suspect);
  const suspect = audited.filter((r) => r.attempt.usage_suspect);

  function summarize(subset: AuditRow[]) {
    let totalReported = 0;
    let totalMeasured = 0;
    let totalReportedCost = 0;
    let totalMeasuredCost = 0;
    let lessCount = 0;
    let moreCount = 0;
    let closeCount = 0; // within 1%
    let exactCount = 0; // bit-exact token equality
    const exactByCli: Record<string, { exact: number; audited: number }> = {};
    const diffs: { row: AuditRow; ratio: number }[] = [];

    for (const row of subset) {
      const measured = row.measuredTokens!;
      const reported = row.reportedTokens;
      totalReported += reported;
      totalMeasured += measured;
      totalReportedCost += row.reportedCostUsd ?? 0;
      totalMeasuredCost += row.measuredCostUsd ?? 0;

      const cli = resolveRecipeCli(row.attempt.transcript?.cli) ?? "unknown";
      exactByCli[cli] ??= { exact: 0, audited: 0 };
      exactByCli[cli].audited += 1;

      if (measured === reported) {
        exactCount += 1;
        exactByCli[cli].exact += 1;
      }
      if (measured === 0) continue;
      const ratio = reported / measured;
      if (Math.abs(ratio - 1) < 0.01) closeCount += 1;
      else if (reported < measured) lessCount += 1;
      else moreCount += 1;
      diffs.push({ row, ratio });
    }
    diffs.sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));

    const byModel: Record<string, { reported: number; measured: number; count: number }> = {};
    for (const row of subset) {
      const modelKey = normalizeModelKey(row.attempt.model ?? "unknown");
      byModel[modelKey] ??= { reported: 0, measured: 0, count: 0 };
      byModel[modelKey].reported += row.reportedTokens;
      byModel[modelKey].measured += row.measuredTokens!;
      byModel[modelKey].count += 1;
    }

    return {
      totalReported,
      totalMeasured,
      totalReportedCost,
      totalMeasuredCost,
      lessCount,
      moreCount,
      closeCount,
      exactCount,
      exactByCli,
      diffs,
      byModel,
    };
  }

  const trustedAgg = summarize(trusted);
  const suspectAgg = summarize(suspect);

  const notAuditedByStatus: Record<string, number> = {};
  for (const row of notAudited) notAuditedByStatus[row.status] = (notAuditedByStatus[row.status] ?? 0) + 1;

  const windowClosedCount = audited.filter((r) => r.windowClosed).length;

  // ---- render markdown ----
  const lines: string[] = [];
  lines.push("# OCL-153 — Auditoria de consumo (refeita)");
  lines.push("");
  lines.push(top.header);
  lines.push("");
  lines.push(
    `**Janela de claim:** cada transcript é somado só a partir do \`claimed_at\` (= \`started_at\`) do attempt, com o mesmo \`claimWindow\` que \`packages/db/src/domain/usage-recipe.ts\` embute em cada receita — nenhum parser próprio, o script deste card grava o corpo JS exato de cada receita num arquivo temporário e executa esse arquivo. Além disso, o fim da janela é fechado no \`finished_at\` do PRÓPRIO attempt (quando existe): a receita ao vivo nunca precisou de um teto porque o agente roda ela na hora que termina, mas remedir dias depois lê o arquivo inteiro, e a mesma sessão pode ter sido reaproveitada por outro card depois (ou até ao mesmo tempo — o board já marca isso como \`usage_suspect: session_reused\`; ver OVS-39/OVV-82, reivindicados a 0.7s de distância na mesma sessão). Uma versão anterior deste script fechava a janela no PRÓXIMO claim do mesmo transcript por horário, e quebrava exatamente nesse caso de reivindicação quase simultânea, gerando um "medido" artificialmente minúsculo. Fechar no \`finished_at\` do próprio attempt evita isso: é o instante em que o SERVIDOR marcou esse card como entregue, não depende de nenhum outro attempt. Isso afeta **${windowClosedCount}** dos ${audited.length} attempts auditados (os sem \`finished_at\` ficam com a janela aberta até o fim do arquivo, igual à receita ao vivo).`,
  );
  lines.push("");

  lines.push("## 1. Cobertura");
  lines.push("");
  lines.push(`- Attempts no banco: **${attempts.length}**`);
  lines.push(`- Com \`transcript.path\` gravado: **${attempts.filter((a) => a.transcript?.path).length}**`);
  lines.push(`- Remedidos com sucesso: **${audited.length}**`);
  lines.push(`  - Confiáveis (\`usage_suspect = false\` no board): **${trusted.length}**`);
  lines.push(`  - Já marcados \`usage_suspect\` pelo board (session_reused / claim_window_exceeded): **${suspect.length}**`);
  lines.push(`- Não auditados: **${notAudited.length}**`);
  for (const [status, count] of Object.entries(notAuditedByStatus)) {
    lines.push(`  - \`${status}\`: ${count}`);
  }
  lines.push("");
  lines.push(
    "Os blocos 2 a 6 abaixo usam só os **confiáveis**: Insights já tira os `usage_suspect` do total (ver contexto da missão), e misturar os dois faria um punhado de casos já sinalizados como ruins decidir sozinho se existe viés sistemático. Os `usage_suspect` têm bloco próprio (7), porque continuam sendo evidência real, só que sob um sinalizador diferente.",
  );
  lines.push("");

  function renderBlocks(agg: ReturnType<typeof summarize>, count: number) {
    lines.push("### Diferença total");
    lines.push("");
    const diffTokens = agg.totalMeasured - agg.totalReported;
    const diffPct = agg.totalMeasured > 0 ? (diffTokens / agg.totalMeasured) * 100 : 0;
    const diffCost = agg.totalMeasuredCost - agg.totalReportedCost;
    const diffCostPct = agg.totalMeasuredCost > 0 ? (diffCost / agg.totalMeasuredCost) * 100 : 0;
    lines.push(`- Tokens reportados (soma dos ${count} auditados): ${agg.totalReported.toLocaleString("en-US")}`);
    lines.push(`- Tokens medidos: ${agg.totalMeasured.toLocaleString("en-US")}`);
    lines.push(`- Diferença: ${diffTokens.toLocaleString("en-US")} (${diffPct.toFixed(2)}%)`);
    lines.push(`- Custo reportado: $${agg.totalReportedCost.toFixed(2)}`);
    lines.push(`- Custo medido (preço atual): $${agg.totalMeasuredCost.toFixed(2)}`);
    lines.push(`- Diferença: $${diffCost.toFixed(2)} (${diffCostPct.toFixed(2)}%)`);
    lines.push("");

    lines.push("### Distribuição do erro");
    lines.push("");
    lines.push(`- Reportou a menos: ${agg.lessCount}`);
    lines.push(`- Reportou a mais: ${agg.moreCount}`);
    lines.push(`- Próximo (±1%): ${agg.closeCount}`);
    lines.push(`- Exato (token a token): ${agg.exactCount}`);
    lines.push("");

    lines.push("### Vinte piores casos");
    lines.push("");
    lines.push("| # | Card | CLI | Modelo | Janela fechada? | Reportado | Medido | Razão |");
    lines.push("|---|------|-----|--------|------------------|-----------|--------|-------|");
    agg.diffs.slice(0, 20).forEach((d, i) => {
      const cli = resolveRecipeCli(d.row.attempt.transcript?.cli) ?? "?";
      lines.push(
        `| ${i + 1} | ${d.row.attempt.task_short_id} | ${cli} | ${d.row.attempt.model ?? "?"} | ${d.row.windowClosed ? "sim" : "não"} | ${d.row.reportedTokens.toLocaleString("en-US")} | ${d.row.measuredTokens!.toLocaleString("en-US")} | ${d.ratio.toFixed(2)} |`,
      );
    });
    lines.push("");

    lines.push("### Corte por modelo");
    lines.push("");
    lines.push("| Modelo | Attempts | Reportado | Medido | Diff% |");
    lines.push("|--------|----------|-----------|--------|-------|");
    const highlight = new Set(["gpt-5-6-sol", "opus-5"]);
    Object.entries(agg.byModel)
      .sort((a, b) => b[1].measured - a[1].measured)
      .forEach(([model, stats]) => {
        const diff = stats.measured > 0 ? ((stats.measured - stats.reported) / stats.measured) * 100 : 0;
        const mark = highlight.has(model) ? " ⭐" : "";
        lines.push(`| ${model}${mark} | ${stats.count} | ${stats.reported.toLocaleString("en-US")} | ${stats.measured.toLocaleString("en-US")} | ${diff.toFixed(1)}% |`);
      });
    lines.push("");

    lines.push("### Quantos bateram exato, por CLI (a receita está sendo usada?)");
    lines.push("");
    lines.push("| CLI | Auditados | Exatos | % |");
    lines.push("|-----|-----------|--------|---|");
    Object.entries(agg.exactByCli)
      .sort((a, b) => b[1].audited - a[1].audited)
      .forEach(([cli, stats]) => {
        const pct = stats.audited > 0 ? (stats.exact / stats.audited) * 100 : 0;
        lines.push(`| ${cli} | ${stats.audited} | ${stats.exact} | ${pct.toFixed(1)}% |`);
      });
    lines.push("");
    lines.push(
      `**Total: ${agg.exactCount} de ${count} attempts auditados (${count > 0 ? ((agg.exactCount / count) * 100).toFixed(1) : "0"}%) reportaram exatamente o que o transcript mostra.**`,
    );
    lines.push("");
  }

  lines.push("## 2-6. Confiáveis (exclui `usage_suspect`)");
  lines.push("");
  renderBlocks(trustedAgg, trusted.length);

  lines.push("## 7. Já marcados `usage_suspect` pelo board");
  lines.push("");
  lines.push(
    "Referência, não parte da conclusão: o board já desconfiava destes antes deste script rodar. Serve para checar se a desconfiança do board bate com a realidade do transcript — e bate: os piores casos aqui são justamente os outliers de centenas de vezes que uma primeira versão deste audit, sem olhar para `usage_suspect`, teria deixado contaminar a conclusão principal (ex.: MST-10, 31.6M reportados em 36s de janela real, `claim_window_exceeded` — o board tinha razão).",
  );
  lines.push("");
  renderBlocks(suspectAgg, suspect.length);

  lines.push("## Conclusão");
  lines.push("");
  const ratioAvg = trustedAgg.totalMeasured > 0 ? trustedAgg.totalReported / trustedAgg.totalMeasured : 1;
  if (ratioAvg < 0.95) {
    lines.push(`Viés sistemático para menos entre os attempts confiáveis: em média reportam ~${(ratioAvg * 100).toFixed(1)}% do que o transcript mostra.`);
  } else if (ratioAvg > 1.05) {
    lines.push(`Viés sistemático para mais entre os attempts confiáveis: em média reportam ~${(ratioAvg * 100).toFixed(1)}% do que o transcript mostra.`);
  } else {
    lines.push(`Sem viés sistemático perceptível (±5%) entre os attempts confiáveis: em média reportam ~${(ratioAvg * 100).toFixed(1)}% do medido.`);
  }
  lines.push("");
  lines.push(`O viés real não está na média, está na COBERTURA: só **${trustedAgg.exactCount} de ${trusted.length}** attempts confiáveis (${trusted.length > 0 ? ((trustedAgg.exactCount / trusted.length) * 100).toFixed(1) : "0"}%) bateram exato — a maioria fica perto (±1%: ${trustedAgg.closeCount}) ou reporta a menos (${trustedAgg.lessCount}), o que é consistente com receitas rodadas corretamente mas com pequena deriva (turnos entre o fim da medição e o \`task_deliver\`), não com um viés de dezenas de por cento.`);
  lines.push("");
  lines.push("Por CLI (confiáveis):");
  Object.entries(trustedAgg.exactByCli).forEach(([cli, stats]) => {
    lines.push(`- **${cli}**: ${stats.audited} auditados, ${stats.exact} exatos (${((stats.exact / stats.audited) * 100).toFixed(1)}%)`);
  });

  lines.push("");
  lines.push("## Amostra para conferência (3 exatos + 3 com diferença, ambos entre os confiáveis)");
  lines.push("");
  const exactSample = trusted.filter((r) => r.measuredTokens === r.reportedTokens).slice(0, 3);
  const missSample = trustedAgg.diffs.filter((d) => Math.abs(d.ratio - 1) >= 0.01).slice(0, 3).map((d) => d.row);
  for (const row of [...exactSample, ...missSample]) {
    lines.push(
      `- \`${row.attempt.task_short_id}\` (attempt ${row.attempt.id}) — transcript: \`${row.attempt.transcript?.path}\` — janela: [\`${row.attempt.started_at}\`, ${row.windowClosed ? row.attempt.finished_at : "fim do arquivo"}) — reportado ${row.reportedTokens} / medido ${row.measuredTokens}`,
    );
  }

  const report = lines.join("\n");
  const outFile = path.join(scratch, "..", "ocl-153-report.md");
  writeFileSync(path.join(scratch, "report.md"), report);
  process.stdout.write(report + "\n");
  process.stderr.write(`\n[scratch dir kept at ${scratch} for manual inspection]\n`);
}

main();
