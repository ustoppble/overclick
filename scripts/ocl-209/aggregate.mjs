// OCL-209 — per-tool aggregate of mined calls (medians and p90s).
//   node aggregate.mjs <calls.jsonl> [--since=YYYY-MM-DD] [--single]
// --single keeps only calls that were the only tool_use of their message,
// so write_s is attributable to that one call.
import fs from "node:fs";

const file = process.argv[2];
const since = (process.argv.find((a) => a.startsWith("--since=")) ?? "").slice(8);
const single = process.argv.includes("--single");
const rows = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => !since || r.date >= since)
  .filter((r) => !single || r.msg_tool_uses === 1);

const q = (xs, p) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
};
const by = new Map();
for (const r of rows) {
  if (!by.has(r.tool)) by.set(r.tool, []);
  by.get(r.tool).push(r);
}
const out = [];
for (const [tool, rs] of by) {
  const ok = rs.filter((r) => !r.is_error);
  out.push({
    tool,
    n: rs.length,
    errors: rs.length - ok.length,
    first: rs.map((r) => r.date).sort()[0].slice(0, 10),
    last: rs.map((r) => r.date).sort().at(-1).slice(0, 10),
    write_s_p50: q(rs.map((r) => r.write_s), 0.5),
    write_s_p90: q(rs.map((r) => r.write_s), 0.9),
    server_s_p50: q(rs.map((r) => r.server_s), 0.5),
    server_s_p90: q(rs.map((r) => r.server_s), 0.9),
    out_tok_msg_p50: q(rs.map((r) => r.msg_output_tokens), 0.5),
    args_chars_p50: q(rs.map((r) => r.args_chars), 0.5),
    args_chars_p90: q(rs.map((r) => r.args_chars), 0.9),
    result_chars_p50: q(ok.map((r) => r.result_chars), 0.5),
    result_chars_p90: q(ok.map((r) => r.result_chars), 0.9),
    result_chars_max: q(ok.map((r) => r.result_chars), 1),
    thinking_share: rs.filter((r) => r.msg_has_thinking).length / rs.length,
  });
}
out.sort((a, b) => b.n - a.n);
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 1));
else {
  const f = (x, d = 1) => (x === null ? "-" : Number(x).toFixed(d));
  console.log("tool | n | err | first..last | write_s p50/p90 | server_s p50/p90 | msg_out_tok p50 | args ch p50/p90 | result ch p50/p90/max | think%");
  for (const r of out)
    console.log(
      [r.tool, r.n, r.errors, `${r.first}..${r.last}`, `${f(r.write_s_p50)}/${f(r.write_s_p90)}`, `${f(r.server_s_p50, 2)}/${f(r.server_s_p90, 2)}`, f(r.out_tok_msg_p50, 0), `${f(r.args_chars_p50, 0)}/${f(r.args_chars_p90, 0)}`, `${f(r.result_chars_p50, 0)}/${f(r.result_chars_p90, 0)}/${f(r.result_chars_max, 0)}`, f(r.thinking_share * 100, 0)].join(" | "),
    );
}
