import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

describe("markdown renderer", () => {
  it("renders bold", () => {
    const html = renderToStaticMarkup(<Markdown text="A **negrito** simples" />);
    expect(html).toContain("<strong class=\"md-strong\">negrito</strong>");
    expect(html).not.toContain("**");
  });

  it("renders inline code", () => {
    const html = renderToStaticMarkup(<Markdown text='Use `npm test` para validar.' />);
    expect(html).toContain("<code class=\"md-inline-code\">npm test</code>");
    expect(html).not.toContain("`npm test`");
  });

  it("renders list", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"- primeiro\n- segundo"} />,
    );
    expect(html).toContain("<ul class=\"md-list\">");
    expect(html).toContain("<li>primeiro</li>");
    expect(html).toContain("<li>segundo</li>");
  });

  it("renders safe external links", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"Veja [site](https://example.com)"} />,
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("escapes html input", () => {
    const html = renderToStaticMarkup(
      <Markdown text="<script>alert(1)</script> ficou inofensivo." />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("keeps plain text and line breaks", () => {
    const html = renderToStaticMarkup(<Markdown text={"Linha 1\nLinha 2"} />);
    expect(html).toContain("Linha 1");
    expect(html).toContain("Linha 2");
    expect(html).toContain("<br/>");
    expect(html).not.toContain("**");
  });

  describe("link allowlist (relative, https, http, mailto)", () => {
    const link = (href: string) =>
      renderToStaticMarkup(<Markdown text={`[x](${href})`} />);

    it.each([
      "https://example.com/a?b=1#c",
      "http://example.com",
      "mailto:a@example.com",
      "/board",
      "/cards/OCL-1?x=1",
      "./sibling",
      "../up",
      "#anchor",
      "?q=1",
    ])("keeps %s as a link", (href) => {
      expect(link(href)).toContain("<a ");
    });

    it.each([
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "vbscript:x",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "ftp://example.com",
      "blob:https://example.com/uuid",
      "tel:123",
      "//evil.example/path",
      "/\\evil.example",
      "\\\\evil.example",
      "foo:bar",
    ])("drops %s", (href) => {
      expect(link(href)).not.toContain("<a ");
    });
  });
});
