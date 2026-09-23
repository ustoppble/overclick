// OCL-209 — times the overclick MCP session start-up against the real server:
// initialize (connect) and tools/list, sequentially and in parallel waves, as
// a pane wave does. Reads the server entry from ~/.claude.json silently and
// prints ONLY timings and sizes: never the URL, never the headers.
//   node handshake-probe.mjs [sequential=10] [waves=4,8]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sdk = (p) => new URL(`../../apps/web/node_modules/@modelcontextprotocol/sdk/dist/esm/${p}`, import.meta.url).href;
const { Client } = await import(sdk("client/index.js"));
const { StreamableHTTPClientTransport } = await import(sdk("client/streamableHttp.js"));

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")).mcpServers?.overclick;
if (!cfg?.url) throw new Error("overclick server not configured in ~/.claude.json");
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")));
const sequential = Number(args.sequential ?? 10);
const waves = String(args.waves ?? "4,8").split(",").filter(Boolean).map(Number);

async function handshake() {
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers ?? {} } });
  const client = new Client({ name: "ocl209-probe", version: "0" });
  const t0 = performance.now();
  await client.connect(transport);
  const t1 = performance.now();
  const listed = await client.listTools();
  const t2 = performance.now();
  const bytes = JSON.stringify(listed).length;
  const descriptions = listed.tools.reduce((s, t) => s + (t.description ?? "").length, 0);
  const instructions = (client.getInstructions() ?? "").length;
  await client.close();
  return { connect_ms: Math.round(t1 - t0), list_ms: Math.round(t2 - t1), tools: listed.tools.length, list_chars: bytes, description_chars: descriptions, instructions_chars: instructions };
}
const q = (xs, p) => { const v = xs.slice().sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))]; };
const seq = [];
for (let i = 0; i < sequential; i++) seq.push(await handshake());
const sum = (rs) => ({ n: rs.length, connect_ms_p50: q(rs.map((r) => r.connect_ms), 0.5), connect_ms_max: q(rs.map((r) => r.connect_ms), 1), list_ms_p50: q(rs.map((r) => r.list_ms), 0.5), list_ms_max: q(rs.map((r) => r.list_ms), 1) });
console.log(JSON.stringify({ sequential: sum(seq), sizes: { tools: seq[0].tools, list_chars: seq[0].list_chars, description_chars: seq[0].description_chars, instructions_chars: seq[0].instructions_chars } }));
for (const k of waves) {
  const rs = await Promise.all(Array.from({ length: k }, () => handshake()));
  console.log(JSON.stringify({ wave: k, ...sum(rs) }));
}
