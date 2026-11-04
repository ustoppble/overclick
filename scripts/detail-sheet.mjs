#!/usr/bin/env node
/**
 * The sheet guard for the card detail.
 *
 * The rule the board is held to below the mobile breakpoint: opening a card
 * takes the whole screen and nothing of the list survives the transition. No
 * strip at the edges, and no frame of the entrance where the list's text and
 * the card's text are on the screen at the same time.
 *
 * A screenshot of the settled panel cannot see that: the overlap the bug
 * showed lasted a fifth of a second. So this guard freezes the entrance and
 * walks it. It pauses every animation before the card is opened, seeks them
 * to a list of progresses, and at each one it captures the frame twice: once
 * with the board list rendered and once with the list hidden. If any pixel of
 * the list reached the screen the two frames differ, and the difference is
 * counted and reported. Identical frames are the proof that at that instant
 * the sheet was the only thing painted.
 *
 * It also checks the two things a sheet owes the hand holding the phone: the
 * way out is on screen without scrolling, and the page behind does not move
 * while the sheet is open and comes back exactly where it was.
 *
 * The desktop is measured too, for the opposite reason: at 1440 the detail
 * must still be the centred panel it has always been, with the board visible
 * around it.
 *
 * And the record of what ran (E2): the card opened is one that ran, and its
 * "Attempts" section must list one row per attempt, each naming what ran,
 * none of them wider than the sheet. At 1440 the running card's own box is
 * printed too, so a change to it shows in the PR.
 *
 * And the card's own address (navigation plan E3): opening a card from the
 * board puts /cards/<id> on the address bar and closing it goes back to the
 * board; Back closes the sheet without reloading the board; the address opened
 * directly shows the sheet over the board, a reload keeps it open, and Back
 * from there lands on the board with its cards.
 *
 * Usage:
 *   node scripts/detail-sheet.mjs
 *   node scripts/detail-sheet.mjs --shots ./out
 *
 * Environment:
 *   BOARD_URL     page to measure (default http://localhost:3000/board)
 *   BOARD_COOKIE  value of the ab_session cookie, for a board behind login
 *   CHROME_BIN    path to a Chrome or Chromium binary
 *   WIDTHS        comma separated phone widths (default 390,320)
 *   SHEET_CARD    short id of the card to open (default: the first that ran)
 *
 * Exit code is 0 when every width holds the rule and 1 when any breaks it.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PHONE_WIDTHS = [390, 320];
const DESKTOP_WIDTH = 1440;
const HEIGHT = 844;
const DESKTOP_HEIGHT = 900;
/* Where the entrance is sampled, as a fraction of its own duration. Zero is
   the first frame, the one the old panel spent at opacity zero. */
const PROGRESS = [0, 0.05, 0.15, 0.3, 0.5, 0.75, 1];

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
  throw new Error("No Chrome found. Set CHROME_BIN to a Chrome or Chromium binary.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** A CDP client small enough to carry no dependency, as in the topbar guard. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = [];
  let nextId = 0;

  const open = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), {
      once: true,
    });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method) {
      for (const listener of listeners) listener(message);
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });

  return {
    ready: open,
    on(listener) {
      listeners.push(listener);
    },
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

/** The list, in both arrangements: the desktop columns and the phone rows. */
const LIST_SELECTOR = ".board, .board-mobile";

const HIDE_LIST = `(() => {
  let style = document.getElementById("sheet-guard-hide");
  if (!style) {
    style = document.createElement("style");
    style.id = "sheet-guard-hide";
    document.head.appendChild(style);
  }
  style.textContent = "${LIST_SELECTOR} { visibility: hidden !important; }";
  return true;
})()`;

const SHOW_LIST = `(() => {
  const style = document.getElementById("sheet-guard-hide");
  if (style) style.textContent = "";
  return true;
})()`;

/**
 * Opens a card the layout in use actually shows, one that ran when there is
 * one (its line carries the CLI mark), so the attempts are there to measure.
 */
const OPEN_CARD = `(() => {
  const wanted = ${JSON.stringify(process.env.SHEET_CARD || "")};
  const rows = [...document.querySelectorAll(".board-mobile .ml-row, .board .card")]
    .filter((row) => row.getClientRects().length);
  const ranRow = (row) => Boolean(row.querySelector(".cli-mark, .cli-name, .meta-harness"));
  const named = wanted
    ? rows.find((row) => (row.querySelector(".cid")?.textContent || "").trim() === wanted)
    : null;
  const row = named || rows.find(ranRow) || rows[0];
  if (!row) return { opened: false, ran: false, id: null };
  const id = (row.querySelector(".cid")?.textContent || "").trim();
  row.click();
  return { opened: true, ran: ranRow(row), id };
})()`;

/** Where the page is, and whether the card sheet is on screen. */
const WHERE = `(() => ({
  path: location.pathname + location.search,
  sheet: Boolean(document.querySelector(".ov .d-close")),
  cards: document.querySelectorAll(".board .card").length,
  kept: window.__sheetGuardMark === true,
}))()`;

/**
 * The phone shows one column at a time and opens on the first with cards,
 * which may hold none that ran. Switch it to the done column then, so the
 * card the guard opens has attempts to measure.
 */
const SHOW_RAN_COLUMN = `(() => {
  const wanted = ${JSON.stringify(process.env.SHEET_CARD || "")};
  const rows = [...document.querySelectorAll(".board-mobile .ml-row")];
  const has = rows.some((row) =>
    wanted
      ? (row.querySelector(".cid")?.textContent || "").trim() === wanted
      : row.querySelector(".cli-mark, .cli-name"));
  const select = document.querySelector(".board-mobile .ml-status");
  if (has || !select) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
  setter.call(select, "feito");
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;

/** The attempts section of the open card: one row per attempt, inside the sheet. */
const ATTEMPTS = `(() => {
  const detail = document.querySelector(".detail");
  if (!detail) return { error: "no detail open" };
  const section = detail.querySelector(".d-attempts");
  if (!section) return { present: false };
  const panel = detail.getBoundingClientRect();
  const rows = [...section.querySelectorAll(".d-attempt")];
  return {
    present: true,
    count: Number(section.dataset.count),
    rows: rows.length,
    empty: rows.filter((row) => !(row.querySelector(".d-attempt-run")?.textContent || "").trim()).length,
    wide: rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.right > panel.right + 1 || row.scrollWidth > row.clientWidth + 1;
    }).length,
  };
})()`;

/** The running card's own box, which the executors grid used to share a rule with. */
const RUNNING_CARD = `(() => {
  const card = document.querySelector(".board .card.exec");
  if (!card) return null;
  const style = getComputedStyle(card);
  return {
    padding: style.padding,
    radius: style.borderRadius,
    border: style.borderTopColor,
    background: style.backgroundColor,
  };
})()`;

function checkAttempts(label, opened, attempts) {
  if (!opened.ran) {
    console.log(`  note ${label}: no card on this board has run; the attempts went unchecked`);
    return true;
  }
  if (attempts.error || !attempts.present) {
    console.log(`  FAIL ${label}: the card ran and its sheet has no attempts section`);
    return false;
  }
  if (attempts.rows !== attempts.count || attempts.rows === 0) {
    console.log(`  FAIL ${label}: the attempts section lists ${attempts.rows} rows for ${attempts.count} attempts`);
    return false;
  }
  if (attempts.empty > 0 || attempts.wide > 0) {
    console.log(
      `  FAIL ${label}: ${attempts.empty} attempt rows name nothing, ${attempts.wide} run past the sheet`,
    );
    return false;
  }
  console.log(`  ok   ${label}: ${attempts.rows} attempts listed, each naming what ran, all inside the sheet`);
  return true;
}

/** What the overlay is made of, read from the page and not from the source. */
const SURFACE = `(() => {
  const ov = document.querySelector(".ov");
  const detail = document.querySelector(".detail");
  if (!ov || !detail) return { error: "no detail open" };
  const alpha = (color) => {
    const parts = color.match(/[\\d.]+/g);
    if (!parts) return 1;
    return parts.length > 3 ? Number(parts[3]) : 1;
  };
  const ovStyle = getComputedStyle(ov);
  const detailStyle = getComputedStyle(detail);
  const box = ov.getBoundingClientRect();
  const panel = detail.getBoundingClientRect();
  return {
    ovOpacity: Number(ovStyle.opacity),
    ovAlpha: alpha(ovStyle.backgroundColor),
    ovBackdrop: ovStyle.backdropFilter || ovStyle.webkitBackdropFilter || "none",
    detailOpacity: Number(detailStyle.opacity),
    detailAlpha: alpha(detailStyle.backgroundColor),
    covers:
      box.left <= 0 && box.top <= 0 &&
      box.right >= window.innerWidth && box.bottom >= window.innerHeight,
    panel: { left: Math.round(panel.left), right: Math.round(panel.right),
             top: Math.round(panel.top), width: Math.round(panel.width) },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

/** The way out, after the sheet's own content has been scrolled to its end. */
const CLOSE_REACH = `(() => {
  const detail = document.querySelector(".detail");
  const close = document.querySelector(".d-close");
  if (!detail || !close) return { error: "no detail open" };
  const scroller = detail.scrollHeight > detail.clientHeight ? detail : document.querySelector(".ov");
  scroller.scrollTop = scroller.scrollHeight;
  const box = close.getBoundingClientRect();
  return {
    scrolled: Math.round(scroller.scrollTop),
    onScreen:
      box.top >= 0 && box.left >= 0 &&
      box.bottom <= window.innerHeight && box.right <= window.innerWidth,
    size: { width: Math.round(box.width), height: Math.round(box.height) },
  };
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

async function shoot(cdp, session) {
  const shot = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    session,
  );
  return Buffer.from(shot.data, "base64");
}

/** The address a card opens at, as the board writes it. */
function cardPath(id) {
  return `/cards/${encodeURIComponent(id)}`;
}

function checkAddress(label, where, expected, sheet) {
  if (where.path !== expected || where.sheet !== sheet) {
    console.log(
      `  FAIL ${label}: at ${where.path} with the sheet ${where.sheet ? "open" : "closed"}, expected ${expected} with it ${sheet ? "open" : "closed"}`,
    );
    return false;
  }
  console.log(`  ok   ${label}: ${where.path}, sheet ${sheet ? "open" : "closed"}`);
  return true;
}

/**
 * The card's address (E3): from the board, open pushes /cards/<id> and Back
 * closes the sheet on the same board (the page is not reloaded); the address
 * opened directly shows the sheet, F5 keeps it, and Back lands on the board.
 */
async function checkCardAddress(cdp, sessionId, url, id, shots) {
  if (!id) {
    console.log("  note 1440px: the opened card carried no id; the address went unchecked");
    return true;
  }
  const board = new URL(url);
  const boardPath = board.pathname + board.search;
  const direct = `${board.origin}${cardPath(id)}`;
  let ok = true;

  await cdp.send("Page.navigate", { url }, sessionId);
  await sleep(1500);
  await evaluate(cdp, sessionId, "(window.__sheetGuardMark = true), true");
  const named = await evaluate(cdp, sessionId, OPEN_CARD);
  await sleep(600);
  ok = checkAddress(`1440px open ${named.id}`, await evaluate(cdp, sessionId, WHERE), cardPath(named.id), true) && ok;
  await evaluate(cdp, sessionId, "history.back(), true");
  await sleep(600);
  const back = await evaluate(cdp, sessionId, WHERE);
  ok = checkAddress("1440px Back", back, boardPath, false) && ok;
  if (!back.kept) {
    ok = false;
    console.log("  FAIL 1440px Back: the board was reloaded instead of the sheet closing");
  } else {
    console.log("  ok   1440px Back: the same board, not reloaded");
  }

  // Opened from the board, then F5, then Back: the sheet comes back, then closes.
  await evaluate(cdp, sessionId, OPEN_CARD);
  await sleep(600);
  await cdp.send("Page.reload", {}, sessionId);
  await sleep(2000);
  const reloaded = await evaluate(cdp, sessionId, WHERE);
  ok = checkAddress("1440px F5", reloaded, cardPath(named.id), true) && ok;
  if (shots) {
    fs.writeFileSync(path.join(shots, "card-address-reload-1440.png"), await shoot(cdp, sessionId));
  }
  await evaluate(cdp, sessionId, "history.back(), true");
  await sleep(2000);
  const landed = await evaluate(cdp, sessionId, WHERE);
  ok = checkAddress("1440px F5 then Back", landed, boardPath, false) && ok;
  if (landed.cards === 0) {
    ok = false;
    console.log("  FAIL 1440px F5 then Back: the board came back with no cards");
  } else {
    console.log(`  ok   1440px F5 then Back: the board, ${landed.cards} cards`);
  }

  // The address opened directly: the sheet over the board, closing it is the board.
  await cdp.send("Page.navigate", { url: direct }, sessionId);
  await sleep(2000);
  ok = checkAddress(`1440px ${cardPath(id)} direct`, await evaluate(cdp, sessionId, WHERE), cardPath(id), true) && ok;
  if (shots) {
    fs.writeFileSync(path.join(shots, "card-address-direct-1440.png"), await shoot(cdp, sessionId));
  }
  await evaluate(cdp, sessionId, `(document.querySelector(".d-close") || {}).click?.(), true`);
  await sleep(600);
  ok = checkAddress("1440px direct, closed", await evaluate(cdp, sessionId, WHERE), "/board", false) && ok;
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || process.env.BOARD_URL || "http://localhost:3000/board";
  const widths = (args.widths || process.env.WIDTHS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  const phones = widths.length ? widths : PHONE_WIDTHS;
  const boardPath = new URL(url).pathname + new URL(url).search;
  const cookie = process.env.BOARD_COOKIE || "";
  if (args.shots) fs.mkdirSync(args.shots, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-guard-"));
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
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    cdp = connect(version.webSocketDebuggerUrl);
    await cdp.ready;

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Animation.enable", {}, sessionId);
    if (cookie) {
      const target = new URL(url);
      await cdp.send(
        "Network.setCookie",
        { name: "ab_session", value: cookie, domain: target.hostname, path: "/" },
        sessionId,
      );
    }

    // Every animation the page starts arrives here, which is how the entrance
    // is found without the guard knowing its name.
    let entrance = [];
    cdp.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Animation.animationStarted") {
        entrance.push(message.params.animation);
      }
    });

    console.log(`sheet guard on ${url}`);

    for (const width of phones) {
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width, height: HEIGHT, deviceScaleFactor: 1, mobile: true },
        sessionId,
      );
      await cdp.send("Page.navigate", { url }, sessionId);
      await sleep(1500);
      if (await evaluate(cdp, sessionId, SHOW_RAN_COLUMN)) await sleep(300);

      // The board is scrolled first, because the position it comes back to is
      // only a claim if it was not the top to begin with.
      await evaluate(cdp, sessionId, "window.scrollTo(0, 240), true");
      await sleep(200);
      const before = await evaluate(cdp, sessionId, "Math.round(window.scrollY)");

      // Freeze time, then open: the entrance is created already paused.
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 }, sessionId);
      entrance = [];
      const opened = await evaluate(cdp, sessionId, OPEN_CARD);
      if (!opened.opened) throw new Error(`${width}px: the board showed no card to open`);
      await sleep(400);

      const ids = entrance.map((a) => a.id);
      const duration = Math.max(1, ...entrance.map((a) => a.source?.duration || 0));

      let worst = 0;
      for (const progress of PROGRESS) {
        if (ids.length) {
          await cdp.send(
            "Animation.seekAnimations",
            { animations: ids, currentTime: duration * progress },
            sessionId,
          );
        }
        await sleep(80);

        const surface = await evaluate(cdp, sessionId, SURFACE);
        if (surface.error) throw new Error(`${width}px: ${surface.error}`);

        const withList = await shoot(cdp, sessionId);
        await evaluate(cdp, sessionId, HIDE_LIST);
        await sleep(80);
        const withoutList = await shoot(cdp, sessionId);
        await evaluate(cdp, sessionId, SHOW_LIST);
        await sleep(80);

        const bled = !withList.equals(withoutList);
        const label = `${width}px t=${String(Math.round(progress * 100)).padStart(3)}%`;
        const solid =
          surface.ovOpacity === 1 && surface.ovAlpha === 1 &&
          surface.detailOpacity === 1 && surface.detailAlpha === 1;
        const edgeToEdge =
          surface.covers && surface.panel.left <= 0 &&
          surface.panel.right >= surface.viewport.width;

        if (bled || !solid || !edgeToEdge) {
          failed = true;
          worst += 1;
          console.log(
            `  FAIL ${label}: ${bled ? "the list reaches the screen" : "the sheet is not solid edge to edge"}` +
              ` (ov ${surface.ovOpacity}/${surface.ovAlpha}, panel ${surface.panel.left}..${surface.panel.right} of ${surface.viewport.width})`,
          );
        } else {
          console.log(`  ok   ${label}: nothing of the list on screen, sheet ${surface.panel.width}px edge to edge`);
        }

        if (args.shots) {
          const file = path.join(args.shots, `sheet-${width}-${Math.round(progress * 100)}.png`);
          fs.writeFileSync(file, withList);
        }
      }

      // Settled: the way out, and the page that must not move behind it.
      if (ids.length) {
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 }, sessionId);
      }
      await sleep(300);
      if (!checkAttempts(`${width}px`, opened, await evaluate(cdp, sessionId, ATTEMPTS))) {
        failed = true;
      }
      if (!checkAddress(`${width}px open`, await evaluate(cdp, sessionId, WHERE), cardPath(opened.id), true)) {
        failed = true;
      }
      const reach = await evaluate(cdp, sessionId, CLOSE_REACH);
      if (reach.error || !reach.onScreen) {
        failed = true;
        console.log(`  FAIL ${width}px: the way out is off screen after scrolling the sheet`);
      } else {
        console.log(
          `  ok   ${width}px: the way out stays on screen with the sheet scrolled ${reach.scrolled}px, ${reach.size.width}x${reach.size.height}`,
        );
      }

      await evaluate(cdp, sessionId, "window.scrollBy(0, 600), true");
      await sleep(200);
      const during = await evaluate(cdp, sessionId, "Math.round(window.scrollY)");
      if (during !== 0 && during !== before) {
        failed = true;
        console.log(`  FAIL ${width}px: the board scrolled behind the sheet (${before} to ${during})`);
      } else {
        console.log(`  ok   ${width}px: the board never moved behind the sheet`);
      }

      await evaluate(
        cdp,
        sessionId,
        `(document.querySelector(".d-close") || {}).click?.(), true`,
      );
      await sleep(400);
      if (!checkAddress(`${width}px closed`, await evaluate(cdp, sessionId, WHERE), boardPath, false)) {
        failed = true;
      }
      const after = await evaluate(cdp, sessionId, "Math.round(window.scrollY)");
      if (Math.abs(after - before) > 2) {
        failed = true;
        console.log(`  FAIL ${width}px: the list came back at ${after} instead of ${before}`);
      } else {
        console.log(`  ok   ${width}px: the list came back at ${after}, where it was left`);
      }
      if (worst === 0) console.log(`       ${width}px: ${PROGRESS.length} frames of the entrance, all clean`);
    }

    // The desktop keeps the window it has always had.
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 }, sessionId);
    await cdp.send("Page.navigate", { url }, sessionId);
    await sleep(1500);
    const running = await evaluate(cdp, sessionId, RUNNING_CARD);
    if (running) {
      console.log(
        `  info 1440px: running card box padding ${running.padding}, radius ${running.radius}, border ${running.border}, background ${running.background}`,
      );
      if (args.shots) {
        fs.writeFileSync(path.join(args.shots, "board-desktop-1440.png"), await shoot(cdp, sessionId));
      }
    } else {
      console.log("  note 1440px: no card is running on this board; its box went unprinted");
    }
    const openedDesktop = await evaluate(cdp, sessionId, OPEN_CARD);
    if (!openedDesktop.opened) {
      throw new Error("1440px: the board showed no card to open");
    }
    await sleep(600);
    if (!checkAttempts("1440px", openedDesktop, await evaluate(cdp, sessionId, ATTEMPTS))) {
      failed = true;
    }
    const desktop = await evaluate(cdp, sessionId, SURFACE);
    const centred =
      desktop.panel.left > 0 &&
      desktop.panel.right < desktop.viewport.width &&
      Math.abs(desktop.panel.left - (desktop.viewport.width - desktop.panel.right)) <= 2;
    if (!centred) {
      failed = true;
      console.log(`  FAIL 1440px: the detail is no longer the centred panel (${desktop.panel.left}..${desktop.panel.right} of ${desktop.viewport.width})`);
    } else {
      console.log(`  ok   1440px: still the centred panel, ${desktop.panel.width}px with the board around it`);
    }
    if (args.shots) {
      fs.writeFileSync(path.join(args.shots, "sheet-desktop-1440.png"), await shoot(cdp, sessionId));
    }

    // E3: the card's own address, at 1440.
    if (!(await checkCardAddress(cdp, sessionId, url, openedDesktop.id, args.shots))) {
      failed = true;
    }
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  if (failed) {
    console.log("\nthe sheet rule is broken. See the frames marked FAIL.");
    process.exit(1);
  }
  console.log("\nthe detail is a sheet on the phone and a panel on the desktop.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
