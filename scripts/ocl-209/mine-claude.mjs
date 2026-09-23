// OCL-209 — mines real Claude Code transcripts for every OverClick MCP call.
// Output: one record per call with timings and sizes, never the content.
// Payload texts go to a separate LOCAL file (argv[3]) used only for
// tokenizing and field analysis; it is never committed.
//
//   node mine-claude.mjs <out-calls.jsonl> <out-payloads.jsonl> <file>...
//
// Timing model (per assistant message that carries a board call):
//   req_start  = last `user` entry (prompt or tool_result) before the
//                message's first block — when the model request began.
//   call_ts    = the tool_use block entry — when the model finished writing it.
//   msg_end    = last block entry of that message.
//   result_ts  = the `user` entry carrying the matching tool_result.
//   write_s    = call_ts - req_start   (model: prefill + thinking + writing)
//   server_s   = result_ts - msg_end   (hooks + network + board)
import fs from "node:fs";

const [, , outCalls, outPayloads, ...files] = process.argv;
const calls = fs.createWriteStream(outCalls);
const payloads = fs.createWriteStream(outPayloads);
const BOARD = /^mcp__overclick__/;
const RECIPE = /claimWindow\(|OVERCLICK_CLAIMED_AT/;

const ms = (s) => Date.parse(s);
let total = 0;

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const account = file.includes("claude-accounts/") ? "acc-2" : "acc-1";
  // Separate timelines for the main thread and each sidechain.
  const lanes = new Map();
  const lane = (key) => {
    if (!lanes.has(key)) lanes.set(key, { lastUser: null, msgs: new Map(), awaiting: [] });
    return lanes.get(key);
  };
  const pending = new Map(); // tool_use_id -> record
  const order = []; // records in file order
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "assistant" && e.type !== "user") continue;
    const L = lane(e.isSidechain ? `side:${e.agentId ?? ""}` : "main");
    const m = e.message ?? {};
    const content = Array.isArray(m.content) ? m.content : [];
    const ts = ms(e.timestamp);
    if (e.type === "user") {
      for (const b of content) {
        if (b?.type !== "tool_result") continue;
        const rec = pending.get(b.tool_use_id);
        if (!rec) continue;
        let txt = "";
        if (typeof b.content === "string") txt = b.content;
        else if (Array.isArray(b.content))
          txt = b.content.map((c) => (c?.type === "text" ? c.text : "")).join("");
        rec.result_ts = ts;
        rec.result_chars = txt.length;
        rec.is_error = Boolean(b.is_error);
        rec._result = txt;
        pending.delete(b.tool_use_id);
        L.awaiting.push(rec);
      }
      L.lastUser = ts;
      continue;
    }
    // assistant block entry
    const id = m.id ?? `${e.uuid}`;
    let msg = L.msgs.get(id);
    if (!msg) {
      msg = {
        id,
        req_start: L.lastUser,
        first_ts: ts,
        last_ts: ts,
        blocks: [],
        usage: m.usage ?? null,
        model: m.model ?? null,
        records: [],
      };
      L.msgs.set(id, msg);
      // The first message after a board result: how long until the model
      // produced its first block, and how much input it carried.
      for (const r of L.awaiting) r._next = msg;
      L.awaiting = [];
    }
    msg.last_ts = Math.max(msg.last_ts, ts);
    if (m.usage && (!msg.usage || (m.usage.output_tokens ?? 0) >= (msg.usage.output_tokens ?? 0)))
      msg.usage = m.usage;
    for (const b of content) {
      msg.blocks.push(b?.type);
      if (b?.type !== "tool_use") continue;
      const isBoard = BOARD.test(b.name ?? "");
      const isRecipe =
        b.name === "Bash" && typeof b.input?.command === "string" && RECIPE.test(b.input.command);
      if (!isBoard && !isRecipe) continue;
      const args = JSON.stringify(b.input ?? {});
      const rec = {
        cli: "claude",
        account,
        session: e.sessionId ?? null,
        sidechain: Boolean(e.isSidechain),
        cwd: e.cwd ?? null,
        cc_version: e.version ?? null,
        tool: isBoard ? b.name.replace(BOARD, "") : "usage_recipe(Bash)",
        call_id: b.id,
        msg_id: id,
        req_start: msg.req_start,
        call_ts: ts,
        args_chars: args.length,
        arg_keys: Object.fromEntries(
          Object.entries(b.input ?? {}).map(([k, v]) => [k, JSON.stringify(v ?? null).length]),
        ),
        _msg: msg,
        _args: args,
      };
      msg.records.push(rec);
      pending.set(b.id, rec);
      order.push(rec);
    }
  }
  for (const rec of order) {
    const msg = rec._msg;
    const u = msg.usage ?? {};
    const out = {
      ...rec,
      model: msg.model,
      msg_end: msg.last_ts,
      msg_tool_uses: msg.blocks.filter((t) => t === "tool_use").length,
      msg_board_calls: msg.records.length,
      msg_has_thinking: msg.blocks.includes("thinking") || msg.blocks.includes("redacted_thinking"),
      msg_has_text: msg.blocks.includes("text"),
      msg_output_tokens: u.output_tokens ?? null,
      msg_input_total:
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      write_s: rec.req_start ? (rec.call_ts - rec.req_start) / 1000 : null,
      server_s: rec.result_ts ? (rec.result_ts - msg.last_ts) / 1000 : null,
      call_to_result_s: rec.result_ts ? (rec.result_ts - rec.call_ts) / 1000 : null,
      date: new Date(rec.call_ts).toISOString(),
      next_first_s: rec._next && rec.result_ts ? (rec._next.first_ts - rec.result_ts) / 1000 : null,
      next_first_block: rec._next ? rec._next.blocks[0] ?? null : null,
      next_has_thinking: rec._next ? rec._next.blocks.includes("thinking") : null,
      next_input_total: rec._next?.usage
        ? (rec._next.usage.input_tokens ?? 0) + (rec._next.usage.cache_read_input_tokens ?? 0) + (rec._next.usage.cache_creation_input_tokens ?? 0)
        : null,
      next_cache_write: rec._next?.usage ? rec._next.usage.cache_creation_input_tokens ?? 0 : null,
      next_uncached: rec._next?.usage ? rec._next.usage.input_tokens ?? 0 : null,
      next_output_tokens: rec._next?.usage ? rec._next.usage.output_tokens ?? null : null,
      next_blocks: rec._next ? rec._next.blocks.join(",") : null,
    };
    for (const k of ["_msg", "_args", "_result", "_next", "req_start", "call_ts"]) delete out[k];
    calls.write(`${JSON.stringify(out)}\n`);
    payloads.write(
      `${JSON.stringify({ call_id: rec.call_id, tool: out.tool, date: out.date, args: rec._args, result: rec._result ?? null })}\n`,
    );
    total += 1;
  }
}
calls.end();
payloads.end();
process.stderr.write(`calls: ${total}\n`);
