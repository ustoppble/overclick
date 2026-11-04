import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy, config } from "./proxy";

/** R6 of the OCL-224 review, fixed in OCL-227. */
describe("invite proxy", () => {
  it("sends a link with a malformed escape to the invalid-invite page", () => {
    for (const token of ["abc%", "abc%zz", "%E0%A4%A"]) {
      const res = proxy(new NextRequest(`http://board.test/invite/${token}`));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/invite/invalid");
    }
  });

  it("lets a well-formed link through untouched", () => {
    for (const token of ["Q2x2ZXI", "abc%25", "naoexiste"]) {
      const res = proxy(new NextRequest(`http://board.test/invite/${token}`));
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });
});

describe("the security proxy", () => {
  it("puts a nonce-bearing CSP on the response and forwards the nonce to the render", () => {
    const res = proxy(new NextRequest("http://board.test/board"));
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("frame-ancestors 'none'");
    // the request headers Next renders with ride in x-middleware-request-*
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });

  it("uses a different nonce for every request", () => {
    const nonces = Array.from({ length: 20 }, () =>
      /'nonce-([^']+)'/.exec(
        proxy(new NextRequest("http://board.test/board")).headers.get("content-security-policy")!,
      )?.[1],
    );
    expect(new Set(nonces).size).toBe(20);
  });

  it("does not trust a nonce or CSP the caller sent", () => {
    const res = proxy(
      new NextRequest("http://board.test/board", {
        headers: { "x-nonce": "attacker", "content-security-policy": "script-src *" },
      }),
    );
    expect(res.headers.get("x-middleware-request-x-nonce")).not.toBe("attacker");
    expect(res.headers.get("x-middleware-request-content-security-policy")).not.toContain("*");
  });

  it("covers pages but leaves the build's static assets alone", () => {
    const matcher = config.matcher;
    const re = new RegExp(`^${matcher}$`);
    for (const path of ["/", "/board", "/login", "/settings/team", "/invite/abc", "/install.sh"]) {
      expect(re.test(path), path).toBe(true);
    }
    for (const path of ["/_next/static/chunks/a.js", "/_next/image", "/brand/favicon.svg"]) {
      expect(re.test(path), path).toBe(false);
    }
  });
});
