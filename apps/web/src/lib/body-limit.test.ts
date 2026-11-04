import { describe, expect, it } from "vitest";
import { readBodyCapped } from "./body-limit";

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("https://board.example/x", { method: "POST", headers, body });
}

/** A body that arrives in chunks and has no Content-Length, the way chunked uploads do. */
function chunked(chunks: string[], pulled: { n: number }): Request {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[pulled.n];
      pulled.n += 1;
      if (next === undefined) controller.close();
      else controller.enqueue(enc.encode(next));
    },
  });
  return new Request("https://board.example/x", {
    method: "POST",
    body: stream,
    // @ts-expect-error duplex is required by undici for a streamed request body
    duplex: "half",
  });
}

describe("readBodyCapped", () => {
  it("returns the text of a body under the cap", async () => {
    const result = await readBodyCapped(post('{"a":1}'), 100);
    expect(result).toEqual({ ok: true, text: '{"a":1}' });
  });

  it("reads an empty body as an empty string", async () => {
    const result = await readBodyCapped(post(null), 100);
    expect(result).toEqual({ ok: true, text: "" });
  });

  it("refuses a Content-Length over the cap without reading the body", async () => {
    const pulled = { n: 0 };
    const request = chunked(["x"], pulled);
    const lying = new Request(request, { headers: { "content-length": "101" } });
    const result = await readBodyCapped(lying, 100);
    expect(result).toEqual({ ok: false, status: 413 });
    // a ReadableStream primes one pull on construction; no read of ours adds to it
    expect(pulled.n).toBeLessThanOrEqual(1);
  });

  it("refuses a malformed Content-Length", async () => {
    for (const value of ["abc", "-1", "1e9"]) {
      const result = await readBodyCapped(post("x", { "content-length": value }), 100);
      expect(result).toEqual({ ok: false, status: 400 });
    }
  });

  it("cuts a chunked body at the cap instead of buffering it all", async () => {
    const pulled = { n: 0 };
    const chunks = Array.from({ length: 1000 }, () => "x".repeat(10));
    const result = await readBodyCapped(chunked(chunks, pulled), 100);
    expect(result).toEqual({ ok: false, status: 413 });
    // 10 chunks hit the cap exactly, the 11th crosses it; nothing past that is pulled
    expect(pulled.n).toBeLessThan(20);
  });

  it("counts bytes, not characters", async () => {
    // 60 two-byte characters are 120 bytes
    const result = await readBodyCapped(post("é".repeat(60)), 100);
    expect(result).toEqual({ ok: false, status: 413 });
  });

  it("accepts a body exactly at the cap", async () => {
    const result = await readBodyCapped(post("x".repeat(100)), 100);
    expect(result.ok).toBe(true);
  });
});
