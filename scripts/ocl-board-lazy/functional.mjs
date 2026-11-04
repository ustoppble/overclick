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
// Functional checks of the board loaded by page. Usage: node functional.mjs <base>
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { chromium } from "playwright-core";

const base = process.argv[2];
const admin = readFileSync(process.env.COOKIE_ADMIN_FILE, "utf8");
const member = readFileSync(process.env.COOKIE_MEMBER_FILE, "utf8");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_BIN,
});
async function open(cookie, url, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: "ab_session", value: cookie, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}${url}`, { waitUntil: "networkidle" });
  return { ctx, page, errors };
}
const colIds = (page, status) =>
  page.$$eval(`#board-col-${status} .col .card`, (els) =>
    els.map((el) => el.querySelector(".card-id, .short-id, [data-short-id]")?.textContent ?? el.textContent.slice(0, 40)),
  );
const colCount = (page, status) => page.$eval(`#board-col-${status} .col-head .count`, (el) => Number(el.textContent));

// 1. All time, every project: exact counts, first pages only, scroll brings the rest.
const [{ n: doneAll }] = await sql`select count(*)::int n from task where status = 'feito'`;
{
  const { ctx, page, errors } = await open(admin, "/board?organizations=all&projects=all&period=all&periodBy=updated&person=all");
  const count = await colCount(page, "feito");
  check("count of Feito is exact for all time", count === doneAll, `${count} vs ${doneAll}`);
  const first = (await colIds(page, "feito")).length;
  check("Feito starts with one page", first === 40, `${first}`);
  check("no 'older' text or button on the board", !(await page.content()).match(/mais antigos|Ver mais|older cards/i));
  // Scroll Feito's end into view repeatedly.
  for (let i = 0; i < 6; i++) {
    await page.$eval("#board-col-feito .col-tail", (el) => el.scrollIntoView({ block: "end" })).catch(() => {});
    await page.waitForTimeout(700);
  }
  const ids = await colIds(page, "feito");
  check("scrolling brings more pages", ids.length > 200, `${ids.length} cards held`);
  check("no card twice after scrolling", new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} dupes`);
  const scrollY = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el.scrollTop;
  });
  // Poll: touch a card so the signature moves, then let the 20 s poll run.
  const [touched] = await sql`update task set updated_at = now() where id = (select id from task where status = 'feito' order by updated_at asc limit 1) returning short_id`;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(23_000);
  const after = await colIds(page, "feito");
  check("the poll keeps the pages scrolled in", after.length >= ids.length, `${after.length} after vs ${ids.length}`);
  check("no card twice after the poll", new Set(after).size === after.length);
  const top = await page.$eval("#board-col-feito .col .card", (el) => el.textContent);
  check("the poll brought the change (touched card now first)", top.includes(touched.short_id), touched.short_id);
  const scrollAfter = await page.evaluate(() => document.scrollingElement.scrollTop);
  check("the poll keeps the scroll position", Math.abs(scrollAfter - scrollY) < 400, `${scrollY} → ${scrollAfter}`);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// 2. One project in the bar: the server reads only that project.
{
  const [proj] = await sql`select p.id, count(t.id)::int n from project p join task t on t.project_id = p.id group by p.id order by p.name limit 1`;
  const { ctx, page } = await open(admin, `/board?organizations=all&projects=${proj.id}&period=all&periodBy=updated&person=all`);
  const total = (await Promise.all(["aberto", "em_execucao", "feito", "validado", "descartado"].map((s) => colCount(page, s)))).reduce((a, b) => a + b, 0);
  check("one project: column counts add up to the project's cards", total === proj.n, `${total} vs ${proj.n}`);
  // A type filter re-reads the columns from the server, exact.
  const [{ n: bugs }] = await sql`select count(*)::int n from task where project_id = ${proj.id} and tipo = 'bug' and status = 'feito'`;
  await page.goto(`${base}/board?organizations=all&projects=${proj.id}&period=all&periodBy=updated&person=all&types=bug`, { waitUntil: "networkidle" });
  check("type filter counts exact", (await colCount(page, "feito")) === bugs);
  await ctx.close();
}

// 3. Search and link reach a card outside every loaded page.
{
  const [old] = await sql`select short_id, title from task where status = 'feito' order by updated_at asc limit 1 offset 5`;
  const { ctx, page } = await open(admin, `/board?organizations=all&projects=all&period=all&periodBy=updated&person=all&card=${old.short_id}`);
  const sheet = await page.waitForSelector(".detail, .sheet, [role=dialog]", { timeout: 15_000 }).catch(() => null);
  const text = sheet ? await sheet.textContent() : "";
  check("?card= opens a card outside the pages", Boolean(sheet) && text.includes(old.short_id), old.short_id);
  await ctx.close();
  const byPath = await open(admin, `/cards/${old.short_id}`);
  const sheet2 = await byPath.page.waitForSelector(".detail, .sheet, [role=dialog]", { timeout: 15_000 }).catch(() => null);
  check("/cards/<id> opens a card outside the pages", Boolean(sheet2));
  await byPath.ctx.close();
  const s = await open(admin, `/board?organizations=all&projects=all&period=all&periodBy=updated&person=all&q=${encodeURIComponent(old.short_id)}`);
  await s.page.waitForTimeout(2500);
  const found = await s.page.$$eval(".board .card", (els) => els.map((el) => el.textContent));
  check("search finds a card outside the pages", found.some((t) => t.includes(old.short_id)), `${found.length} shown`);
  await s.ctx.close();
}

// 4. A member: asking for a project they are not linked to shows nothing of it.
{
  const [side] = await sql`select p.id from project p where p.id not in (select project_id from project_member) order by p.name limit 1`;
  const { ctx, page } = await open(member, `/board?organizations=all&projects=${side.id}&period=all&periodBy=updated&person=all`);
  const shownText = await page.$$eval(".board .card", (els) => els.map((el) => el.textContent).join(" "));
  const sideIds = (await sql`select short_id from task where project_id = ${side.id}`).map((r) => r.short_id);
  const leaked = sideIds.filter((id) => new RegExp(`${id}(?!\\d)`).test(shownText));
  check("member: an unlinked project in the address leaks no card", sideIds.length > 0 && leaked.length === 0, `${leaked.length} of ${sideIds.length} leaked`);
  await ctx.close();
}

// 5. Phone: the list shows the exact count and loads more by scroll.
{
  const { ctx, page, errors } = await open(admin, "/board?organizations=all&projects=all&period=all&periodBy=updated&person=all", { width: 390, height: 844 });
  await page.selectOption(".ml-status", "feito");
  await page.waitForTimeout(300);
  const count = await page.$eval(".board-mobile .ml-head .count", (el) => Number(el.textContent));
  check("phone: exact count", count === doneAll + 0 || count === doneAll, `${count}`);
  const before = await page.$$eval(".board-mobile .ml-row", (els) => els.length);
  for (let i = 0; i < 3; i++) {
    await page.$eval(".board-mobile .col-tail", (el) => el.scrollIntoView({ block: "end" })).catch(() => {});
    await page.waitForTimeout(700);
  }
  const after = await page.$$eval(".board-mobile .ml-row", (els) => els.length);
  check("phone: scrolling brings more rows", after > before, `${before} → ${after}`);
  check("phone: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
await sql.end();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
