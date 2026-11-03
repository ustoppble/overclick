import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../../lib/i18n";

const state = vi.hoisted(() => ({ emailConfigured: true, language: "en" }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));
vi.mock("../../actions/auth", () => ({
  loginAction: async () => null,
  loginWithCodeAction: async () => null,
  requestLoginCodeAction: async () => null,
}));
vi.mock("../../lib/cookies", () => ({ getSession: async () => null }));
vi.mock("../../lib/instance", () => ({ countUsers: async () => 1 }));
vi.mock("../../lib/updates", () => ({ APP_VERSION: "0.0.0-test" }));
vi.mock("../../lib/db", () => ({
  db: () => ({
    query: { workspace: { findFirst: async () => ({ language: state.language }) } },
  }),
}));
vi.mock("../../lib/email", () => ({
  emailConfigured: () => state.emailConfigured,
}));

const { default: LoginPage } = await import("./page");

async function render(): Promise<string> {
  return renderToStaticMarkup(await LoginPage());
}

describe("the login page offers sign-in by email code only where mail can be sent", () => {
  beforeEach(() => {
    state.emailConfigured = true;
    state.language = "en";
  });

  it("shows the link when RESEND_API_KEY and EMAIL_FROM are set", async () => {
    const html = await render();
    expect(html).toContain(dict("en").auth.codeLink);
  });

  it("shows the link in pt-BR too", async () => {
    state.language = "pt-BR";
    const html = await render();
    expect(html).toContain("Entrar com código por e-mail");
  });

  it("hides the link when sending is not configured, and the password form stays", async () => {
    state.emailConfigured = false;
    const html = await render();

    expect(html).not.toContain(dict("en").auth.codeLink);
    expect(html).toContain('name="password"');
  });
});
