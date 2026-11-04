#!/usr/bin/env node
/**
 * The one-line guard for the top bar.
 *
 * The rule the board is held to: no label in the top bar ever breaks across
 * two lines. A control that runs out of room shrinks, truncates with an
 * ellipsis while the title keeps the full reading, or moves behind the phone
 * menu. It never wraps.
 *
 * OCL-82 added the second rule, one rung up from the first: where the bar has
 * collapsed behind the Filtros button, the whole chrome is ONE row. The line
 * rule above holds per control, so a bar could pass it while spending a rung
 * on the wordmark and another on the single button left beside it — which is
 * exactly what the board did on a phone. So the guard counts the bands the
 * visible controls sit on, and where the Filtros button is on screen it
 * requires exactly one. The wordmark counts even though it is drawn rather
 * than typed: it is one of the controls the row has to hold.
 *
 * A phone-sized check alone does not hold that rule: the regression this
 * script was written for showed up at 1440, where there is the most room, and
 * a 390 check was green the whole time. So the guard sweeps a list of widths
 * and measures the rendered text itself, not the CSS.
 *
 * How it measures: it walks the controls the bar lays out, and for each one it
 * takes a Range over every text node under it and counts the line boxes the
 * browser actually painted (getClientRects, grouped by their top edge). Two
 * boxes means two lines, which is the failure. Counting per control and not
 * per text node is what catches a label that breaks between its own pieces,
 * the way the crumb broke between the workspace name and the project. It also
 * reports a bar whose content is wider than the bar, since a control pushed
 * past the edge is a control nobody can reach.
 *
 * Usage:
 *   node scripts/topbar-one-line.mjs
 *   node scripts/topbar-one-line.mjs --url http://localhost:3000/board --shots ./out
 *
 * Environment:
 *   BOARD_URL     page to measure; a bare origin (the default,
 *                 http://localhost:3000) measures the board, the missions list
 *                 and the first mission's page
 *   BOARD_COOKIE  value of the ab_session cookie, for a board behind login
 *   CHROME_BIN    path to a Chrome or Chromium binary
 *   WIDTHS        comma separated widths (default 1728,1440,1280,1024,768,390,320)
 *   VERBOSE       print the width every control ended up with, and the width
 *                 it wanted, which is how you see what yielded and by how much
 *
 * Navigation plan E1 put a global bar above every signed-in page (places,
 * the work-state chips and the avatar) and left the board's filters on a line
 * of their own under it. Both are measured, each by the rules above: the
 * global bar is `.global-bar`, the filter line is the board's `.topbar-wrap`
 * (other screens may have no second bar at all). And one rule is new: the
 * "to review" count never drops. At every width it is on screen, either as
 * the chip in the global bar or, on the phone, as the Review tab of the
 * bottom bar.
 *
 * Navigation plan E3 gave the missions their own pages under the same bar:
 * with no URL given the guard measures /board, /missions and the first
 * mission's page (/missions/<id>, found on the list), each at every width.
 *
 * Navigation plan E4 put the scope and the search on the global bar and fixed
 * the order in which the bar steps aside as it narrows (nav README §2): first
 * the search turns into its icon, then the "running" word goes, then the
 * place names go, and "to review" never does. The guard reads which of them
 * are on screen at every width and fails a bar that let a later one go while
 * an earlier one stayed, or that lost the search or the scope altogether.
 *
 * Exit code is 0 when every width holds the rule and 1 when any width breaks
 * it, so this runs as a check in CI as easily as by hand.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_WIDTHS = [1728, 1440, 1280, 1024, 768, 390, 320];
const HEIGHT = 900;

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
  }
  return args;
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chrome found. Set CHROME_BIN to a Chrome or Chromium binary.",
  );
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

/**
 * A CDP client small enough to carry no dependency: Node has had a WebSocket
 * global since 22.4, and the protocol is one JSON message per call.
 */
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

/**
 * Runs in the page. Counts the line boxes under every label in the bar.
 * Kept as one string because it crosses into the browser as source.
 */
/** The bars a page may carry, in the order they are reported. */
const BARS = [
  { name: "global bar", selector: ".global-bar" },
  // OCL-35: the board's filter line is two levels inside .topbar-wrap; older
  // screens may still keep a bare .topbar.
  { name: "filter line", selector: ".topbar-wrap, .topbar" },
];

const measure = (selector) => `((barSelector) => {
  const bar = document.querySelector(barSelector);
  if (!bar) return { missing: true };

  const where = (el) => {
    const parts = [];
    for (let node = el; node && node !== bar; node = node.parentElement) {
      const cls = (node.className || "").toString().trim().split(/\\s+/)[0];
      parts.unshift(cls ? node.tagName.toLowerCase() + "." + cls : node.tagName.toLowerCase());
    }
    return "." + bar.className.split(/\\s+/)[0] + (parts.length ? " " + parts.join(" ") : "");
  };

  // The controls each level lays out. .topbar-more is display:contents on
  // the desktop and a stacked panel on the phone; either way its children
  // are the controls, and the wrapper itself is never one line by design.
  const levels =
    bar.classList.contains("topbar-wrap") || bar.classList.contains("global-bar")
      ? Array.from(bar.children)
      : [bar];
  // The groups that only arrange controls: their children are the controls.
  const GROUPS = ["topbar-more", "gb-places", "gb-right"];
  const controls = [];
  for (const level of levels) {
    for (const child of level.children) {
      if (GROUPS.some((cls) => child.classList.contains(cls))) controls.push(...child.children);
      else controls.push(child);
    }
  }

  // A line is a band of vertical overlap, not a shared top edge: a chip that
  // sets a 19px figure beside a 10px caption aligns them on one baseline and
  // their tops differ by design. Boxes that overlap vertically are the same
  // line; a box that clears the band below it is a second line. The same
  // counting answers both questions the guard asks — how many lines a label
  // took, and how many rows the bar itself took.
  const bands = (boxes) => {
    boxes.sort((a, b) => a.top - b.top);
    let lines = 0;
    let bandBottom = -Infinity;
    for (const box of boxes) {
      if (box.top >= bandBottom) {
        lines += 1;
        bandBottom = box.bottom;
      } else if (box.bottom > bandBottom) {
        bandBottom = box.bottom;
      }
    }
    return lines;
  };

  const offenders = [];
  const measured = [];
  // OCL-82: the rows the chrome itself spends. Collected before the text walk,
  // because a control with no text of its own — the wordmark, which is drawn —
  // still occupies a row.
  const chromeBoxes = [];
  for (const control of controls) {
    const style = getComputedStyle(control);
    if (style.display === "none" || style.visibility === "hidden") continue;

    const own = control.getBoundingClientRect();
    if (own.width > 0 && own.height > 0) {
      chromeBoxes.push({ top: own.top, bottom: own.bottom });
    }

    const boxes = [];
    const pieces = [];
    const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue || "").replace(/\\s+/g, " ").trim();
      if (!text) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.display === "none" || parentStyle.visibility === "hidden") continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 0 && r.height > 0,
      );
      if (!rects.length) continue;
      pieces.push(text);
      for (const rect of rects) boxes.push({ top: rect.top, bottom: rect.bottom });
    }
    if (!pieces.length) continue;

    const entry = {
      text: pieces.join(" "),
      lines: bands(boxes),
      width: Math.round(control.getBoundingClientRect().width),
      natural: control.scrollWidth,
      where: where(control),
    };
    measured.push(entry);
    if (entry.lines > 1) offenders.push(entry);
  }

  // A control squeezed narrower than what it holds does not wrap and does not
  // overflow the bar: it draws over its neighbour. On one line that is the
  // failure the line count cannot see, so the painted boxes of the controls
  // (their descendants included) must not cross each other.
  const painted = [];
  for (const control of controls) {
    const style = getComputedStyle(control);
    if (style.display === "none" || style.visibility === "hidden") continue;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const el of [control, ...control.querySelectorAll("*")]) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "absolute" || cs.position === "fixed") continue;
      // what an open panel hangs below the bar is not on the line
      if (el.closest("[role=dialog], [role=listbox], [role=menu], .pf-panel, .mf-panel, .period-panel, .ff-panel, .gb-menu")) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
    if (right > left) painted.push({ left, right, top, bottom, where: where(control) });
  }
  const overlaps = [];
  for (let i = 0; i < painted.length; i += 1) {
    for (let j = i + 1; j < painted.length; j += 1) {
      const a = painted[i];
      const b = painted[j];
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 1 && y > 1) overlaps.push(a.where + " and " + b.where + " by " + Math.round(x) + "px");
    }
  }

  return {
    offenders,
    overlaps,
    labels: measured.length,
    measured,
    rows: bands(chromeBoxes),
    barWidth: Math.round(bar.clientWidth),
    contentWidth: Math.round(bar.scrollWidth),
    overflow: Math.max(0, Math.round(bar.scrollWidth - bar.clientWidth)),
    menuVisible: (() => {
      const btn = bar.querySelector(".filters-btn");
      return Boolean(btn && getComputedStyle(btn).display !== "none");
    })(),
  };
})(${JSON.stringify(selector)})`;

/**
 * The rule that never bends: "to review" is on screen at every width. The
 * chip in the global bar, or the Review tab of the phone's bottom bar. A box
 * counts only when it is drawn and inside the viewport.
 */
const REVIEW_VISIBLE = `(() => {
  if (!document.querySelector(".global-bar")) return { applies: false };
  const shown = (el) => {
    if (!el) return false;
    for (let node = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
  };
  if (shown(document.querySelector(".global-bar .gb-chip-review"))) return { applies: true, where: "global bar" };
  if (shown(document.querySelector(".gb-tabbar .gb-tab-review"))) return { applies: true, where: "bottom bar" };
  return { applies: true, where: null };
})()`;

/**
 * The fixed order the global bar steps aside in (E4). Each step may go only
 * after every step before it went: the search field (to its icon), the
 * running chip's word, the place names. The scope and the search, in one form
 * or the other, never leave.
 */
const FALL_ORDER = `(() => {
  const bar = document.querySelector(".global-bar");
  if (!bar) return { applies: false };
  const shown = (el) => {
    if (!el) return false;
    for (let node = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth;
  };
  return {
    applies: true,
    scope: shown(bar.querySelector(".gb-scope")),
    field: shown(bar.querySelector(".gb-search-form")),
    icon: shown(bar.querySelector(".gb-search-btn")),
    runLabel: shown(bar.querySelector(".gb-chip-run .gb-lbl")),
    placeNames: Array.from(bar.querySelectorAll(".gb-place span")).some(shown),
  };
})()`;

/** What the fall order owes at a width, or null when it holds. */
function fallOrderBreak(state) {
  if (!state.applies) return null;
  if (!state.scope) return "the scope left the bar";
  if (!state.field && !state.icon) return "the search left the bar, field and icon both";
  if (state.field && state.icon) return "the search shows as a field and an icon at once";
  // A step may be gone only once every step before it is gone.
  if (!state.runLabel && state.field) return "the running word went while the search was still a field";
  if (!state.placeNames && state.runLabel) return "the place names went while the running word stayed";
  return null;
}

const OPEN_MENU = `(() => {
  const btn = document.querySelector(".filters-btn");
  if (!btn || getComputedStyle(btn).display === "none") return false;
  if (btn.getAttribute("aria-expanded") !== "true") btn.click();
  return true;
})()`;

const CLOSE_MENU = `(() => {
  const btn = document.querySelector(".filters-btn");
  if (btn && btn.getAttribute("aria-expanded") === "true") btn.click();
  return true;
})()`;

async function evaluate(cdp, session, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    session,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "evaluate failed");
  }
  return result.result.value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const given = args.url || process.env.BOARD_URL || "http://localhost:3000";
  const origin = new URL(given).origin;
  // A bare origin measures the board and the missions; a path, that page only.
  const asked = new URL(given).pathname === "/" ? null : given;
  const widths = (args.widths || process.env.WIDTHS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const sweep = widths.length ? widths : DEFAULT_WIDTHS;
  const cookie = process.env.BOARD_COOKIE || "";
  if (args.shots) fs.mkdirSync(args.shots, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "topbar-guard-"));
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
      "--force-device-scale-factor=1",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let cdp;
  let failed = false;
  try {
    const port = await readPort(profile);
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) =>
      r.json(),
    );
    cdp = connect(version.webSocketDebuggerUrl);
    await cdp.ready;

    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    if (cookie) {
      const target = new URL(origin);
      await cdp.send(
        "Network.setCookie",
        {
          name: "ab_session",
          value: cookie,
          domain: target.hostname,
          path: "/",
        },
        sessionId,
      );
    }

    // One page when asked for one; otherwise the board and the missions (E3).
    const pages = asked ? [asked] : [`${origin}/board`, `${origin}/missions`];
    if (!asked) {
      await cdp.send("Page.navigate", { url: `${origin}/missions` }, sessionId);
      await sleep(1200);
      const first = await evaluate(
        cdp,
        sessionId,
        `(() => { const a = document.querySelector(".ms-row"); return a ? a.getAttribute("href") : null; })()`,
      );
      if (first) pages.push(`${origin}${first}`);
      else console.log("  note: no mission on /missions, so no /missions/<id> to measure");
    }
    for (const url of pages) {
      console.log(`one-line guard on ${url}`);
      const slug = new URL(url).pathname.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-") || "root";
      for (const width of sweep) {
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width, height: HEIGHT, deviceScaleFactor: 1, mobile: width < 700 },
          sessionId,
        );
        await cdp.send("Page.navigate", { url }, sessionId);
        // The bar is server rendered; this settles hydration and web fonts.
        await sleep(1200);
        await evaluate(cdp, sessionId, CLOSE_MENU);

        const review = await evaluate(cdp, sessionId, REVIEW_VISIBLE);
        if (review.applies) {
          if (review.where) {
            console.log(`  ok   ${width}px: "to review" on screen, in the ${review.where}`);
          } else {
            failed = true;
            console.log(`  FAIL ${width}px: "to review" is not on screen`);
          }
        }

        const fall = await evaluate(cdp, sessionId, FALL_ORDER);
        if (fall.applies) {
          const steps = `search ${fall.field ? "field" : "icon"} · running word ${fall.runLabel ? "on" : "off"} · place names ${fall.placeNames ? "on" : "off"}`;
          const broken = fallOrderBreak(fall);
          if (broken) {
            failed = true;
            console.log(`  FAIL ${width}px: fall order broken, ${broken} (${steps})`);
          } else {
            console.log(`  ok   ${width}px: fall order holds (${steps})`);
          }
        }

        const rows = [];
        for (const { name, selector } of BARS) {
          const closed = await evaluate(cdp, sessionId, measure(selector));
          if (closed.missing) continue;
          rows.push({ state: "bar", name, ...closed });
          if (closed.menuVisible) {
            await evaluate(cdp, sessionId, OPEN_MENU);
            await sleep(250);
            rows.push({ state: "menu open", name, ...(await evaluate(cdp, sessionId, measure(selector))) });
            await evaluate(cdp, sessionId, CLOSE_MENU);
            await sleep(150);
          }
        }
        if (rows.length === 0) throw new Error(`${width}px: no bar on this page`);

        for (const row of rows) {
          const label = `${width}px ${row.name} (${row.state})`;
          if (row.offenders.length) {
            failed = true;
            console.log(
              `  FAIL ${label}: ${row.offenders.length} of ${row.labels} labels wrap`,
            );
            for (const item of row.offenders) {
              console.log(
                `        ${item.lines} lines  "${item.text}"  at ${item.where}`,
              );
            }
          } else {
            console.log(`  ok   ${label}: ${row.labels} labels, one line each`);
          }
          // OCL-82: on the phone the collapsed bar (Filtros button on screen)
          // owes one row. Since the owner's "esse menu em 2 linhas me incomoda"
          // the desktop owes one too: wordmark, filters, state, cost and menu on
          // a single line at every width, with what does not fit stepping aside.
          if (row.state === "bar") {
            if (row.rows === 1) {
              console.log(`  ok   ${label}: one row of chrome`);
            } else {
              failed = true;
              console.log(
                `  FAIL ${label}: the bar spends ${row.rows} rows of chrome, and it may spend one`,
              );
            }
          }
          if (process.env.VERBOSE) {
            for (const item of row.measured) {
              console.log(`        ${String(item.width).padStart(5)}px of ${String(item.natural).padEnd(5)} ${item.where}  "${item.text}"`);
            }
          }
          if (row.state === "bar" && row.overlaps.length) {
            failed = true;
            for (const overlap of row.overlaps) {
              console.log(`  FAIL ${label}: ${overlap} draw over each other`);
            }
          }
          if (row.overflow > 1) {
            failed = true;
            console.log(
              `  FAIL ${label}: the bar overflows by ${row.overflow}px (${row.contentWidth} in ${row.barWidth})`,
            );
          }
        }

        if (args.shots) {
          await evaluate(cdp, sessionId, CLOSE_MENU);
          await sleep(150);
          const shot = await cdp.send(
            "Page.captureScreenshot",
            { format: "png", captureBeyondViewport: false },
            sessionId,
          );
          const file = path.join(args.shots, `topbar-${slug}-${width}.png`);
          fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
          console.log(`       shot ${file}`);
        }
      }
    }
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    // Chrome is still flushing its profile as it dies, so the first rmdir can
    // lose the race. Retrying keeps a passing run from failing on cleanup.
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  if (failed) {
    console.log("\nthe one-line rule is broken. See the widths marked FAIL.");
    process.exit(1);
  }
  console.log("\nevery width holds the one-line rule.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
