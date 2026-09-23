// OCL-209 — chars→tokens calibration from REAL usage counters, per model.
// Output side: messages whose only block is one board tool_use (no thinking,
// no text): output_tokens is the cost of writing that call.
// Input side: the next request's total input minus this request's total
// input minus this message's output = the tool_result plus wrappers.
// Fits tokens = a + chars / k by least squares and prints k (chars/token).
import fs from "node:fs";

const rows = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fam = (m) => (m ?? "?").replace(/-\d{8}$/, "");
function fit(pts) {
  const n = pts.length;
  if (n < 5) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const b = sxy / sxx;
  const a = my - b * mx;
  const ratio = pts.map(([x, y]) => x / Math.max(1, y)).sort((p, q) => p - q);
  return { n, a: +a.toFixed(1), chars_per_token: +(1 / b).toFixed(2), median_ratio: +ratio[Math.floor(n / 2)].toFixed(2) };
}
const outPts = {}, inPts = {};
for (const r of rows) {
  const f = fam(r.model);
  if (r.msg_tool_uses === 1 && !r.msg_has_thinking && !r.msg_has_text && r.msg_output_tokens > 0 && r.tool !== "usage_recipe(Bash)")
    (outPts[f] ??= []).push([r.args_chars, r.msg_output_tokens]);
  if (r.msg_tool_uses === 1 && !r.msg_has_thinking && !r.msg_has_text && !r.is_error && r.next_input_total && r.msg_input_total && r.result_chars > 2000) {
    const d = r.next_input_total - r.msg_input_total - r.msg_output_tokens;
    if (d > 0) (inPts[f] ??= []).push([r.result_chars, d]);
  }
}
console.log("OUTPUT (args JSON written by the model):");
for (const [f, p] of Object.entries(outPts)) console.log(" ", f, JSON.stringify(fit(p)));
console.log("INPUT (tool_result JSON read by the model, results > 2k chars):");
for (const [f, p] of Object.entries(inPts)) console.log(" ", f, JSON.stringify(fit(p)));
