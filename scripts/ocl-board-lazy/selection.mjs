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
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
const base = process.argv[2];
const cookie = readFileSync(process.env.COOKIE_ADMIN_FILE, "utf8");
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "ab_session", value: cookie, url: base }]);
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/board?organizations=all&projects=all&period=all&periodBy=updated&person=all`, { waitUntil: "networkidle" });
const count = (s) => page.$eval(`#board-col-${s} .col-head .count`, (el) => Number(el.textContent));
for (let i = 0; i < 2; i++) { await page.$eval("#board-col-feito .col-tail", (el) => el.scrollIntoView({ block: "end" })); await page.waitForTimeout(800); }
const held = await page.$$eval("#board-col-feito .col .card", (els) => els.length);
const [feito0, desc0] = [await count("feito"), await count("descartado")];
await page.click(".sel-toggle");
const cards = await page.$$("#board-col-feito .col .card");
const deep = cards.slice(-2);
for (const c of deep) await c.click();
const sel = await page.$eval(".sel-count", (el) => el.textContent);
console.log(`held ${held}, selection: ${sel}`);
const discardBtn = page.locator(".sel-bar button", { hasText: /Descart|Discard/ }).first();
await discardBtn.click();
await page.fill(".sel-reason", "bench: discard two cards from a scrolled page");
await page.locator(".sel-discard .sel-btn.danger").click();
await page.waitForTimeout(4000);
const [feito1, desc1] = [await count("feito"), await count("descartado")];
const heldAfter = await page.$$eval("#board-col-feito .col .card", (els) => els.length);
console.log(`feito ${feito0}→${feito1}, descartado ${desc0}→${desc1}, held ${held}→${heldAfter}, errors ${errors.length}`);
const ok = feito1 === feito0 - 2 && desc1 === desc0 + 2 && heldAfter >= held - 2 && errors.length === 0 && /2/.test(sel);
console.log(ok ? "PASS selection + discard on scrolled cards" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
