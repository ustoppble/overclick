import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "./lib/security-headers";

/** Where a link that cannot be decoded is sent: a token no invitation has. */
const UNREADABLE_INVITE = "/invite/invalid";

/**
 * An invite link mangled into a malformed escape (a lone `%`, a cut `%E0%A4`)
 * never reaches the invite page: Next decodes the `[token]` segment before any
 * page code runs, fails, and answers a bare 500 (OCL-227). Such a link is
 * simply an invalid invitation, so the browser is sent to the page that
 * already says so, with the same words a made-up link gets.
 */
function unreadableInvite(request: NextRequest): NextResponse | null {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/invite/")) return null;
  try {
    decodeURIComponent(pathname.slice("/invite/".length));
    return null;
  } catch {
    // A redirect, not a rewrite: a rewrite keeps the original URL, and Next
    // decodes the params from that one and fails all the same.
    return NextResponse.redirect(new URL(UNREADABLE_INVITE, request.url));
  }
}

/**
 * Every page gets a Content-Security-Policy with a nonce made for this request.
 * The policy goes on the response, and on the request too: Next reads the
 * nonce out of the request's policy while it renders and stamps it on its own
 * scripts, and `x-nonce` hands it to the layout for the theme boot script.
 * Whatever a caller sent under either name is overwritten, never trusted.
 */
export function proxy(request: NextRequest) {
  const redirect = unreadableInvite(request);
  if (redirect) return redirect;

  const nonce = newNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // The build's own static files and the brand marks need no policy of their
  // own and no nonce; everything else is a page, a route or an action.
  matcher: "/((?!_next/static|_next/image|brand/).*)",
};
