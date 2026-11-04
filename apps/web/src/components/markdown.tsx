import type { ReactNode } from "react";

type MarkdownProps = {
  text: string | null | undefined;
  inline?: boolean;
  className?: string;
};

const mdChars = new Set(["*", "`", "["]);

function splitLines(text: string) {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function isCodeFence(line: string): boolean {
  return /^```\s*$/.test(line.trim());
}

function isHeader(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
}

function isOrderedList(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

function isUnorderedList(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line);
}

function isBlockQuote(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

function isList(line: string): boolean {
  return isOrderedList(line) || isUnorderedList(line);
}

function isBlockLine(line: string): boolean {
  return (
    line.trim() === "" ||
    isCodeFence(line) ||
    isHeader(line) ||
    isList(line) ||
    isBlockQuote(line)
  );
}

/** Schemes a link may carry. Everything else (javascript:, data:, file:, ...) is text. */
const LINK_SCHEMES = new Set(["https", "http", "mailto"]);

/**
 * A link survives only if it is relative, or its scheme is on the allowlist.
 * A denylist loses to the next scheme nobody thought of, and to the ones a
 * browser quietly repairs: it drops tabs and newlines inside a URL and reads a
 * backslash as a slash, so both are refused here instead of being parsed the
 * way a browser would. A protocol-relative `//host` is a link to another site
 * wearing a relative path, so it is refused too.
 */
function sanitizeHref(href: string): string | null {
  const value = href.trim();
  if (value === "" || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme) return LINK_SCHEMES.has(scheme[1].toLowerCase()) ? value : null;
  return value.startsWith("//") ? null : value;
}

function parseInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    nodes.push(buffer);
    buffer = "";
  };

  while (i < text.length) {
    const char = text[i];
    if (!mdChars.has(char)) {
      buffer += char;
      i++;
      continue;
    }

    if (char === "`") {
      const close = text.indexOf("`", i + 1);
      if (close < 0) {
        buffer += char;
        i++;
        continue;
      }
      const code = text.slice(i + 1, close);
      if (code.length === 0) {
        buffer += char;
        i++;
        continue;
      }
      flush();
      nodes.push(
        <code key={`code-${i}`} className="md-inline-code">
          {code}
        </code>,
      );
      i = close + 1;
      continue;
    }

    if (char === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close < 0) {
        buffer += char;
        i++;
        continue;
      }
      const raw = text.slice(i + 2, close);
      if (raw.length === 0) {
        buffer += char;
        i += 2;
        continue;
      }
      flush();
      nodes.push(
        <strong key={`strong-${i}`} className="md-strong">
          {parseInlineMarkdown(raw)}
        </strong>,
      );
      i = close + 2;
      continue;
    }

    if (char === "*" && text[i + 1] !== "*") {
      const close = text.indexOf("*", i + 1);
      if (close < 0) {
        buffer += char;
        i++;
        continue;
      }
      const raw = text.slice(i + 1, close);
      if (raw.length === 0) {
        buffer += char;
        i++;
        continue;
      }
      flush();
      nodes.push(
        <em key={`em-${i}`} className="md-em">
          {parseInlineMarkdown(raw)}
        </em>,
      );
      i = close + 1;
      continue;
    }

    if (char === "[") {
      const closeText = text.indexOf("]", i + 1);
      if (closeText < 0 || text[closeText + 1] !== "(") {
        buffer += char;
        i++;
        continue;
      }
      const closeHref = text.indexOf(")", closeText + 2);
      if (closeHref < 0) {
        buffer += char;
        i++;
        continue;
      }
      const rawText = text.slice(i + 1, closeText);
      const rawHref = text.slice(closeText + 2, closeHref);
      const href = sanitizeHref(rawHref);
      if (!href) {
        buffer += text.slice(i, closeHref + 1);
        i = closeHref + 1;
        continue;
      }
      flush();
      nodes.push(
        <a
          key={`a-${i}`}
          className="md-link"
          href={href}
          rel="noopener noreferrer"
          target="_blank"
        >
          {parseInlineMarkdown(rawText)}
        </a>,
      );
      i = closeHref + 1;
      continue;
    }

    buffer += char;
    i++;
  }

  flush();
  return nodes;
}

function parseInline(text: string): ReactNode {
  const lines = splitLines(text);
  const nodes = lines.flatMap((line, index) => {
    const parsed = parseInlineMarkdown(line);
    if (index === 0) return parsed;
    return [<br key={`lb-${index}`} />, ...parsed];
  });
  return nodes;
}

function parseBlocks(text: string): ReactNode[] {
  const lines = splitLines(text);
  const out: ReactNode[] = [];

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (isCodeFence(line)) {
      const start = i;
      i++;
      const code: string[] = [];
      while (i < lines.length && !isCodeFence(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(
        <pre key={`code-${start}`}>
          <code className="md-code-block">{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (isHeader(line)) {
      const [, , content] = line.match(/^(#{1,6})\s+(.*)$/) ?? [
        "",
        "",
        line,
      ];
      const safe = content;
      out.push(
        <h3 key={`h-${i}`} className="md-h">
          {parseInlineMarkdown(safe)}
        </h3>,
      );
      i++;
      continue;
    }

    if (isBlockQuote(line)) {
      const start = i;
      const quote: string[] = [];
      while (i < lines.length && isBlockQuote(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(
        <blockquote key={`q-${start}`}>
          {parseParagraphLines(quote.join("\n"))}
        </blockquote>,
      );
      continue;
    }

    if (isList(line)) {
      const ordered = isOrderedList(line);
      const start = i;
      const Tag = ordered ? "ol" : "ul";
      const items: ReactNode[] = [];
      while (i < lines.length && isList(lines[i])) {
        const itemLine = lines[i];
        const raw = ordered
          ? itemLine.replace(/^\s*\d+\.\s+/, "")
          : itemLine.replace(/^\s*[-*+]\s+/, "");
        items.push(
          <li key={`li-${i}`}>
            {parseParagraphLines(raw)}
          </li>,
        );
        i++;
      }
      out.push(
        <Tag key={`list-${start}`} className="md-list">
          {items}
        </Tag>,
      );
      continue;
    }

    const start = i;
    const paragraphLines: string[] = [];
    while (i < lines.length && !isBlockLine(lines[i])) {
      paragraphLines.push(lines[i]);
      i++;
    }
    out.push(
      <p key={`p-${start}`}>
        {parseParagraphLines(paragraphLines.join("\n"))}
      </p>,
    );
  }

  return out;
}

function parseParagraphLines(text: string): ReactNode[] {
  const lines = splitLines(text);
  return lines.flatMap((line, index) => {
    const lineNodes = parseInlineMarkdown(line);
    if (index === 0) return lineNodes;
    return [<br key={`plb-${index}`} />, ...lineNodes];
  });
}

/**
 * Subconjunto seguro de markdown sem HTML cru: parágrafos, negrito,
 * itálico, código inline, blocos de código, listas, links, título pequeno e
 * citação, com links em nova aba.
 */
export function Markdown({ text, inline = false, className }: MarkdownProps) {
  const source = text ?? "";
  if (source.trim() === "") return null;

  if (inline) {
    return <span className={`md ${className ?? ""}`}>{parseInline(source)}</span>;
  }

  const blocks = parseBlocks(source);
  if (blocks.length === 0) return null;
  return <div className={`md ${className ?? ""}`}>{blocks}</div>;
}
