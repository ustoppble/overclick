// OCL-209 — mines real Codex rollouts for OverClick calls. Codex calls the
// board from code mode (`exec` running `tools.mcp__overclick__X(...)`) or,
// in older builds, as a direct function_call. One record per call, sizes and
// timings only; payload texts go to the LOCAL payload file.
//   node mine-codex.mjs <out-calls.jsonl> <out-payloads.jsonl> <file>...
// write_s  = call item ts - last model input (tool output / user message)
// server_s = output item ts - call item ts
// out_tok  = last_token_usage.output_tokens of the response that wrote it
import fs from "node:fs";

const [, , outCalls, outPayloads, ...files] = process.argv;
const calls = fs.createWriteStream(outCalls);
const payloads = fs.createWriteStream(outPayloads);
const NAME = /tools\.mcp__overclick__(\w+)\s*\(/g;
let total = 0;
for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  let lastInput = null, model = null, session = null;
  const pending = new Map();
  const awaitingUsage = [];
  const recs = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload ?? {};
    const ts = Date.parse(e.timestamp);
    if (e.type === "session_meta") session = p.id ?? session;
    if (e.type === "turn_context" && p.model) model = p.model;
    if (p.type === "token_count" && p.info?.last_token_usage) {
      for (const r of awaitingUsage) {
        r.msg_output_tokens = p.info.last_token_usage.output_tokens ?? null;
        r.reasoning_tokens = p.info.last_token_usage.reasoning_output_tokens ?? null;
      }
      awaitingUsage.length = 0;
      continue;
    }
    if (e.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") { lastInput = ts; continue; }
    if (p.type === "custom_tool_call" || p.type === "function_call") {
      const src = p.type === "custom_tool_call" ? String(p.input ?? "") : String(p.arguments ?? "");
      let names = [...src.matchAll(NAME)].map((m) => m[1]);
      if (p.type === "function_call" && /overclick/.test(p.name ?? "")) names = [String(p.name).replace(/^.*overclick__?/, "")];
      if (!names.length) continue;
      const rec = {
        cli: "codex", account: "codex", session, model, tool: names.length === 1 ? names[0] : names.join("+"),
        multi: names.length > 1, call_id: p.call_id, date: new Date(ts).toISOString(),
        write_s: lastInput ? (ts - lastInput) / 1000 : null, args_chars: src.length,
        msg_output_tokens: null, reasoning_tokens: null, _ts: ts, _args: src,
      };
      pending.set(p.call_id, rec);
      awaitingUsage.push(rec);
      recs.push(rec);
      continue;
    }
    if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
      lastInput = ts;
      const rec = pending.get(p.call_id);
      if (!rec) continue;
      const parts = Array.isArray(p.output) ? p.output.map((o) => o?.text ?? "") : [String(p.output ?? "")];
      let body = parts.join("");
      const wall = /Wall time ([\d.]+) seconds/.exec(body);
      body = body.replace(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n/, "");
      const trunc = /original token count: (\d+)/.exec(body);
      rec.server_s = (ts - rec._ts) / 1000;
      rec.exec_wall_s = wall ? Number(wall[1]) : null;
      rec.result_chars = body.length;
      rec.truncated_original_tokens = trunc ? Number(trunc[1]) : null;
      rec.is_error = /"error":\{"code"/.test(body.slice(0, 200)) || /^Script (failed|error)/i.test(parts[0] ?? "");
      rec._result = body;
      pending.delete(p.call_id);
    }
  }
  for (const r of recs) {
    const { _ts, _args, _result, ...out } = r;
    calls.write(`${JSON.stringify(out)}\n`);
    payloads.write(`${JSON.stringify({ call_id: r.call_id, tool: r.tool, date: r.date, args: _args, result: _result ?? null })}\n`);
    total += 1;
  }
}
calls.end();
payloads.end();
process.stderr.write(`calls: ${total}\n`);
