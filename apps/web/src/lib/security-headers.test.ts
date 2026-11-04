import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { buildCsp, newNonce, SECURITY_HEADERS } from "./security-headers";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

describe("the static security headers", () => {
  const byKey = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key.toLowerCase(), h.value]));

  it("carry every header the audit asked for", () => {
    expect(Object.keys(byKey).sort()).toEqual(
      [
        "permissions-policy",
        "referrer-policy",
        "strict-transport-security",
        "x-content-type-options",
        "x-frame-options",
      ].sort(),
    );
  });

  it("pins HSTS at a year or more with subdomains", () => {
    const hsts = byKey["strict-transport-security"];
    const age = Number(/max-age=(\d+)/.exec(hsts)?.[1]);
    expect(age).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain("includeSubDomains");
  });

  it("sets nosniff, a strict referrer policy and no framing", () => {
    expect(byKey["x-content-type-options"]).toBe("nosniff");
    expect(byKey["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["x-frame-options"]).toBe("DENY");
  });

  it("switches off the powerful features the board never uses", () => {
    const policy = byKey["permissions-policy"];
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it("are served on every route by next.config", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((rule) => rule.source === "/:path*");
    expect(all).toBeDefined();
    expect(all!.headers).toEqual(SECURITY_HEADERS);
  });
});

describe("the Content-Security-Policy", () => {
  const nonce = newNonce();
  const csp = buildCsp(nonce, { dev: false });

  it("draws a fresh, unguessable nonce each time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(seen.size).toBe(50);
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
  });

  it("starts from self and closes framing, plugins, base and forms", () => {
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
    expect(directive(csp, "font-src")).toBe("font-src 'self'");
  });

  it("lets scripts run only with the nonce, never inline or eval, in production", () => {
    const script = directive(csp, "script-src")!;
    expect(script).toContain(`'nonce-${nonce}'`);
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("unsafe-eval");
  });

  it("keeps styles to self and the nonce, with only inline style attributes allowed", () => {
    expect(directive(csp, "style-src")).toBe(`style-src 'self' 'nonce-${nonce}'`);
    expect(directive(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
  });

  it("allows no remote origin anywhere", () => {
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it("opens eval and inline styles for the dev server only", () => {
    const dev = buildCsp(nonce, { dev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "style-src")).toContain("'unsafe-inline'");
    expect(directive(dev, "style-src")).not.toContain("nonce-");
  });
});
