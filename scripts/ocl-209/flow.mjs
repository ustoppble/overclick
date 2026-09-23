// OCL-209 — the "register a card and execute it" flow, measured on real
// sessions. Register = from the orchestrator prompt to the task_create
// result (and, for agentic pilots, to the pane_spawn that opens the helper).
// Execute = from a worker's task_claim of card X to its task_deliver of X.
//   node flow.mjs <sessions.jsonl> [--since=YYYY-MM-DD]
import fs from "node:fs";

const since = (process.argv.find((a) => a.startsWith("--since=")) ?? "--since=2026-09-09").slice(8);
const all = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bySession = new Map();
for (const r of all) {
  if (!bySession.has(r.session)) bySession.set(r.session, []);
  bySession.get(r.session).push(r);
}
const BOARD = /^mcp__overclick__/;
const short = (t) => (t ? t.replace(BOARD, "").replace(/^mcp__overclock(_dev)?__/, "app:") : t);
const med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
const sum = (xs) => xs.reduce((s, x) => s + (x ?? 0), 0);
const cost = (c) => Math.max(0, c.write_s ?? 0) + Math.max(0, c.server_s ?? 0);

const register = [], pilot = [], execute = [];
for (const [, rs] of bySession) {
  rs.sort((a, b) => a.seq - b.seq);
  let start = null;
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    if (r.human) { start = i; continue; }
    if (short(r.tool) === "task_create" && new Date(r.ts).toISOString() >= since && start !== null && !r.is_error) {
      const seg = rs.slice(start + 1, i + 1).filter((x) => !x.human);
      // ignore segments that also created other cards (batch registration)
      if (seg.filter((x) => short(x.tool) === "task_create").length !== 1) continue;
      const t0 = rs[start].ts, t1 = r.result_ts ?? r.ts;
      register.push({ seg, total_s: (t1 - t0) / 1000 });
      const k = rs.slice(i + 1, i + 6).findIndex((x) => !x.human && short(x.tool) === "app:pane_spawn");
      if (k >= 0) {
        const spawn = rs[i + 1 + k];
        const seg2 = rs.slice(start + 1, i + 2 + k).filter((x) => !x.human);
        pilot.push({ seg: seg2, total_s: ((spawn.result_ts ?? spawn.ts) - t0) / 1000, date: new Date(t0).toISOString() });
      }
    }
    if (short(r.tool) === "task_claim" && r.task_ref && new Date(r.ts).toISOString() >= since && !r.is_error) {
      const j = rs.findIndex((x, n) => n > i && !x.human && short(x.tool) === "task_deliver" && x.task_ref === r.task_ref && !x.is_error);
      if (j < 0) continue;
      const seg = rs.slice(i, j + 1).filter((x) => !x.human);
      execute.push({ seg, total_s: ((rs[j].result_ts ?? rs[j].ts) - r.ts) / 1000 });
    }
  }
}
function report(name, eps, boardOnly) {
  console.log(`\n=== ${name}: ${eps.length} real episodes (since ${since})`);
  if (!eps.length) return;
  const tools = new Map();
  for (const ep of eps) {
    const seen = new Map();
    for (const c of ep.seg) {
      const t = c.recipe ? "usage_recipe(Bash)" : short(c.tool);
      if (boardOnly && !BOARD.test(c.tool) && !c.recipe) continue;
      seen.set(t, (seen.get(t) ?? 0) + 1);
    }
    for (const [t, n] of seen) { if (!tools.has(t)) tools.set(t, []); tools.get(t).push(n); }
  }
  const rows = [...tools].map(([t, ns]) => [t, ns.length / eps.length, med(ns)]).sort((a, b) => b[1] - a[1]);
  console.log("tool: share of episodes that call it, median calls when called");
  console.log("  " + rows.filter((r) => r[1] >= 0.1).map(([t, f, m]) => `${t} ${Math.round(f * 100)}%×${m}`).join(" · "));
  const boardS = eps.map((ep) => sum(ep.seg.filter((c) => BOARD.test(c.tool) || c.recipe).map(cost)));
  const boardWrite = eps.map((ep) => sum(ep.seg.filter((c) => BOARD.test(c.tool) || c.recipe).map((c) => Math.max(0, c.write_s ?? 0))));
  const boardServer = eps.map((ep) => sum(ep.seg.filter((c) => BOARD.test(c.tool) || c.recipe).map((c) => Math.max(0, c.server_s ?? 0))));
  const readCh = eps.map((ep) => sum(ep.seg.filter((c) => BOARD.test(c.tool)).map((c) => c.result_chars ?? 0)));
  const allReadCh = eps.map((ep) => sum(ep.seg.map((c) => c.result_chars ?? 0)));
  const writeCh = eps.map((ep) => sum(ep.seg.filter((c) => BOARD.test(c.tool) || c.recipe).map((c) => c.args_chars ?? 0)));
  const pl = eps.map((ep) => sum(ep.seg.filter((c) => short(c.tool) === "project_list").map((c) => c.result_chars ?? 0)));
  console.log(`episode wall p50 ${med(eps.map((e) => e.total_s))?.toFixed(1)}s · board turns p50 ${med(boardS)?.toFixed(1)}s (model writing ${med(boardWrite)?.toFixed(1)}s + tool/server ${med(boardServer)?.toFixed(1)}s)`);
  console.log(`board chars written p50 ${med(writeCh)} · board chars read p50 ${med(readCh)} · all tool chars read p50 ${med(allReadCh)} · project_list chars p50 ${med(pl)}`);
  const withPl = eps.filter((ep, i) => pl[i] > 0);
  if (withPl.length) {
    const share = withPl.map((ep) => sum(ep.seg.filter((c) => short(c.tool) === "project_list").map((c) => c.result_chars)) / Math.max(1, sum(ep.seg.map((c) => c.result_chars ?? 0))));
    console.log(`episodes with project_list: ${withPl.length} · project_list share of ALL chars read p50 ${(med(share) * 100).toFixed(0)}%`);
  }
  // time per tool inside the flow
  const per = new Map();
  for (const ep of eps) for (const c of ep.seg) {
    const t = c.recipe ? "usage_recipe(Bash)" : short(c.tool);
    if (!BOARD.test(c.tool) && !c.recipe) continue;
    if (!per.has(t)) per.set(t, []);
    per.get(t).push(cost(c));
  }
  console.log("board time per call inside the flow (p50 s, N):  " + [...per].sort((a, b) => sum(b[1]) - sum(a[1])).map(([t, xs]) => `${t} ${med(xs).toFixed(1)}s N=${xs.length} Σ${(sum(xs) / eps.length).toFixed(1)}s/ep`).join(" · "));
}
if (process.argv.includes("--json")) {
  const per = (eps) => {
    const m = {};
    for (const ep of eps) for (const c of ep.seg) {
      if (!BOARD.test(c.tool) && !c.recipe) continue;
      const t = c.recipe ? "usage_recipe(Bash)" : short(c.tool);
      m[t] = (m[t] ?? 0) + 1;
    }
    for (const t of Object.keys(m)) m[t] = +(m[t] / eps.length).toFixed(2);
    return m;
  };
  fs.writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify({ register: per(register), execute: per(execute), n_register: register.length, n_execute: execute.length }));
}
report("REGISTER (prompt → task_create result)", register, false);
report("PILOT (prompt → task_create → pane_spawn result)", pilot, false);
report("EXECUTE (task_claim X → task_deliver X, same session)", execute, true);
if (process.argv.includes("--pilots")) for (const p of pilot.slice(-12)) {
  console.log(p.date, `total ${p.total_s.toFixed(1)}s`, p.seg.map((c) => `${c.recipe ? "recipe" : short(c.tool)}[w${(c.write_s ?? 0).toFixed(1)} s${(c.server_s ?? 0).toFixed(2)} r${c.result_chars}]`).join(" > "));
}
