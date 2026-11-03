import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ emailConfigured: true, language: "en" }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));
vi.mock("../../actions/auth", () => ({
  requestSetupCodeAction: async () => null,
  signupAction: async () => null,
}));
vi.mock("../../lib/cookies", () => ({ getSession: async () => null }));
vi.mock("../../lib/instance", () => ({ countUsers: async () => 0 }));
vi.mock("../../lib/updates", () => ({ APP_VERSION: "0.0.0-test" }));
vi.mock("../../lib/db", () => ({
  db: () => ({
    query: { workspace: { findFirst: async () => ({ language: state.language }) } },
  }),
}));
vi.mock("../../lib/email", () => ({
  emailConfigured: () => state.emailConfigured,
}));

const { default: SetupPage } = await import("./page");

async function render(): Promise<string> {
  return renderToStaticMarkup(await SetupPage());
}

describe("the setup page proves the admin's address with a code", () => {
  beforeEach(() => {
    state.emailConfigured = true;
    state.language = "en";
  });

  it("asks for the email and offers to send a code, with no password field", async () => {
    const html = await render();
    expect(html).toContain('name="email"');
    expect(html).toContain("Send code");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('name="password"');
  });

  it("says setup is unavailable, with no form, when email is not configured", async () => {
    state.emailConfigured = false;
    state.language = "pt-BR";
    const html = await render();
    expect(html).toContain("Login indisponível: e-mail não configurado.");
    expect(html).not.toContain("<form");
  });
});
