// OCL-209 — the session start-up of the overclick MCP, from Claude Code's own
// MCP logs (~/Library/Caches/claude-cli-nodejs/<cwd>/mcp-logs-overclick/*.jsonl).
// One file per session connection. Prints: connect time, instructions size,
// how often the tool listing timed out and after how long, the configured
// timeouts, and the client-side duration of every tool call. No URLs, no
// headers: only timings and counts.
//   node mcp-logs.mjs <file-list.txt> [--since=YYYY-MM-DD]
import fs from "node:fs";

const files = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const since = (process.argv.find((a) => a.startsWith("--since=")) ?? "--since=2000-01-01").slice(8);
const q = (xs, p = 0.5) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))] : null; };
const connects = [], instr = [], fetchFail = [], connectTimeouts = [], connectFailed = [], timeoutsCfg = {}, requestTimeouts = {}, toolMs = {}, byDay = {};
let sessions = 0, cloudSessions = 0, noTools = 0;
for (const f of files) {
  let lines;
  try { lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { continue; }
  const ev = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!ev.length || ev[0].timestamp < since) continue;
  sessions += 1;
  const msg = (e) => String(e.debug ?? e.error ?? e.info ?? "");
  const cloud = ev.some((e) => /host=cloud\.overclock\.sh/.test(msg(e)));
  if (!cloud) continue;
  cloudSessions += 1;
  const day = ev[0].timestamp.slice(0, 10);
  const d = (byDay[day] ??= { sessions: 0, fetchFail: 0, connectFail: 0, connect: [] });
  d.sessions += 1;
  const start = ev.find((e) => /^Starting connection with timeout of/.test(msg(e)));
  const t0 = Date.parse((start ?? ev[0]).timestamp);
  let established = null;
  for (const e of ev) {
    const m = msg(e);
    let x;
    if ((x = /^Starting connection with timeout of (\d+)ms/.exec(m))) timeoutsCfg[x[1]] = (timeoutsCfg[x[1]] ?? 0) + 1;
    if ((x = /"timeoutMs":(\d+)/.exec(m))) requestTimeouts[x[1]] = (requestTimeouts[x[1]] ?? 0) + 1;
    if ((x = /^Successfully connected \(transport: http\) in (\d+)ms/.exec(m))) { connects.push(+x[1]); d.connect.push(+x[1]); established = Date.parse(e.timestamp); }
    if ((x = /^Server instructions truncated from (\d+) to/.exec(m))) instr.push({ day, chars: +x[1] });
    if (/Failed to fetch tools: Request timed out/.test(m)) {
      fetchFail.push({ day, after_connect_s: established ? (Date.parse(e.timestamp) - established) / 1000 : null, after_start_s: (Date.parse(e.timestamp) - t0) / 1000 });
      d.fetchFail += 1;
    }
    if ((x = /Connection timeout triggered after (\d+)ms \(limit: (\d+)ms\)/.exec(m))) connectTimeouts.push({ day, after: +x[1], limit: +x[2] });
    if (/^Connection failed after (\d+)ms/.test(m)) { connectFailed.push({ day, m: m.replace(/https?:\/\/\S+/g, "<url>").slice(0, 90) }); d.connectFail += 1; }
    if ((x = /^Tool '([a-z_]+)' completed successfully in ([\d.]+)(ms|s)/.exec(m))) (toolMs[x[1]] ??= []).push(x[3] === "s" ? +x[2] * 1000 : +x[2]);
  }
  if (!ev.some((e) => /Calling MCP tool/.test(msg(e))) && fetchFail.length && fetchFail.at(-1).day === day) noTools += 0;
}
const out = {
  sessions, cloud_sessions: cloudSessions,
  connect_ms: { n: connects.length, p50: q(connects), p90: q(connects, 0.9), p99: q(connects, 0.99), max: q(connects, 1) },
  configured_connect_timeout_ms: timeoutsCfg,
  configured_request_timeout_ms: requestTimeouts,
  instructions_chars_by_day: Object.fromEntries(Object.entries(instr.reduce((a, r) => { (a[r.day] ??= []).push(r.chars); return a; }, {})).map(([k, v]) => [k, q(v, 1)]).sort()),
  tools_fetch_timeouts: { n: fetchFail.length, after_connect_s_p50: q(fetchFail.map((r) => r.after_connect_s)), after_start_s_p50: q(fetchFail.map((r) => r.after_start_s)), after_start_s_min: q(fetchFail.map((r) => r.after_start_s), 0), days: fetchFail.reduce((a, r) => { a[r.day] = (a[r.day] ?? 0) + 1; return a; }, {}) },
  connect_timeouts: { n: connectTimeouts.length, limits: [...new Set(connectTimeouts.map((r) => r.limit))] },
  connect_failed: connectFailed.length,
  tool_call_ms_client: Object.fromEntries(Object.entries(toolMs).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, { n: v.length, p50: q(v), p90: q(v, 0.9), max: q(v, 1) }])),
};
console.log(JSON.stringify(out, null, 1));
if (process.argv.includes("--days")) for (const [day, d] of Object.entries(byDay).sort()) console.log(day, "sessions", d.sessions, "connect p50", q(d.connect), "p90", q(d.connect, 0.9), "max", q(d.connect, 1), "tools-timeout", d.fetchFail, "connect-fail", d.connectFail);
