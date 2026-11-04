import { describe, expect, it } from "vitest";
import { checkProjectPrefix } from "./project-prefix";

const projects = [
  { name: "overclick", idPrefix: "OCL" },
  { name: "Site", idPrefix: "OVW" },
];

describe("the card prefix, checked as it is typed (E5)", () => {
  it("accepts 2 to 4 letters or digits, in any case", () => {
    expect(checkProjectPrefix("glx", projects)).toEqual({ ok: true, prefix: "GLX" });
    expect(checkProjectPrefix("A1", projects)).toEqual({ ok: true, prefix: "A1" });
  });

  it("refuses a prefix that is too short, too long or has other characters", () => {
    expect(checkProjectPrefix("G", projects)).toEqual({ ok: false, reason: "invalid" });
    expect(checkProjectPrefix("GLXYZ", projects)).toEqual({ ok: false, reason: "invalid" });
    expect(checkProjectPrefix("G-X", projects)).toEqual({ ok: false, reason: "invalid" });
  });

  it("names the project that already owns it", () => {
    expect(checkProjectPrefix("ocl", projects)).toEqual({
      ok: false,
      reason: "taken",
      owner: "overclick",
    });
  });

  it("says nothing about an empty field", () => {
    expect(checkProjectPrefix("  ", projects)).toEqual({ ok: false, reason: "empty" });
  });
});
