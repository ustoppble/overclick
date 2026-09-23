// OCL-209 — the table: per tool, measured wall time and its split into
// WRITE (model generating the call), SERVER and READ (prefill of the answer),
// output tokens written vs input tokens read, both regimes, and N.
//   node table.mjs <claude-calls.jsonl> <codex-calls.jsonl> <bench.jsonl> [--since=2026-09-09]
// Tokenizer: the Claude 5 models' own, measured from the usage counters of
// the same transcripts (calibrate.mjs): 2.3 chars/token for returned JSON,
// 1.95 chars/token + 80 fixed tokens for a written call. Read clock: the
// measured prefill cost per 1k new tokens for each model (speed.mjs).
import fs from "node:fs";

const [claudeFile, codexFile, benchFile] = process.argv.slice(2);
const since = (process.argv.find((a) => a.startsWith("--since=")) ?? "--since=2026-09-09").slice(8);
const load = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const claude = load(claudeFile);
const codex = load(codexFile);
const bench = load(benchFile);
const READ_S_PER_1K = { "claude-opus-5": 0.069, "claude-fable-5": 0.106, "claude-sonnet-5": 0.043, "claude-fable-5-1": 0.238, "claude-opus-5-5": 0.038 };
const IN_CPT = 2.3, OUT_CPT = 1.95, OUT_FIXED = 80;
const q = (xs, p = 0.5) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
};
const fam = (m) => (m ?? "").replace(/-\d{8}$/, "");
const NOT_BOARD = new Set(["pane_write", "pane_spawn", "handoff_list"]); // wrong-server calls, all refused
const tools = [...new Set([...claude.map((r) => r.tool), ...bench.filter((b) => !b.tool.startsWith("(")).map((b) => b.tool)])].filter((t) => !NOT_BOARD.has(t));
// Direct calls made by the OCL-209 executor on the real board, 2026-09-23 15:24–15:44 (its own transcript).
const TODAY = { organization_list: 719, organization_get: 208, project_list: 24202, mission_list: 28121, task_list: 10100, insights_query: 291908, task_search: 2389, task_claim: 26983, branch_register: 4124, task_get: 6378 };
const flowFile = (process.argv.find((a) => a.startsWith("--flow=")) ?? "").slice(7);
const flow = flowFile ? JSON.parse(fs.readFileSync(flowFile, "utf8")) : { register: {}, execute: {} };
const defs = Object.fromEntries(bench.filter((b) => b.regime === "small" && b.label.startsWith("definition:")).map((b) => [b.tool, b.chars]));
const benchOf = (regime, label) => bench.find((b) => b.regime === regime && b.label === label);
const rows = [];
for (const tool of tools) {
  let rs = claude.filter((r) => r.tool === tool && r.date >= since);
  let fallback = false;
  if (rs.length < 5) { rs = claude.filter((r) => r.tool === tool); fallback = true; }
  const ok = rs.filter((r) => !r.is_error);
  let single = rs.filter((r) => r.msg_tool_uses === 1);
  if (!single.length) single = rs;
  // Streaming tool execution can land a result before the message's last
  // block; then the server time is result minus the call block itself.
  const srv = (r) => (r.server_s != null && r.server_s >= 0 ? r.server_s : r.call_to_result_s);
  const readS = (r) => ((r.result_chars ?? 0) / IN_CPT / 1000) * (READ_S_PER_1K[fam(r.model)] ?? 0.07);
  const total = single.map((r) => Math.max(0, r.write_s ?? 0) + Math.max(0, srv(r) ?? 0) + readS(r));
  const cx = codex.filter((r) => r.tool === tool && r.date >= since);
  const small = benchOf("small", tool);
  const grown = benchOf("grown", tool);
  rows.push({
    tool,
    n: rs.length,
    fallback,
    n_codex: cx.length,
    errors: rs.length - ok.length,
    wall_s: q(total),
    write_s: q(single.map((r) => r.write_s)),
    server_s: q(single.map(srv)),
    read_s: q(ok.map(readS)),
    out_tok: q(rs.map((r) => OUT_FIXED + r.args_chars / OUT_CPT)),
    msg_out_tok: q(rs.map((r) => r.msg_output_tokens)),
    in_tok: q(ok.map((r) => (r.result_chars ?? 0) / IN_CPT)),
    real_chars: q(ok.map((r) => r.result_chars)),
    real_chars_p90: q(ok.map((r) => r.result_chars), 0.9),
    small_chars: small?.chars ?? null,
    grown_chars: grown?.chars ?? null,
    codex_write_s: q(cx.filter((r) => !r.multi).map((r) => r.write_s)),
    sum_wall_h: (q(total) ?? 0) * rs.length / 3600,
    today: TODAY[tool] ?? null,
    flow_reg: flow.register[tool] ?? 0,
    flow_exe: flow.execute[tool] ?? 0,
    def_chars: defs[tool] ?? null,
  });
}
rows.sort((a, b) => b.sum_wall_h - a.sum_wall_h);
const f = (x, d = 1) => (x === null || x === undefined ? "—" : Number(x).toFixed(d));
const k = (x) => (x === null || x === undefined ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)}k` : `${Math.round(x)}`);
console.log(`| # | ferramenta | N real | parede p50 | escrita p50 | servidor p50 | leitura p50 | domina | SAÍDA tok (args) | saída da msg p50 | ENTRADA tok p50 | pequeno (chars) | real p50/p90 (chars) | real hoje (chars) | crescido PGlite | definição (chars) | chamadas/card: registrar + executar | Codex escrita p50 (N) | recusa % |`);
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
rows.forEach((r, i) => {
  const dom = [["escrita", r.write_s ?? 0], ["servidor", r.server_s ?? 0], ["leitura", r.read_s ?? 0]].sort((a, b) => b[1] - a[1])[0][0];
  const none = r.n === 0;
  console.log(`| ${i + 1} | ${r.tool}${r.fallback && !none ? " †" : ""} | ${r.n} | ${none ? "sem uso" : f(r.wall_s) + " s"} | ${none ? "—" : f(r.write_s) + " s"} | ${none ? "—" : f(r.server_s, 2) + " s"} | ${none ? "—" : f(r.read_s, 2) + " s"} | ${none ? "—" : dom} | ${k(r.out_tok)} | ${k(r.msg_out_tok)} | ${k(r.in_tok)} | ${k(r.small_chars)} | ${k(r.real_chars)} / ${k(r.real_chars_p90)} | ${k(r.today)} | ${k(r.grown_chars)} | ${k(r.def_chars)} | ${r.flow_reg || r.flow_exe ? `${f(r.flow_reg, 2)} + ${f(r.flow_exe, 2)}` : "0"} | ${f(r.codex_write_s)} s (${r.n_codex}) | ${none ? "—" : f((100 * r.errors) / Math.max(1, r.n), 0)} |`);
});
console.log(`\nΣ horas de parede no período (N × p50): ` + rows.map((r) => `${r.tool} ${r.sum_wall_h.toFixed(1)}h`).join(" · "));
