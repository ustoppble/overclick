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

describe("the login page signs in by email code only", () => {
  beforeEach(() => {
    state.emailConfigured = true;
    state.language = "en";
  });

  it("opens straight on the email step of the code flow, with no password anywhere", async () => {
    const html = await render();
    expect(html).toContain('name="email"');
    expect(html).toContain(dict("en").auth.codeSend);
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain("Sign in with password");
  });

  it("has no password and no way back to one in pt-BR either", async () => {
    state.language = "pt-BR";
    const html = await render();
    expect(html).toContain("Enviar código");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Entrar com senha");
  });

  it("says sign-in is unavailable when sending is not configured, and offers no form", async () => {
    state.emailConfigured = false;
    const html = await render();

    expect(html).toContain("Sign-in unavailable: email is not configured.");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('name="password"');
  });

  it("says it in pt-BR the way the owner asked", async () => {
    state.emailConfigured = false;
    state.language = "pt-BR";
    const html = await render();

    expect(html).toContain("Login indisponível: e-mail não configurado.");
    expect(html).not.toContain("<form");
  });
});
