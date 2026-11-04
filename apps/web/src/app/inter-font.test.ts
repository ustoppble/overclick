import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The app serves Inter itself (navigation plan E7, finding M14).
 *
 * xai asked for Inter by name and never loaded it, so every screen without
 * Inter installed drew in the next family down the list. The face now ships
 * in the repository and goes out through next/font/local: nothing is fetched
 * from a font CDN (the "no external fonts" rule in next.config.ts), and the
 * licence travels beside the files, as the OFL asks.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");

const WEIGHTS = [400, 500, 600] as const;

describe("Inter is served by the app", () => {
  for (const weight of WEIGHTS) {
    it(`ships the ${weight} face as a local woff2`, () => {
      const file = join(here, `fonts/inter-latin-${weight}-normal.woff2`);
      expect(existsSync(file)).toBe(true);
      // "wOF2", the WOFF2 signature: a real font, not a pointer to one.
      expect(readFileSync(file).subarray(0, 4).toString("latin1")).toBe("wOF2");
      expect(statSync(file).size).toBeGreaterThan(10_000);
    });
  }

  it("carries the SIL Open Font License beside the files", () => {
    const licence = read("fonts/OFL.txt");
    expect(licence).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(licence).toContain("The Inter Project Authors");
  });

  it("loads them through next/font/local, never a CDN", () => {
    const fonts = read("fonts.ts");
    expect(fonts).toContain('from "next/font/local"');
    for (const weight of WEIGHTS) {
      expect(fonts).toContain(`inter-latin-${weight}-normal.woff2`);
    }
    expect(fonts).not.toMatch(/https?:\/\//);
    expect(fonts).not.toContain("next/font/google");
  });

  it("puts the face on <html>, so every page and the login screen have it", () => {
    const layout = read("layout.tsx");
    expect(layout).toMatch(/className=\{inter\.variable\}/);
  });

  it("xai names the served face first", () => {
    const xai = read("../styles/themes/xai.css");
    expect(xai).toMatch(/--oc-font-ui:\s*var\(--font-inter\),\s*Inter,/);
  });
});
