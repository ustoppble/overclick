import { describe, expect, it } from "vitest";
import { publicOrigin } from "./public-url";

const env = (value?: string) => ({ OVERCLICK_PUBLIC_URL: value });

describe("publicOrigin", () => {
  it("is the configured origin, without path or trailing slash", () => {
    expect(publicOrigin(env("https://board.example.test"))).toBe("https://board.example.test");
    expect(publicOrigin(env(" https://board.example.test/ "))).toBe("https://board.example.test");
    expect(publicOrigin(env("https://board.example.test/app?x=1"))).toBe("https://board.example.test");
  });

  it("is null when nothing usable is configured", () => {
    expect(publicOrigin(env(undefined))).toBeNull();
    expect(publicOrigin(env(""))).toBeNull();
    expect(publicOrigin(env("board.example.test"))).toBeNull();
    expect(publicOrigin(env("javascript:alert(1)"))).toBeNull();
    expect(publicOrigin(env("https://user:pw@board.example.test"))).toBeNull();
  });

  it("accepts plain http only for a local address", () => {
    expect(publicOrigin(env("http://localhost:3000"))).toBe("http://localhost:3000");
    expect(publicOrigin(env("http://127.0.0.1:3100"))).toBe("http://127.0.0.1:3100");
    expect(publicOrigin(env("http://board.example.test"))).toBeNull();
  });
});
