import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { EMERGENCY_LOGIN_PATH } from "@agent-board/db/emergency-login";
import { INVITE_PATH } from "../lib/invitations";
import { lockNoticeEmail, loginCodeEmail } from "../lib/login-code";
import { signupCodeEmail } from "../lib/signup-code";
import { config as proxyConfig, proxy } from "../proxy";

const app = dirname(fileURLToPath(import.meta.url));
const page = (route: string) => join(app, route, "page.tsx");

/**
 * The addresses that already left the app (navigation plan §3.1): invitation
 * links an admin copied and sent, the emergency link of the runbook, and the
 * sign-in, setup and onboarding pages that e-mails and redirects point at.
 * Renaming the board's routes (E3) must not move any of them.
 */
describe("the routes that already left the app do not move", () => {
  it.each(["login", "login/emergency", "invite/[token]", "setup", "onboarding"])(
    "app/%s/page.tsx is still there",
    (route) => {
      expect(existsSync(page(route))).toBe(true);
    },
  );

  it("the emergency link is still /login/emergency#<token>", () => {
    expect(EMERGENCY_LOGIN_PATH).toBe("/login/emergency");
  });

  it("an invitation link is still /invite/<secret>", () => {
    expect(INVITE_PATH).toBe("/invite/");
  });

  // The proxy also carries the CSP nonce now (SEC), so it runs on every page;
  // what stays exact is whose links it may redirect: the invitations, only.
  it("the proxy runs on pages and redirects only the invitation links", () => {
    const re = new RegExp(`^${proxyConfig.matcher}$`);
    expect(re.test("/invite/abc")).toBe(true);
    expect(re.test("/_next/static/chunks/a.js")).toBe(false);
    for (const path of ["/board", "/login", "/settings/team/people", "/missions/x%"]) {
      const res = proxy(new NextRequest(`http://board.test${path}`));
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("the sign-in e-mails carry the code and no address of the app", () => {
    const bodies = [
      loginCodeEmail("a@example.test", "123456").text,
      lockNoticeEmail("a@example.test", 60 * 60 * 1000).text,
      signupCodeEmail("setup", "a@example.test", "123456").text,
      signupCodeEmail("invite", "a@example.test", "123456").text,
    ];
    for (const body of bodies) {
      expect(body).not.toMatch(/https?:\/\//);
      expect(body).not.toMatch(/\/(home|board|cards|missions|login|invite)\b/);
    }
  });
});

describe("the board's new addresses (E3)", () => {
  it.each(["board", "missions", "missions/[id]"])("app/%s/page.tsx exists", (route) => {
    expect(existsSync(page(route))).toBe(true);
  });

  it("/home only redirects: it renders no board of its own", () => {
    const source = readFileSync(page("home"), "utf8");
    expect(source).toContain("homeDestination");
    expect(source).not.toContain("HomeShell");
  });

  it("a card and a mission that do not exist have their own not-found page", () => {
    expect(existsSync(join(app, "not-found.tsx"))).toBe(true);
    expect(existsSync(join(app, "board", "not-found.tsx"))).toBe(true);
    expect(existsSync(join(app, "missions", "[id]", "not-found.tsx"))).toBe(true);
  });
});

/**
 * Navigation plan E4, item 5 (decision 5): the old addresses answered 307 in
 * the release that introduced them and answer 308 from the next one on, so
 * a bookmark updates itself. Still one hop each. `/settings?tab=` stays
 * temporary: where it lands depends on who asks (admin, member, nobody signed
 * in), and a browser keeps a 308 for every reader of that machine.
 */
describe("the old addresses become permanent redirects (E4)", () => {
  it.each(["insights", "organizations"])("app/%s/page.tsx answers 308", (route) => {
    const source = readFileSync(page(route), "utf8");
    expect(source).toMatch(/\bpermanentRedirect\(/);
    expect(source).not.toMatch(/\bredirect\(/);
  });

  // E4 review h-ipv, item 3: /home's static mapping is permanent, but the
  // /home?card=<old id> lookup reads today's data and answers 307, once.
  it("app/home/page.tsx answers 308 for the static mapping and 307 only after the lookup", () => {
    const source = readFileSync(page("home"), "utf8");
    expect(source).toMatch(/\bpermanentRedirect\(homeDestination\(/);
    expect(source.match(/\bredirect\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/if \(moved\) redirect\(/);
  });

  it("/settings?tab= stays a 307: its destination depends on the reader", () => {
    const source = readFileSync(page("settings"), "utf8");
    expect(source).not.toContain("permanentRedirect");
  });
});

/**
 * Every item of the Settings menu is a page of its own. The group pages that
 * stacked their sections now only send to the first one (a 307, after the
 * member check, like `/settings?tab=`), and each section answers at
 * `/settings/<group>/<section>`.
 */
describe("each Settings item has its own page", () => {
  it("app/settings/[group]/[section]/page.tsx exists", () => {
    expect(existsSync(page("settings/[group]/[section]"))).toBe(true);
  });

  it("next.config answers /settings/<group> before the page streams", () => {
    const source = readFileSync(join(app, "..", "..", "next.config.ts"), "utf8");
    expect(source).toMatch(/redirects: async \(\) => SETTINGS_GROUP_REDIRECTS/);
  });

  it("app/settings/[group]/page.tsx sends a group with sections to its first one", () => {
    const source = readFileSync(page("settings/[group]"), "utf8");
    expect(source).toContain("settingsGroupDestination");
    expect(source).not.toContain("permanentRedirect");
  });

  it("the links that leave Settings name a page, not an anchor", () => {
    const sources = [
      readFileSync(page("account/agent"), "utf8"),
      readFileSync(join(app, "..", "components", "install-notice.tsx"), "utf8"),
    ];
    // The menu's own links are checked where it renders (settings-groups-nav.test.tsx).
    for (const source of sources) expect(source).not.toMatch(/\/settings\/[a-z-]+#/);
    expect(sources[0]).toContain("/settings/agents/connections");
    expect(sources[1]).toContain("/settings/team/people");
  });
});
