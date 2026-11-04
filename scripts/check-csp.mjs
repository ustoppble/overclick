#!/usr/bin/env node
/**
 * The CSP guard.
 *
 * The board answers every page with a Content-Security-Policy and a set of
 * static security headers (apps/web/src/lib/security-headers.ts). A policy
 * that blocks something the app needs does not fail a build: it fails in the
 * browser, as a console error nobody reads. So this walks the screens in a
 * real Chromium and fails on any of:
 *
 *  - a `securitypolicyviolation` event (reported by the page itself),
 *  - a console error or a Log entry from the security source,
 *  - a request the browser blocked for CSP,
 *  - a page document missing one of the headers the audit asked for,
 *  - the theme boot script not running (the cookie says nebula, the page says
 *    otherwise), which is what the nonce on that inline script protects,
 *  - Inter, served by next/font from this origin, not loading.
 *
 * Usage:
 *   node scripts/check-csp.mjs
 *   node scripts/check-csp.mjs --url http://localhost:3000
 *
 * Environment:
 *   BOARD_URL     the origin to walk (default http://localhost:3000)
 *   BOARD_COOKIE  value of the ab_session cookie; without it only the screens
 *                 that need no sign-in are walked
 *   CHROME_BIN    path to a Chrome or Chromium binary
 *
 * Exit code is 0 when every screen is clean and 1 otherwise, so it runs as a
 * check in CI as easily as by hand. Same CDP plumbing as topbar-one-line.mjs:
 * no dependency, Node 22's WebSocket.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** What a page document must carry, by header name (lower case). */
const REQUIRED_HEADERS = {
  "strict-transport-security": (v) =>
    Number(/max-age=(\d+)/.exec(v)?.[1]) >= 31536000 && /includeSubDomains/i.test(v),
  "x-content-type-options": (v) => v === "nosniff",
  "referrer-policy": (v) => v === "strict-origin-when-cross-origin",
  "permissions-policy": (v) => /camera=\(\)/.test(v) && /microphone=\(\)/.test(v),
  "x-frame-options": (v) => v === "DENY",
  "content-security-policy": (v) =>
    /default-src 'self'/.test(v) &&
    /frame-ancestors 'none'/.test(v) &&
    /script-src[^;]*'nonce-[^']+'/.test(v) &&
    !/script-src[^;]*'unsafe-inline'/.test(v),
};

/** Screens that need no sign-in. */
const OPEN_SCREENS = ["/login", "/login/emergency", "/invite/invalid", "/setup"];

/** Screens behind the session cookie. */
const SIGNED_IN_SCREENS = [
  "/",
  "/home",
  "/board",
  "/missions",
  "/usage",
  "/insights",
  "/organizations",
  "/onboarding",
  "/account/agent",
  "/settings",
  "/settings/agents/connections",
  "/settings/agents/usage-recipes",
  "/settings/agents/claim-timeout",
  "/settings/team/people",
  "/settings/team/invitations",
  "/settings/prices",
  "/settings/system/language",
  "/settings/system/updates",
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") args.url = argv[++i];
  }
  return args;
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome found. Set CHROME_BIN to a Chrome or Chromium binary.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** A CDP client small enough to carry no dependency. Events go to `onEvent`. */
function connect(wsUrl, onEvent) {
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
    if (message.id === undefined) {
      onEvent(message);
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
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
}

/** Injected before any page script: the page reports its own violations. */
const VIOLATION_HOOK = `
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__csp.push(e.effectiveDirective + " blocked " + (e.blockedURI || "inline") +
      " at " + (e.sourceFile || "page") + ":" + e.lineNumber);
  });
`;

const FONT_STATE = `(async () => {
  await document.fonts.ready;
  const faces = Array.from(document.fonts);
  return {
    loaded: faces.filter((f) => f.status === "loaded").length,
    families: Array.from(new Set(faces.map((f) => f.family))).join(","),
  };
})()`;

/**
 * Chromium keeps writing into its profile until it has really exited, so
 * deleting the directory right after kill() races those writes (ENOTEMPTY,
 * intermittently). Ask it to stop, wait for the exit, and only then let go.
 */
async function stopChrome(chrome, graceMs = 5000) {
  if (chrome.pid === undefined || chrome.exitCode !== null || chrome.signalCode !== null) return;
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill("SIGTERM");
  const timer = setTimeout(() => chrome.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
}

/** Node retries ENOTEMPTY/EBUSY on its own with maxRetries; a last miss is only a leftover temp dir. */
function removeProfile(profile) {
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`could not remove ${profile}: ${error.code ?? error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const origin = new URL(args.url || process.env.BOARD_URL || "http://localhost:3000").origin;
  const cookie = process.env.BOARD_COOKIE || "";

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "csp-guard-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  // Everything the browser says while a screen loads lands here, then is
  // drained into that screen's verdict.
  let events = [];
  const documentHeaders = new Map();
  let cdp;
  let failed = false;
  try {
    const port = await readPort(profile);
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    cdp = connect(version.webSocketDebuggerUrl, (message) => {
      const { method, params } = message;
      if (method === "Log.entryAdded") {
        const { level, source, text, url } = params.entry;
        if (level === "error" || source === "security") {
          events.push(`log[${source}/${level}] ${text}${url ? ` (${url})` : ""}`);
        }
      } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        events.push(`console.error ${params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
      } else if (method === "Runtime.exceptionThrown") {
        events.push(`exception ${params.exceptionDetails.text} ${params.exceptionDetails.exception?.description ?? ""}`);
      } else if (method === "Network.loadingFailed" && params.blockedReason) {
        events.push(`blocked(${params.blockedReason}) ${params.type}`);
      } else if (method === "Network.responseReceived" && params.type === "Document") {
        documentHeaders.set(params.response.url, params.response.headers);
      }
    });
    await cdp.ready;

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    for (const domain of ["Page", "Runtime", "Network", "Log"]) {
      await cdp.send(`${domain}.enable`, {}, sessionId);
    }
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: VIOLATION_HOOK }, sessionId);

    const host = new URL(origin).hostname;
    const setCookie = (name, value) =>
      cdp.send("Network.setCookie", { name, value, domain: host, path: "/" }, sessionId);
    if (cookie) await setCookie("ab_session", cookie);

    const screens = [...OPEN_SCREENS, ...(cookie ? SIGNED_IN_SCREENS : [])];

    // A mission page and a card's own address, found the way a person would:
    // from the lists that show them. A card is not a link on the board, only
    // its short id is printed, and /cards/<id> opens it in the detail sheet.
    if (cookie) {
      const found = async (list, expression) => {
        await cdp.send("Page.navigate", { url: `${origin}${list}` }, sessionId);
        await sleep(1500);
        const value = await evaluate(cdp, sessionId, expression);
        if (!value) console.log(`  note: nothing on ${list} to open, so that screen is not walked`);
        return value;
      };
      const mission = await found(
        "/missions",
        `(() => { const a = document.querySelector(".ms-row"); return a ? a.getAttribute("href") : null; })()`,
      );
      if (mission) screens.push(mission);
      const card = await found(
        "/board",
        `(() => { const m = /\\b[A-Z]{2,6}-\\d+\\b/.exec(document.body.innerText); return m ? "/cards/" + m[0] : null; })()`,
      );
      if (card) screens.push(card);
    }

    // Both themes are walked: xai draws in Inter (so the font must load),
    // nebula does not ask for it. Each starts from a cookie the default would
    // not produce, so a boot script that never ran shows up as the wrong theme.
    for (const theme of ["nebula", "xai"]) {
      await setCookie("oc-theme", theme);
      console.log(`theme ${theme}`);
      for (const screen of screens) {
        events = [];
        const url = `${origin}${screen}`;
        // The boot script only has something to correct when the cookie is
        // not the default, so a page under xai proves nothing about it.
        await cdp.send("Page.navigate", { url }, sessionId);
        // Server rendered; this settles hydration, web fonts and the chunks the
        // bootstrap pulls in under 'strict-dynamic'.
        await sleep(2000);

        const problems = [];
        const finalUrl = await evaluate(cdp, sessionId, "location.href");
        const headers = documentHeaders.get(finalUrl);
        if (!headers) {
          problems.push("no document response seen");
        } else {
          const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
          for (const [name, ok] of Object.entries(REQUIRED_HEADERS)) {
            if (!lower[name] || !ok(lower[name])) problems.push(`header ${name} missing or wrong`);
          }
        }

        const violations = await evaluate(cdp, sessionId, "window.__csp || []");
        for (const v of violations) problems.push(`violation: ${v}`);
        for (const e of events) problems.push(e);

        const shown = await evaluate(cdp, sessionId, "document.documentElement.dataset.theme");
        if (shown !== theme) problems.push(`theme boot script did not run (data-theme=${shown}, cookie=${theme})`);

        const fonts = await evaluate(cdp, sessionId, FONT_STATE);
        if (theme === "xai" && fonts.loaded === 0) {
          problems.push(`Inter did not load (faces: ${fonts.families || "none"})`);
        }

        if (problems.length) {
          failed = true;
          console.log(`  FAIL ${screen}`);
          for (const p of [...new Set(problems)]) console.log(`       ${p}`);
        } else {
          console.log(`  ok   ${screen} (${fonts.loaded} font faces loaded)`);
        }
      }
    }
  } finally {
    cdp?.close();
    await stopChrome(chrome);
    removeProfile(profile);
  }

  if (failed) {
    console.log("CSP guard: violations found.");
    process.exit(1);
  }
  console.log("CSP guard: every screen clean.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
