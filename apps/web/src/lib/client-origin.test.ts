import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientOrigin } from "./client-origin";

/**
 * Behind Cloudflare the last hop of X-Forwarded-For is Cloudflare's edge,
 * shared by everyone who comes through it. OVERCLICK_CLIENT_IP_HEADER names
 * the header the edge writes the visitor's address into (cf-connecting-ip),
 * and it is only read where the deploy also declares a trusted proxy.
 * Addresses are from the documentation ranges.
 */
describe("clientOrigin", () => {
  const EDGE = "203.0.113.10";

  afterEach(() => {
    delete process.env.OVERCLICK_TRUSTED_PROXY;
    delete process.env.OVERCLICK_CLIENT_IP_HEADER;
  });

  function behindEdge(visitor?: string): Headers {
    return new Headers({
      "x-forwarded-for": `${visitor ?? "198.51.100.99"}, ${EDGE}`,
      ...(visitor ? { "cf-connecting-ip": visitor } : {}),
    });
  }

  it("names no origin when no proxy is declared, whatever the headers say", () => {
    process.env.OVERCLICK_CLIENT_IP_HEADER = "cf-connecting-ip";
    expect(clientOrigin(behindEdge("198.51.100.1"))).toBeNull();
  });

  it("keeps reading the last X-Forwarded-For hop when no client IP header is named", () => {
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    expect(clientOrigin(behindEdge("198.51.100.1"))).toBe(EDGE);
  });

  it("reads the named header behind a trusted proxy", () => {
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    process.env.OVERCLICK_CLIENT_IP_HEADER = "CF-Connecting-IP";
    expect(clientOrigin(behindEdge("198.51.100.1"))).toBe("198.51.100.1");
    expect(clientOrigin(behindEdge("198.51.100.2"))).toBe("198.51.100.2");
  });

  it("falls back to the last hop when the named header is missing", () => {
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    process.env.OVERCLICK_CLIENT_IP_HEADER = "cf-connecting-ip";
    expect(clientOrigin(behindEdge())).toBe(EDGE);
  });

  describe("validates the named header", () => {
    beforeEach(() => {
      process.env.OVERCLICK_TRUSTED_PROXY = "1";
      process.env.OVERCLICK_CLIENT_IP_HEADER = "cf-connecting-ip";
    });

    function claiming(value: string): Headers {
      return new Headers({
        "x-forwarded-for": `198.51.100.99, ${EDGE}`,
        "cf-connecting-ip": value,
      });
    }

    it("falls back to the last hop for garbage, so a forged string is no fresh origin", () => {
      for (const junk of ["not-an-ip", "999.1.1.1", "1.2.3", "<script>", "198.51.100.1:443", "fe80::1%eth0", "a".repeat(300)]) {
        expect(clientOrigin(claiming(junk))).toBe(EDGE);
      }
    });

    it("falls back for an empty or blank value", () => {
      expect(clientOrigin(claiming(""))).toBe(EDGE);
      expect(clientOrigin(claiming("   "))).toBe(EDGE);
    });

    it("falls back when the header carries more than one value", () => {
      expect(clientOrigin(claiming("198.51.100.1, 198.51.100.2"))).toBe(EDGE);
      expect(clientOrigin(claiming("198.51.100.1,198.51.100.2"))).toBe(EDGE);
    });

    it("accepts a valid IPv4", () => {
      expect(clientOrigin(claiming("198.51.100.7"))).toBe("198.51.100.7");
      expect(clientOrigin(claiming("  198.51.100.7  "))).toBe("198.51.100.7");
    });

    it("accepts a valid IPv6", () => {
      expect(clientOrigin(claiming("2001:db8::7"))).toBe("2001:db8::7");
      expect(clientOrigin(claiming("2001:db8:0:0:0:0:0:7"))).toBe("2001:db8:0:0:0:0:0:7");
    });
  });

  it("falls back to X-Real-IP only where there is no X-Forwarded-For, as before", () => {
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    expect(clientOrigin(new Headers({ "x-real-ip": "198.51.100.5" }))).toBe("198.51.100.5");
    expect(clientOrigin(new Headers())).toBeNull();
  });
});
