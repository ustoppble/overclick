import { describe, expect, it } from "vitest";
import {
  canCreateFirstAdmin,
  isValidEmail,
  isValidPassword,
} from "./first-access";

describe("first-access admin (spec §2 + §6)", () => {
  it("allows signup only when the instance has no users", () => {
    expect(canCreateFirstAdmin(0)).toBe(true);
    expect(canCreateFirstAdmin(1)).toBe(false);
    expect(canCreateFirstAdmin(12)).toBe(false);
  });

  it("accepts a plain email identifier — no verification channel", () => {
    expect(isValidEmail("admin@local")).toBe(true);
    expect(isValidEmail("dev@example.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });

  it("refuses an address longer than 254 characters, the most an email can be", () => {
    const local = "a".repeat(254 - "@x.test".length);
    expect(isValidEmail(`${local}@x.test`)).toBe(true);
    expect(isValidEmail(`${local}a@x.test`)).toBe(false);
    expect(isValidEmail(`${"a".repeat(5000)}@x.test`)).toBe(false);
  });

  it("requires a password of at least 8 characters and nothing else", () => {
    expect(isValidPassword("abcdefgh")).toBe(true);
    expect(isValidPassword("short")).toBe(false);
    expect(isValidPassword("")).toBe(false);
  });
});
