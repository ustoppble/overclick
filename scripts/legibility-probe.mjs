#!/usr/bin/env node
/**
 * The legibility probe (navigation plan E7).
 *
 * Two rules the board is held to, measured on the rendered page and not on
 * the CSS: no text is drawn below 12 px, and no text sits under 4.5:1 against
 * what is actually behind it. The style guards (`type-ramp.test.ts`,
 * `contrast.test.ts`) hold the declarations; this holds what reaches the
 * screen — an inherited `em`, a parent's opacity, a translucent panel over a
 * translucent card.
 *
 * How it measures: it walks every visible text node, skips what is covered
 * (a scrim, an open sheet) or hidden from assistive tech, and for each one
 * reads the computed font size and colour. The colour is composited over the
 * stack of backgrounds that really sit under the text, with every ancestor's
 * opacity multiplied in, and compared with WCAG's relative luminance. It also
 * asks the browser which font it rendered the body text with (DevTools'
 * "Rendered Fonts", CSS.getPlatformFontsForNode), so "the app serves Inter"
 * is a measurement too.
 *
 * It started as the DOM probe that measured the design mocks
 * (nav-sobrio), and it runs next to `check:topbar` and `check:sheet`.
 *
 * Usage:
 *   node scripts/legibility-probe.mjs
 *   node scripts/legibility-probe.mjs --shots ./out --widths 1728,1280,390
 *
 * Environment:
 *   BOARD_URL     origin of the app (default http://localhost:3000)
 *   BOARD_COOKIE  value of the ab_session cookie, for a board behind login
 *   CHROME_BIN    path to a Chrome or Chromium binary
 *   WIDTHS        comma separated widths (default 1440,390)
 *   THEMES        comma separated themes (default xai,overclock,nebula);
 *                 "none" opens without a theme cookie, as a first visit does
 *   PAGES         comma separated paths (default /board, the first card
 *                 with its sheet scrolled to the foot, the first mission,
 *                 /usage, every Settings group, /onboarding, and /login with
 *                 the session cookie dropped — the screens E7 raised to 12px)
 *   REPORT_ONLY   print the failures but exit 0 (for "before" shots)
 *
 * Exit code is 0 when every page, width and theme holds both rules and 1 when
 * any text breaks one.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_WIDTHS = [1440, 390];
const DEFAULT_THEMES = ["xai", "overclock", "nebula"];
const MIN_PX = 12;
const MIN_RATIO = 4.5;

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function parseArgs(argv) {
  const args = { shots: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") args.url = argv[++i];
    else if (argv[i] === "--shots") args.shots = argv[++i];
    else if (argv[i] === "--widths") args.widths = argv[++i];
    else if (argv[i] === "--themes") args.themes = argv[++i];
    else if (argv[i] === "--pages") args.pages = argv[++i];
  }
  return args;
}

const list = (value) =>
  (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome found. Set CHROME_BIN to a Chrome or Chromium binary.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Chrome writes the port it actually took into its profile directory. */
async function readPort(profile) {
  const file = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(file)) {
      const [port] = fs.readFileSync(file, "utf8").split("\n");
      if (port) return Number(port);
    }
    await sleep(100);
  }
  throw new Error("Chrome never reported its debugging port.");
}

/** The same dependency-free CDP client the other two guards carry. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  const open = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });
  return {
    ready: open,
    send(method, params = {}, sessionId) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
  }
  return result.result.value;
}

/**
 * Runs in the page. Kept as one string because it crosses into the browser
 * as source.
 */
const PROBE = `(() => {
  const MIN_PX = ${MIN_PX};
  const MIN_RATIO = ${MIN_RATIO};
  const parse = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const over = (top, bot) => {
    const a = top[3];
    return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1];
  };
  // Only ancestors whose box sits under the text count: a label that
  // overflows its bar is drawn on the panel, not on the bar.
  const bgOf = (el, px, py) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const b = e.getBoundingClientRect();
      const root = e === document.body || e === document.documentElement;
      if (!root && !(px >= b.left && px <= b.right && py >= b.top && py <= b.bottom)) continue;
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0) layers.push(c);
      if (c && c[3] >= 1) break;
    }
    let col = [0, 0, 0, 1];
    for (let i = layers.length - 1; i >= 0; i--) col = over(layers[i], col);
    return col;
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const out = { texts: 0, minSize: 99, minRatio: 99, fails: [] };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim()) continue;
    const el = t.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    if (el.closest("[aria-hidden='true'], .sr-only, svg, title, script, style, noscript")) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const range = document.createRange();
    range.selectNodeContents(t);
    const r = range.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    // A visually hidden label (1px clip) is for a screen reader, not the eye.
    if (r.width <= 1 && r.height <= 1) continue;
    const cx = Math.min(innerWidth - 1, Math.max(0, r.left + Math.min(r.width, 6)));
    const cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    if (hit && !(el.contains(hit) || hit.contains(el))) continue;
    const size = parseFloat(cs.fontSize);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el, r.left + r.width / 2, r.top + r.height / 2);
    const eff = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(el)], bg);
    const [hi, lo] = [lum(eff), lum(bg)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    // WCAG 1.4.3 exempts text in an inactive control (a disabled button is
    // drawn at .4 on purpose); its size is still held to the floor.
    const inactive = Boolean(el.closest(":disabled, [aria-disabled='true']"));
    out.texts++;
    out.minSize = Math.min(out.minSize, size);
    if (!inactive) out.minRatio = Math.min(out.minRatio, ratio);
    if (size < MIN_PX || (!inactive && ratio < MIN_RATIO)) {
      const cls = [...el.classList].join(".");
      out.fails.push(size + "px " + ratio.toFixed(2) + ":1 \\"" + t.textContent.trim().slice(0, 40) + "\\" <" + el.tagName.toLowerCase() + (cls ? "." + cls : "") + ">");
    }
  }
  out.minRatio = Number(out.minRatio.toFixed(2));
  return out;
})()`;

/** Scrolls the page and every scroll container to its end, so a sheet's foot is on screen. */
const SCROLL_TO_END = `(() => {
  for (const el of document.querySelectorAll("*")) {
    if (el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
})()`;

/** Texts whose size only the browser decides (<small>) must be on screen at least once. */
const SHRINKING_ON_SCREEN = `document.querySelectorAll(".release-usage small, small, sub, sup").length`;

/** Pages that are read signed out: the probe drops the session cookie for them. */
const PUBLIC_PAGES = new Set(["/login"]);

/** Settles hydration, the data fetches and web fonts before anything is read. */
const SETTLE = `(async () => { await document.fonts.ready; return document.documentElement.getAttribute("data-theme"); })()`;

/** The font the browser actually drew the body text with ("Rendered Fonts"). */
async function renderedFont(cdp, sessionId) {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
  for (const selector of [".card h4", ".gb-place", "h1", "h2", "button", "body"]) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector }, sessionId);
    if (!nodeId) continue;
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId }, sessionId);
    if (fonts?.length) return fonts.map((f) => f.familyName).join(" + ");
  }
  return "?";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const origin = new URL(args.url || process.env.BOARD_URL || "http://localhost:3000").origin;
  const widths = list(args.widths || process.env.WIDTHS).map(Number).filter((n) => n > 0);
  const sweep = widths.length ? widths : DEFAULT_WIDTHS;
  const themes = list(args.themes || process.env.THEMES);
  const themeSweep = themes.length ? themes : DEFAULT_THEMES;
  const cookie = process.env.BOARD_COOKIE || "";
  const reportOnly = Boolean(process.env.REPORT_ONLY);
  if (args.shots) fs.mkdirSync(args.shots, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "legibility-probe-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let cdp;
  let failed = false;
  try {
    const port = await readPort(profile);
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    cdp = connect(version.webSocketDebuggerUrl);
    await cdp.ready;
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    for (const domain of ["Page", "Runtime", "Network", "DOM", "CSS"]) {
      await cdp.send(`${domain}.enable`, {}, sessionId);
    }
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    }, sessionId);
    const host = new URL(origin).hostname;
    if (cookie) {
      await cdp.send("Network.setCookie", { name: "ab_session", value: cookie, domain: host, path: "/" }, sessionId);
    }

    const go = async (url) => {
      await cdp.send("Page.navigate", { url }, sessionId);
      await sleep(1500);
      return evaluate(cdp, sessionId, SETTLE);
    };

    let pages = list(args.pages || process.env.PAGES);
    if (!pages.length) {
      pages = ["/board"];
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      await go(`${origin}/board`);
      const card = await evaluate(cdp, sessionId, `(() => { const c = document.querySelector(".board .card .cid"); return c ? c.textContent.trim() : null; })()`);
      if (card) pages.push(`/cards/${card}`);
      await go(`${origin}/missions`);
      const mission = await evaluate(cdp, sessionId, `(() => { const a = document.querySelector(".ms-row"); return a ? a.getAttribute("href") : null; })()`);
      if (mission) pages.push(mission);
      pages.push(
        "/usage",
        "/settings/prices",
        "/settings/organizations-projects",
        "/settings/agents",
        "/settings/team",
        "/settings/system",
        "/onboarding",
        "/login",
      );
    }

    let shrinkingSeen = false;
    for (const theme of themeSweep) {
      if (theme === "none") {
        await cdp.send("Network.deleteCookies", { name: "oc-theme", domain: host }, sessionId);
      } else {
        await cdp.send("Network.setCookie", { name: "oc-theme", value: theme, domain: host, path: "/" }, sessionId);
      }
      for (const page of pages) {
        const url = new URL(page, origin).toString();
        const slug = new URL(url).pathname.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-") || "root";
        for (const width of sweep) {
          const mobile = width < 700;
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: mobile ? 844 : 900,
            deviceScaleFactor: mobile ? 2 : 1,
            mobile,
          }, sessionId);
          const pathname = new URL(url).pathname;
          if (cookie) {
            if (PUBLIC_PAGES.has(pathname)) {
              await cdp.send("Network.deleteCookies", { name: "ab_session", domain: host }, sessionId);
            } else {
              await cdp.send("Network.setCookie", { name: "ab_session", value: cookie, domain: host, path: "/" }, sessionId);
            }
          }
          const applied = await go(url);
          // A sheet's foot is below the fold: scroll to it before reading.
          if (pathname.startsWith("/cards/")) await evaluate(cdp, sessionId, SCROLL_TO_END);
          const audit = await evaluate(cdp, sessionId, PROBE);
          if (pathname === "/board" && !shrinkingSeen) {
            shrinkingSeen = (await evaluate(cdp, sessionId, SHRINKING_ON_SCREEN)) > 0;
          }
          const font = await renderedFont(cdp, sessionId);
          const bad = audit.fails.length > 0;
          if (bad) failed = true;
          console.log(
            `${bad ? "FAIL" : "ok  "} ${theme}/${slug} ${width}px  data-theme=${applied} texts=${audit.texts} min=${audit.minSize}px ${audit.minRatio}:1 font=${font}`,
          );
          for (const line of audit.fails.slice(0, 15)) console.log(`       ${line}`);
          if (audit.fails.length > 15) console.log(`       … and ${audit.fails.length - 15} more`);
          if (args.shots) {
            const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
            fs.writeFileSync(path.join(args.shots, `${theme}-${slug}-${width}.png`), Buffer.from(shot.data, "base64"));
          }
        }
      }
    }
    if (!shrinkingSeen) {
      console.log("note: no <small> on /board (a release header without notes); that rule is held by type-ramp.test.ts, not by this run");
    }
  } finally {
    cdp?.close();
    // Chrome still writes into its profile while it shuts down; remove the
    // directory once it has exited, and never fail the run over a temp dir.
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await Promise.race([exited, sleep(3000)]);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // left for the OS to clean up with the rest of tmpdir
    }
  }
  process.exit(failed && !reportOnly ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
