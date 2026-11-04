import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../actions/auth", () => ({ logoutAction: async () => {} }));
vi.mock("../../actions/global-bar", () => ({ globalBarCountsAction: async () => null }));
vi.mock("../../actions/board-filter", () => ({ setBoardScopeAction: async () => ({ ok: true }) }));

const { AvatarMenu, GlobalBarClient, ownsCountsPoll } = await import("./global-bar-client");

type Props = Parameters<typeof GlobalBarClient>[0];

const base: Props = {
  current: "board",
  lang: "pt-BR",
  email: "dono@exemplo.com.br",
  role: "admin",
  organizationName: null,
  counts: { running: 2, review: 4 },
  scope: {
    organizations: [
      { id: "o1", name: "Overclock" },
      { id: "o2", name: "Sydra" },
    ],
    projects: [
      { id: "p1", name: "overclick", organizationId: "o1" },
      { id: "p2", name: "app", organizationId: "o1" },
      { id: "p3", name: "site", organizationId: "o2" },
    ],
    remembered: { organizationIds: ["o1"], projectIds: ["p1"] },
  },
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
  it("is a nav of places: Board, Missões and Consumo (Missions joins in E3)", () => {
    const html = render();
    expect(html).toMatch(/<nav[^>]*class="gb-places"/);
    const places = html.match(/<nav[^>]*class="gb-places"[\s\S]*?<\/nav>/)![0];
    expect(places.match(/href="([^"]+)"/g)).toEqual([
      'href="/board"',
      'href="/missions"',
      'href="/usage"',
    ]);
    expect(html).toContain(">Board<");
    expect(html).toContain(">Missões<");
    expect(html).toContain(">Consumo<");
    expect(render({ lang: "en" })).toContain(">Usage<");
    expect(render({ lang: "en" })).toContain(">Missions<");
  });

  it("puts Missões on the phone's bottom bar too", () => {
    const tabs = render().match(/<nav[^>]*class="gb-tabbar"[\s\S]*?<\/nav>/)![0];
    expect(tabs).toContain('href="/missions"');
    expect(tabs).toContain("Missões");
  });

  it("puts aria-current on the place the reader is in, and only there", () => {
    const onBoard = render({ current: "board" });
    // The places nav, then the phone's bottom bar: one current place in each.
    const places = onBoard.match(/<nav[^>]*class="gb-places"[\s\S]*?<\/nav>/)![0];
    expect(places.match(/aria-current="page"/g)?.length).toBe(1);
    const tabs = onBoard.match(/<nav[^>]*class="gb-tabbar"[\s\S]*?<\/nav>/)![0];
    expect(tabs.match(/aria-current="page"/g)?.length).toBe(1);
    expect(onBoard).toMatch(/href="\/board"[^>]*aria-current="page"/);

    const onUsage = render({ current: "usage" });
    expect(onUsage).toMatch(/href="\/usage"[^>]*aria-current="page"/);
    expect(onUsage).not.toMatch(/href="\/board"[^>]*aria-current="page"/);

    const onMissions = render({ current: "missions" });
    expect(onMissions).toMatch(/href="\/missions"[^>]*aria-current="page"/);
    expect(onMissions).not.toMatch(/href="\/board"[^>]*aria-current="page"/);

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
    expect(html).toMatch(/class="gb-chip gb-chip-review attention"[^>]*href="\/board\?status=feito"|href="\/board\?status=feito"[^>]*class="gb-chip gb-chip-review attention"/);
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

describe("the scope and the search in the global bar (navigation plan E4)", () => {
  it("puts the scope right after the wordmark, written as organization › project", () => {
    const html = render();
    const row = html.match(/<div class="gb-row">[\s\S]*?<nav[^>]*class="gb-places"/)![0];
    expect(row.indexOf("logo")).toBeLessThan(row.indexOf("gb-scope"));
    expect(row).toMatch(/class="gb-scope"[^>]*aria-haspopup="dialog"/);
    expect(row).toContain("Overclock");
    expect(row).toMatch(/gb-scope-sep[^>]*>›</);
    expect(row).toContain("overclick");
  });

  it("says every project when the scope is a whole organization, and every organization when it is all", () => {
    expect(
      render({ scope: { ...base.scope, remembered: { organizationIds: ["o2"], projectIds: [] } } }),
    ).toContain("Todos os projetos");
    expect(
      render({ scope: { ...base.scope, remembered: { organizationIds: [], projectIds: [] } } }),
    ).toContain("Todas as organizações");
  });

  it("shows the name as fixed text when there is nothing to choose: one organization, one project (F17)", () => {
    const html = render({
      scope: {
        organizations: [{ id: "o1", name: "Overclock" }],
        projects: [{ id: "p1", name: "overclick", organizationId: "o1" }],
        remembered: { organizationIds: [], projectIds: [] },
      },
    });
    expect(html).toMatch(/<span class="gb-scope gb-scope-fixed"/);
    expect(html).not.toMatch(/<button[^>]*class="gb-scope"/);
    expect(html).toContain("overclick");
  });

  it("has a search that says what it reaches, keeps ⌘K, and lands on /board?q= from anywhere", () => {
    const html = render({ current: "usage" });
    expect(html).toMatch(/<form[^>]*class="gb-search-form"[^>]*action="\/board"|<form[^>]*action="\/board"[^>]*class="gb-search-form"/);
    expect(html).toMatch(/<input[^>]*name="q"/);
    expect(html).toContain('placeholder="Buscar cards"');
    expect(html).toContain("⌘K");
    expect(render({ lang: "en" })).toContain('placeholder="Search cards"');
    // its icon form, for the bars too narrow for the field
    expect(html).toMatch(/class="gb-search-btn"[^>]*aria-label="Buscar cards"/);
  });

  it("orders the right side: search, running, to review, avatar", () => {
    const html = render();
    const right = html.match(/<div class="gb-right">[\s\S]*$/)![0];
    const at = (needle: string) => right.indexOf(needle);
    expect(at("gb-search")).toBeGreaterThan(-1);
    expect(at("gb-search")).toBeLessThan(at("gb-chip-run"));
    expect(at("gb-chip-run")).toBeLessThan(at("gb-chip-review"));
    expect(at("gb-chip-review")).toBeLessThan(at("gb-avatar"));
  });
});

describe("one poll for the counts at a time (E1 review, B1)", () => {
  it("leaves the counts to the board's poll on the board, the To review list included", () => {
    expect(ownsCountsPoll("board")).toBe(false);
    expect(ownsCountsPoll("missions")).toBe(true);
    expect(ownsCountsPoll("usage")).toBe(true);
    expect(ownsCountsPoll("settings")).toBe(true);
    expect(ownsCountsPoll(null)).toBe(true);
  });
});

describe("the avatar menu", () => {
  it("shows the e-mail and the role", () => {
    expect(menu("admin")).toContain("dono@exemplo.com.br");
    expect(menu("admin")).toContain("Admin");
    expect(menu("member")).toContain("Membro");
  });

  it("offers Configurações to the admin and not to the member", () => {
    expect(menu("admin")).toContain('href="/settings/organizations-projects"');
    expect(menu("admin")).toContain("Configurações");
    expect(menu("member")).not.toContain('href="/settings/organizations-projects"');
    expect(menu("member")).not.toContain("Configurações");
  });

  it("carries My agent, the theme and the way out", () => {
    const html = menu("admin");
    expect(html).toContain("Meu agente");
    expect(html).toContain('href="/account/agent"');
    expect(html).not.toContain('href="/organizations"');
    expect(html).toContain("Tema");
    expect(html).toContain("Sair");
    expect(menu("member", "en")).toContain("My agent");
  });
});
