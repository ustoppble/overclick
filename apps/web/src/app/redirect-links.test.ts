import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REDIRECT_SOURCES } from "../lib/redirects";

/**
 * The app never links to an address that only redirects (E3 review): a link
 * to /insights or /home costs every click a hop, and once the redirect is a
 * 308 the browser keeps the old address in its history for good. The pages
 * that answer those addresses, and the table that says where they go, are the
 * only places allowed to name them.
 */
const src = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const ALLOWED = new Set([
  "lib/redirects.ts",
  ...REDIRECT_SOURCES.map((source) => `app${source}/page.tsx`),
]);

describe("no link of the app lands on a redirect", () => {
  it("names none of the old addresses in an href, a template or a string", () => {
    const pattern = new RegExp(
      `["'\`](${REDIRECT_SOURCES.map((source) => source.replace("/", "\\/")).join("|")})(?=[?#"'\`/$])`,
    );
    const offenders: string[] = [];
    for (const file of sources(src)) {
      const name = relative(src, file);
      if (ALLOWED.has(name)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          // comments may tell the story of an address; only code links to it
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (pattern.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
