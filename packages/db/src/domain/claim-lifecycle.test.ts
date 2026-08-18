import { describe, expect, it } from "vitest";
import {
  claimExpiresAt,
  claimInactiveMinutes,
  isClaimStale,
  validClaimTimeoutMinutes,
} from "./claim-lifecycle";

describe("claim lease", () => {
  const activity = new Date("2026-08-18T12:00:00.000Z");

  it("expires on the configured boundary, not before it", () => {
    expect(claimExpiresAt(activity, 60).toISOString()).toBe(
      "2026-08-18T13:00:00.000Z",
    );
    expect(isClaimStale(activity, 60, new Date("2026-08-18T12:59:59.999Z"))).toBe(false);
    expect(isClaimStale(activity, 60, new Date("2026-08-18T13:00:00.000Z"))).toBe(true);
  });

  it("reports whole inactive minutes without going negative", () => {
    expect(claimInactiveMinutes(activity, new Date("2026-08-18T12:07:59.000Z"))).toBe(7);
    expect(claimInactiveMinutes(activity, new Date("2026-08-18T11:59:00.000Z"))).toBe(0);
  });

  it("accepts workspace timeouts from one minute through one week", () => {
    expect(validClaimTimeoutMinutes(1)).toBe(true);
    expect(validClaimTimeoutMinutes(10_080)).toBe(true);
    expect(validClaimTimeoutMinutes(0)).toBe(false);
    expect(validClaimTimeoutMinutes(10_081)).toBe(false);
    expect(validClaimTimeoutMinutes(1.5)).toBe(false);
  });
});
