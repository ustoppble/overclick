import { describe, expect, it } from "vitest";
import {
  APP_VERSION,
  HEARTBEAT_TTL_MS,
  isHeartbeatFresh,
  isNewer,
  parseUpdateStatus,
} from "./updates";

describe("update version comparison", () => {
  it("treats a higher patch, minor or major as newer", () => {
    expect(isNewer("v0.1.2", "0.1.1")).toBe(true);
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
  });

  it("treats same or older versions as not newer", () => {
    expect(isNewer("v0.1.1", "0.1.1")).toBe(false);
    expect(isNewer("0.1.0", "0.1.1")).toBe(false);
    expect(isNewer("v0.0.9", "0.1.1")).toBe(false);
  });

  it("does not flag an instance already running the tagged release (OCL-73)", () => {
    // The 2026-08-19 incident: a tag was pushed without bumping every
    // package.json in the same commit, so a deployed instance running that
    // exact tag's content still read an older APP_VERSION and got told to
    // update itself. The fix is release discipline (scripts/verify-release-
    // version.sh), not a code branch here — this test locks in the half the
    // comparator is responsible for: once the version truly matches the tag,
    // isNewer must say no.
    expect(isNewer("v0.2.0", "0.2.0")).toBe(false);
  });

  it("rejects garbage tags instead of updating", () => {
    expect(isNewer("latest", "0.1.1")).toBe(false);
    expect(isNewer("", "0.1.1")).toBe(false);
  });

  it("reads the running version from the package manifest", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("detecting the updater sidecar", () => {
  const now = 1_000_000;

  it("counts a recent heartbeat as a running sidecar", () => {
    expect(isHeartbeatFresh(now - 4000, now)).toBe(true);
    expect(isHeartbeatFresh(now - HEARTBEAT_TTL_MS, now)).toBe(true);
  });

  it("treats a stale heartbeat as gone, not as running", () => {
    expect(isHeartbeatFresh(now - HEARTBEAT_TTL_MS - 1, now)).toBe(false);
    expect(isHeartbeatFresh(now - 600_000, now)).toBe(false);
  });

  it("reports absent when the sidecar never wrote a beat", () => {
    expect(isHeartbeatFresh(null, now)).toBe(false);
  });

  it("accepts a beat from the near future instead of calling clock skew death", () => {
    expect(isHeartbeatFresh(now + 2000, now)).toBe(true);
  });
});

describe("reading what the updater reported", () => {
  it("parses each phase the sidecar writes", () => {
    for (const phase of ["pulling", "recreating", "done", "failed"]) {
      expect(parseUpdateStatus(`{"phase":"${phase}","at":"2026-08-17T00:00:00Z"}`)?.phase).toBe(
        phase,
      );
    }
  });

  it("keeps the docker output of a failed run", () => {
    const status = parseUpdateStatus(
      '{"phase":"failed","at":"2026-08-17T00:00:00Z","detail":"no such image"}',
    );
    expect(status?.detail).toBe("no such image");
  });

  it("reports no detail rather than an empty one", () => {
    expect(parseUpdateStatus('{"phase":"done","at":"x","detail":null}')?.detail).toBeNull();
    expect(parseUpdateStatus('{"phase":"done","at":"x","detail":"  "}')?.detail).toBeNull();
  });

  it("returns null on a half-written or bogus status", () => {
    expect(parseUpdateStatus('{"phase":"pul')).toBeNull();
    expect(parseUpdateStatus('{"phase":"exploding"}')).toBeNull();
    expect(parseUpdateStatus("")).toBeNull();
    expect(parseUpdateStatus("null")).toBeNull();
  });
});
