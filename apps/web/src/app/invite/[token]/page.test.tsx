import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ emailConfigured: true, language: "en" }));

vi.mock("../../../actions/team", () => ({
  acceptInvitationAction: async () => null,
  requestInviteCodeAction: async () => null,
}));
vi.mock("../../../lib/updates", () => ({ APP_VERSION: "0.0.0-test" }));
vi.mock("../../../lib/db", () => ({
  db: () => ({
    query: { workspace: { findFirst: async () => ({ language: state.language }) } },
  }),
}));
vi.mock("../../../lib/email", () => ({
  emailConfigured: () => state.emailConfigured,
}));
vi.mock("../../../lib/invitations", () => ({
  decodeInvitationSecret: (raw: string) => raw,
  inspectInvitation: async () => ({
    ok: true,
    id: "00000000-0000-0000-0000-0000000000aa",
    email: "func@example.test",
    organizationName: "General",
  }),
}));

const { default: InvitePage } = await import("./page");

async function render(): Promise<string> {
  return renderToStaticMarkup(
    await InvitePage({ params: Promise.resolve({ token: "a-secret" }) }),
  );
}

describe("the invite page asks for the invited address and a code, never a password", () => {
  beforeEach(() => {
    state.emailConfigured = true;
    state.language = "en";
  });

  it("asks the person to type the address, without printing the one the link was made for", async () => {
    const html = await render();
    expect(html).toContain('name="email"');
    expect(html).toContain("General");
    expect(html).not.toContain("func@example.test");
    expect(html).not.toContain('type="password"');
  });

  it("says it is unavailable, with no form, when email is not configured", async () => {
    state.emailConfigured = false;
    const html = await render();
    expect(html).toContain("Sign-in unavailable: email is not configured.");
    expect(html).not.toContain("<form");
  });
});
