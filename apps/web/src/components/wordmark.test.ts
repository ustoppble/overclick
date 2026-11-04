import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Monogram, Wordmark } from "./wordmark";

/**
 * The promises the mark makes (OCL-37).
 *
 * A monochrome identity is one hex literal away from not being one, and a
 * wordmark that ships in three places — the component, the SVG sources, the
 * favicon — is one nudge away from being three different logos. These tests are
 * cheap on purpose: the drift fails here, not on a tab someone screenshots.
 */

const BRAND = fileURLToPath(new URL("../../public/brand", import.meta.url));
const brandFile = (name: string) => readFileSync(join(BRAND, name), "utf8");

const wordmark = (props: Parameters<typeof Wordmark>[0]) =>
  renderToStaticMarkup(Wordmark(props));

describe("the wordmark", () => {
  it("is drawn, not typed: no font decides what the identity looks like", () => {
    const markup = wordmark({ label: "ir para o board" });
    expect(markup).toContain("<svg");
    expect(markup).toContain("<path");
    // The old mark was styled text in two spans; a machine without the font
    // rendered a different logo.
    expect(markup).not.toContain("<span");
    expect(markup).not.toContain("over");
  });

  it("takes one colour, from whatever theme it lands in", () => {
    const markup = wordmark({ label: "ir para o board" });
    expect(markup).toContain('stroke="currentColor"');
    // Any hex is a second colour waiting to be wrong in one of the themes.
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toContain("rgb");
  });

  it("keeps the over/click hierarchy on alpha alone", () => {
    const markup = wordmark({ label: "ir para o board" });
    expect(markup).toContain('class="wordmark-lead"');
    expect(markup).toContain('class="wordmark-trail"');
    // One group steps back, and it does it without naming a colour.
    expect(markup).toMatch(/class="wordmark-trail" opacity="0\.\d+"/);
    expect(markup).not.toMatch(/class="wordmark-lead"[^>]*opacity=/);
  });

  it("draws every stroke at the one weight of the identity", () => {
    const markup = wordmark({ label: "ir para o board" });
    expect(markup).toContain('stroke-width="2"');
    expect(markup.match(/stroke-width="/g)).toHaveLength(1);
  });

  it("ships with the page: nothing is fetched to render the logo", () => {
    const markup = wordmark({ label: "ir para o board" });
    expect(markup).not.toContain("http");
    expect(markup).not.toContain("url(");
    expect(markup).not.toContain("<use");
    expect(markup).not.toContain("<image");
  });

  it("sizes by prop, and the width follows instead of stretching", () => {
    expect(wordmark({ label: "x", size: 28 })).toContain('height="28"');
    // No width: the viewBox ratio picks it, so the mark can never be squashed
    // by a caller who only had one number to give.
    expect(wordmark({ label: "x", size: 28 })).not.toMatch(/\swidth="/);
  });

  it("is a link home, named, and says so when it is already there", () => {
    const here = wordmark({ label: "ir para o board", current: true });
    expect(here).toContain('href="/board"');
    expect(here).toContain('aria-label="ir para o board"');
    expect(here).toContain('aria-current="page"');
    // The anchor carries the name; the art must not repeat it to a reader.
    expect(here).toContain('aria-hidden="true"');
    expect(wordmark({ label: "ir para o board" })).not.toContain("aria-current");
  });
});

describe("the reduced mark", () => {
  it("is monochrome and silent unless the caller names it", () => {
    const silent = renderToStaticMarkup(Monogram({}));
    expect(silent).toContain('stroke="currentColor"');
    expect(silent).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(silent).toContain('aria-hidden="true"');
    expect(silent).not.toContain("aria-label");

    const named = renderToStaticMarkup(Monogram({ label: "overclick" }));
    expect(named).toContain('aria-label="overclick"');
    expect(named).toContain('role="img"');
    expect(named).not.toContain("aria-hidden");
  });

  it("stays square, so it cannot be stretched by a size prop", () => {
    const markup = renderToStaticMarkup(Monogram({ size: 24 }));
    expect(markup).toContain('width="24"');
    expect(markup).toContain('height="24"');
  });
});

describe("the brand sources on disk", () => {
  it("carry the same curves as the components", () => {
    const paths = (markup: string) => [...markup.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    // The SVG sources and the components come out of one generator
    // (scripts/brand-icons.mjs). If a path here stops matching, someone edited
    // an output instead of the geometry, and the identity has forked.
    for (const d of paths(wordmark({ label: "x" }))) {
      expect(brandFile("wordmark.svg")).toContain(d);
    }
    for (const d of paths(renderToStaticMarkup(Monogram({})))) {
      expect(brandFile("monogram.svg")).toContain(d);
      expect(brandFile("favicon.svg")).toContain(d);
    }
  });

  it("stay monochrome, except the favicon that no theme can reach", () => {
    // A tab paints the icon on its own chrome, so that one file states its two
    // values and switches on the browser's scheme. Everything else inherits.
    expect(brandFile("wordmark.svg")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(brandFile("monogram.svg")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(brandFile("favicon.svg")).toContain("prefers-color-scheme: dark");
  });

  it("ship the raster fallbacks the tab falls back to", () => {
    const png = (name: string) => readFileSync(join(BRAND, name));
    for (const [name, size] of [
      ["icon-32.png", 32],
      ["apple-touch-icon-180.png", 180],
    ] as const) {
      const bytes = png(name);
      expect(bytes.subarray(0, 8).toString("hex"), name).toBe("89504e470d0a1a0a");
      // IHDR is the first chunk: width and height sit at bytes 16 and 20.
      expect(bytes.readUInt32BE(16), name).toBe(size);
      expect(bytes.readUInt32BE(20), name).toBe(size);
    }
  });
});
