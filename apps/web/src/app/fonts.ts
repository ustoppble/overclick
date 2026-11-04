import localFont from "next/font/local";

/**
 * Inter, served by the app (navigation plan E7, finding M14).
 *
 * The xai theme speaks Inter, and until now it only named it: a screen
 * without Inter installed drew in the next family down the list. The three
 * weights the doctrine uses ship in `fonts/` (Inter 4.001, latin subset,
 * SIL Open Font License 1.1, the licence beside them in `fonts/OFL.txt`),
 * and next/font/local serves them from this origin with the rest of the
 * build: no font CDN, which the "no external fonts" rule in next.config.ts
 * forbids for a self-hosted board.
 *
 * The face is exposed as `--font-inter` on <html>, and only xai's
 * `--oc-font-ui` asks for it, so nebula and overclock draw exactly as before.
 */
export const inter = localFont({
  src: [
    { path: "./fonts/inter-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/inter-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/inter-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-inter",
  display: "swap",
});
