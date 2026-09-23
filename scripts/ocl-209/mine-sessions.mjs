// OCL-209 — every tool call (board or not) of the sessions that touched the
// board, in order, for flow/episode analysis. Sizes and timings only.
//   node mine-sessions.mjs <out.jsonl> <file>...
// Record: session, seq, ts, tool, write_s, server_s, args_chars,
// result_chars, msg_output_tokens, task_ref (task_id arg when present),
// human (true for a human/orchestrator prompt entry, no tool).
import fs from "node:fs";

const [, , out, ...files] = process.argv;
const w = fs.createWriteStream(out);
for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  let lastUser = null, session = null, seq = 0;
  const msgs = new Map();
  const pending = new Map();
  const recs = [];
  for (const line of text.split("\n")) {
    if (!line || (!line.includes('"type":"assistant"') && !line.includes('"type":"user"'))) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.type !== "assistant" && e.type !== "user") continue;
    session = e.sessionId ?? session;
    const m = e.message ?? {};
    const ts = Date.parse(e.timestamp);
    const content = Array.isArray(m.content) ? m.content : [];
    if (e.type === "user") {
      const results = content.filter((b) => b?.type === "tool_result");
      if (!results.length) {
        const txt = typeof m.content === "string" ? m.content : content.map((b) => b?.text ?? "").join("");
        if (!/^<(local-command|command-name|system-reminder)/.test(txt.trim()))
          recs.push({ session, seq: seq++, ts, human: true, chars: txt.length });
      }
      for (const b of results) {
        const r = pending.get(b.tool_use_id);
        if (!r) continue;
        const txt = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? "").join("") : "";
        r.result_ts = ts;
        r.result_chars = txt.length;
        r.is_error = Boolean(b.is_error);
        pending.delete(b.tool_use_id);
      }
      lastUser = ts;
      continue;
    }
    const id = m.id ?? e.uuid;
    let msg = msgs.get(id);
    if (!msg) { msg = { req: lastUser, last: ts, usage: m.usage, recs: [] }; msgs.set(id, msg); }
    msg.last = Math.max(msg.last, ts);
    if (m.usage && (m.usage.output_tokens ?? 0) >= (msg.usage?.output_tokens ?? 0)) msg.usage = m.usage;
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      const input = b.input ?? {};
      const r = {
        session, seq: seq++, ts, tool: b.name, call_id: b.id, write_s: msg.req ? (ts - msg.req) / 1000 : null,
        args_chars: JSON.stringify(input).length,
        task_ref: typeof input.task_id === "string" ? input.task_id : null,
        recipe: b.name === "Bash" && /claimWindow\(|OVERCLICK_CLAIMED_AT/.test(String(input.command ?? "")),
        overclock_kind: typeof input.kind === "string" ? input.kind : null,
        _msg: msg,
      };
      msg.recs.push(r);
      pending.set(b.id, r);
      recs.push(r);
    }
  }
  for (const r of recs) {
    if (r.human) { w.write(`${JSON.stringify(r)}\n`); continue; }
    const msg = r._msg;
    delete r._msg;
    r.msg_tool_uses = msg.recs.length;
    r.msg_output_tokens = msg.usage?.output_tokens ?? null;
    r.server_s = r.result_ts ? (r.result_ts - msg.last) / 1000 : null;
    w.write(`${JSON.stringify(r)}\n`);
  }
}
w.end();
