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
 *
 * Preload stays on (E7 review, low): next/font preloads the three files on
 * every route, ~72 KB that a nebula or overclock reader never draws. The
 * alternatives are worse for the theme that is now the default: `preload:
 * false` makes a first xai visit fetch the face only after the CSS is parsed,
 * and the text swaps from the fallback to Inter on screen. `preload` is per
 * call and `variable` can name one family, so preloading only 400 would need a
 * second family and a second variable. The weights are cached after the first
 * visit; revisit if a theme-aware preload lands.
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
