import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../actions/auth", () => ({ logoutAction: async () => {} }));
vi.mock("../../actions/global-bar", () => ({ globalBarCountsAction: async () => null }));

const { AvatarMenu, GlobalBarClient } = await import("./global-bar-client");

type Props = Parameters<typeof GlobalBarClient>[0];

const base: Props = {
  current: "board",
  lang: "pt-BR",
  email: "dono@exemplo.com.br",
  role: "admin",
  organizationName: null,
  counts: { running: 2, review: 4 },
};

const render = (props: Partial<Props> = {}) =>
  renderToStaticMarkup(createElement(GlobalBarClient, { ...base, ...props }));

const menu = (role: "admin" | "member", lang = "pt-BR") =>
  renderToStaticMarkup(
    createElement(AvatarMenu, {
      email: base.email,
      role,
      organizationName: role === "member" ? "Overclock" : null,
      lang,
      onClose: () => {},
    }),
  );

describe("the global bar (navigation plan E1)", () => {
  it("is a nav of places: Board and Consumo, and no Missions until E3", () => {
    const html = render();
    expect(html).toMatch(/<nav[^>]*class="gb-places"/);
    expect(html).toContain(">Board<");
    expect(html).toContain(">Consumo<");
    expect(html).not.toMatch(/Missões|Missions/);
    expect(render({ lang: "en" })).toContain(">Usage<");
  });

  it("puts aria-current on the place the reader is in, and only there", () => {
    const onBoard = render({ current: "board" });
    // The places nav, then the phone's bottom bar: one current place in each.
    const places = onBoard.match(/<nav[^>]*class="gb-places"[\s\S]*?<\/nav>/)![0];
    expect(places.match(/aria-current="page"/g)?.length).toBe(1);
    const tabs = onBoard.match(/<nav[^>]*class="gb-tabbar"[\s\S]*?<\/nav>/)![0];
    expect(tabs.match(/aria-current="page"/g)?.length).toBe(1);
    expect(onBoard).toMatch(/href="\/home"[^>]*aria-current="page"/);

    const onUsage = render({ current: "usage" });
    expect(onUsage).toMatch(/href="\/insights"[^>]*aria-current="page"/);
    expect(onUsage).not.toMatch(/href="\/home"[^>]*aria-current="page"/);

    expect(render({ current: "settings" })).not.toContain('aria-current="page"');
  });

  it("has no ⋯ menu: the avatar holds the account", () => {
    const html = render();
    expect(html).not.toContain("am-trigger");
    expect(html).not.toContain("⋯");
    expect(html).toMatch(/class="gb-avatar"[^>]*aria-haspopup="menu"/);
    expect(html).toContain(">D<");
  });

  it("tells the admin how many wait for review, in the amber, and links to the list", () => {
    const html = render();
    expect(html).toMatch(/class="gb-chip gb-chip-review attention"[^>]*href="\/home\?status=feito"|href="\/home\?status=feito"[^>]*class="gb-chip gb-chip-review attention"/);
    expect(html).toContain("para revisar");
    expect(html).toContain("2 em execução");
  });

  it("tells a member their cards await validation, neutral, without the amber", () => {
    const html = render({ role: "member", organizationName: "Overclock" });
    expect(html).toContain("aguardando validação");
    expect(html).not.toContain("para revisar");
    expect(html).not.toMatch(/\battention\b/);
    expect(render({ role: "member", lang: "en" })).toContain("awaiting validation");
  });

  it("keeps the review count on the phone's bottom bar too", () => {
    const html = render();
    expect(html).toMatch(/<nav[^>]*class="gb-tabbar"/);
    expect(html).toMatch(/gb-tab-badge attention[^>]*>4</);
    expect(render({ counts: { running: 0, review: 0 } })).not.toContain("gb-tab-badge");
  });
});

describe("the avatar menu", () => {
  it("shows the e-mail and the role", () => {
    expect(menu("admin")).toContain("dono@exemplo.com.br");
    expect(menu("admin")).toContain("Admin");
    expect(menu("member")).toContain("Membro");
  });

  it("offers Configurações to the admin and not to the member", () => {
    expect(menu("admin")).toContain('href="/settings"');
    expect(menu("admin")).toContain("Configurações");
    expect(menu("member")).not.toContain('href="/settings"');
    expect(menu("member")).not.toContain("Configurações");
  });

  it("carries My agent, Organizations, the theme and the way out", () => {
    const html = menu("admin");
    expect(html).toContain("Meu agente");
    expect(html).toContain('href="/settings?tab=tokens"');
    expect(html).toContain('href="/organizations"');
    expect(html).toContain("Tema");
    expect(html).toContain("Sair");
    expect(menu("member", "en")).toContain("My agent");
  });
});
