// OCL board lazy — how the board's weight was measured, before and after.
//
// Setup (a throwaway Postgres, never a server):
//   initdb + pg_ctl start on a local socket; DATABASE_URL to it
//   pnpm db:migrate && psql -f scripts/ocl-board-lazy/seed.sql   (3,595 cards, production's shape)
//   AUTH_SECRET=<32+ chars>; pnpm build; next start on localhost
// Run (from a directory with playwright-core, jose and postgres installed):
//   CHROME_BIN=<chrome-headless-shell> node measure.mjs <origin> <label>
//   COOKIE_ADMIN_FILE=… COOKIE_MEMBER_FILE=… node functional.mjs <origin>
// Session cookies are signed locally with AUTH_SECRET and read from files,
// never printed.
// Board weight: server time + bytes (HTML, RSC) and browser cost (DOM, long
// tasks at 4x CPU) for 7d / all time × one project / all projects.
// Usage: node measure.mjs <baseUrl> <label>   (env: DATABASE_URL, AUTH_SECRET)
import { SignJWT } from "jose";
import postgres from "postgres";
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const [base, label = "run"] = process.argv.slice(2);
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [admin] = await sql`select id, session_version from "user" where role = 'admin' order by email limit 1`;
const [proj] = await sql`select p.id, count(t.id)::int n from project p join task t on t.project_id = p.id group by p.id order by p.name limit 1`;
await sql.end();
const token = await new SignJWT({ userId: admin.id, sessionVersion: admin.session_version })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1d")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
const cookie = `ab_session=${token}`;

const cases = [];
for (const period of ["7d", "all"]) {
  cases.push({ name: `${period} · 1 projeto`, q: `organizations=all&projects=${proj.id}&period=${period}&periodBy=updated&person=all` });
  cases.push({ name: `${period} · todos`, q: `organizations=all&projects=all&period=${period}&periodBy=updated&person=all` });
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function timedFetch(url, headers = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { cookie, ...headers }, redirect: headers.RSC ? "follow" : "manual" });
  const body = Buffer.from(await res.arrayBuffer());
  return { ms: performance.now() - t0, bytes: body.length, status: res.status };
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN });
const out = [];
for (const c of cases) {
  const url = `${base}/board?${c.q}`;
  // warm
  await timedFetch(url);
  const html = [];
  const rsc = [];
  for (let i = 0; i < 3; i++) html.push(await timedFetch(url));
  for (let i = 0; i < 3; i++) rsc.push(await timedFetch(url, { RSC: "1" }));
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([{ name: "ab_session", value: token, url: base }]);
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__lt = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__lt.push(e.duration);
      }).observe({ type: "longtask", buffered: true });
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    await page.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => {});
    const settled = Date.now() - t0;
    await page.waitForTimeout(1000);
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const lt = window.__lt;
      return {
        domNodes: document.getElementsByTagName("*").length,
        cards: document.querySelectorAll(".board .card, .board [data-card-id]").length,
        ttfb: nav.responseStart,
        responseEnd: nav.responseEnd,
        dcl: nav.domContentLoadedEventEnd,
        load: nav.loadEventEnd,
        longTasks: lt.length,
        longTaskMs: lt.reduce((a, b) => a + b, 0),
        longTaskMax: lt.reduce((a, b) => Math.max(a, b), 0),
        tbt: lt.reduce((a, b) => a + Math.max(0, b - 50), 0),
      };
    });
    runs.push({ ...m, settled });
    await ctx.close();
  }
  const pick = (k) => Math.round(median(runs.map((r) => r[k])));
  const row = {
    case: c.name,
    serverHtmlMs: Math.round(median(html.map((r) => r.ms))),
    htmlKB: Math.round(median(html.map((r) => r.bytes)) / 1024),
    rscKB: Math.round(median(rsc.map((r) => r.bytes)) / 1024),
    status: html[0].status,
    ttfb: pick("ttfb"),
    load: pick("load"),
    settled: pick("settled"),
    domNodes: pick("domNodes"),
    longTasks: pick("longTasks"),
    longTaskMs: pick("longTaskMs"),
    longTaskMax: pick("longTaskMax"),
    tbt: pick("tbt"),
  };
  out.push(row);
  console.log(JSON.stringify(row));
}
await browser.close();
writeFileSync(`measure-${label}.json`, JSON.stringify({ project: proj.n, rows: out }, null, 2));
