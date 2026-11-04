import { describe, expect, it } from "vitest";
import { metadata } from "./layout";

describe("the browser tab", () => {
  it("names the product, not the old default workspace name (F15)", () => {
    expect(metadata.title).toBe("overclick");
  });
});
