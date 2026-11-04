/**
 * `next/font/local` under vitest. The real loader is a compile-time transform
 * of the Next build (it reads the woff2 files and writes the @font-face), so
 * outside that build the import is an empty shell. Tests that import the
 * root layout get what the transform would hand the layout: a class name and
 * the CSS variable it sets. `inter-font.test.ts` checks the real call.
 */
export default function localFont(options: { variable?: string }) {
  return {
    className: "font-local",
    variable: options.variable ? "font-local-variable" : "",
    style: { fontFamily: "font-local" },
  };
}
