import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMERGENCY_LOGIN_PATH } from "@agent-board/db/emergency-login";
import { INVITE_PATH } from "../lib/invitations";
import { lockNoticeEmail, loginCodeEmail } from "../lib/login-code";
import { signupCodeEmail } from "../lib/signup-code";
import { config as proxyConfig } from "../proxy";

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

  it("the proxy still guards exactly the invitation links", () => {
    expect(proxyConfig.matcher).toBe("/invite/:path*");
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
