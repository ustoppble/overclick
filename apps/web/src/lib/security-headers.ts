/**
 * The browser-side security headers of the board.
 *
 * Two kinds, because they have two different lifetimes:
 *
 * - `SECURITY_HEADERS` are the same on every response, so they live in
 *   next.config.ts and ride on everything the app serves, static files too.
 * - The Content-Security-Policy carries a nonce that must be new on every
 *   request, so it is built per request by the proxy (`src/proxy.ts`) and
 *   handed to the render, which is what lets Next put the nonce on its own
 *   scripts and on the theme boot script in the layout.
 *
 * The hosted overlay repeats the static set at the proxy
 * (deploy/docker-compose.traefik.yml) so a response that never reached the
 * app, a 502 for one, still carries it.
 */

/** A year, subdomains included. No `preload`: that is a promise to a list this repo cannot take back. */
const HSTS = "max-age=31536000; includeSubDomains";

export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Strict-Transport-Security", value: HSTS },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The board uses none of these; naming them off keeps a script that
  // somehow runs from asking for them.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  // CSP's frame-ancestors is the modern form; this is the same refusal for
  // the browsers that only read the old header.
  { key: "X-Frame-Options", value: "DENY" },
];

/** 128 random bits, base64. Unique per request, which is the whole security of a nonce. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The policy. Everything is `'self'` because the board fetches nothing from
 * anywhere else (next.config.ts: no external fonts, analytics or images).
 *
 * - script-src: the nonce only. `'strict-dynamic'` lets the nonced bootstrap
 *   load the chunks it names without listing each one; no `unsafe-inline`.
 * - style-src: self and the nonce. Components set `style={{...}}` on a few
 *   elements (bar widths, chart sizes), and a nonce cannot cover an attribute,
 *   so `style-src-attr` alone allows inline style attributes — they cannot run
 *   script — while `<style>` elements and stylesheets stay locked.
 * - img-src adds `data:` and `blob:`: inline SVG marks and previews.
 * - dev: React needs `eval` for its error stacks and the dev server injects
 *   un-nonced `<style>` tags, so both are opened there and only there.
 */
export function buildCsp(nonce: string, { dev }: { dev: boolean }): string {
  const scriptSrc = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`;
  const styleSrc = dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`;
  return [
    "default-src 'self'",
    scriptSrc,
    styleSrc,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
