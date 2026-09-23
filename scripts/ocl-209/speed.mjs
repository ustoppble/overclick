// OCL-209 — model clock from real board-call messages, per model family.
// write_s = ttft + output_tokens * s_per_token   (least squares, p95-trimmed)
// read:     ttft of the NEXT request vs the tokens it had to prefill
//           (cache_creation + uncached input), on next messages that are a
//           single tool_use without thinking or text.
import fs from "node:fs";

const rows = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fam = (m) => (m ?? "?").replace(/-\d{8}$/, "");
function fit(pts) {
  const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
  const cut = ys[Math.floor(ys.length * 0.95)];
  const P = pts.filter((p) => p[1] <= cut && p[1] >= 0);
  const n = P.length;
  if (n < 8) return null;
  const mx = P.reduce((s, p) => s + p[0], 0) / n;
  const my = P.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of P) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const b = sxy / sxx;
  return { n, intercept_s: +(my - b * mx).toFixed(2), slope: b };
}
const W = {}, R = {};
for (const r of rows) {
  const f = fam(r.model);
  if (r.msg_tool_uses === 1 && r.write_s != null && r.msg_output_tokens > 0) (W[f] ??= []).push([r.msg_output_tokens, r.write_s]);
  if (r.next_blocks === "tool_use" && r.next_first_s != null && r.next_output_tokens > 0) R[f] ??= [];
}
const speed = {};
console.log("WRITE clock: write_s = ttft + out_tokens / tok_per_s");
for (const [f, p] of Object.entries(W)) {
  const q = fit(p);
  if (!q) continue;
  speed[f] = 1 / q.slope;
  console.log(" ", f, `n=${q.n} ttft≈${q.intercept_s}s  speed≈${(1 / q.slope).toFixed(0)} tok/s`);
}
console.log("READ clock: next ttft (first block minus its own generation) vs new prefill tokens");
for (const f of Object.keys(R)) {
  if (!speed[f]) continue;
  const pts = rows
    .filter((r) => fam(r.model) === f && r.next_blocks === "tool_use" && r.next_first_s != null && r.next_output_tokens > 0)
    .map((r) => [(r.next_cache_write ?? 0) + (r.next_uncached ?? 0), r.next_first_s - r.next_output_tokens / speed[f]]);
  const q = fit(pts);
  if (!q) continue;
  console.log(" ", f, `n=${q.n} base≈${q.intercept_s}s  +${(q.slope * 1000).toFixed(3)}s per 1k new tokens`);
}
