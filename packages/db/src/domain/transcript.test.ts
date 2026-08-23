import { describe, expect, it } from "vitest";
import {
  mergeTranscriptRef,
  readTranscriptRef,
  recomputeUsageCommand,
  resumeHintFor,
  transcriptRef,
  TRANSCRIPT_PATH_ENV,
} from "./transcript";

describe("resume hints", () => {
  it("knows how the CLIs it ships with reopen a session", () => {
    expect(resumeHintFor("claude-code", "abc")).toBe("claude --resume abc");
    expect(resumeHintFor("claude", "abc")).toBe("claude --resume abc");
    expect(resumeHintFor("codex", "abc")).toBe("codex resume abc");
  });

  it("stays silent for a CLI whose resume flag it does not know", () => {
    expect(resumeHintFor("gemini-cli", "abc")).toBeNull();
    expect(resumeHintFor("some-new-cli", "abc")).toBeNull();
  });

  it("needs both a cli and a session to build a command", () => {
    expect(resumeHintFor("claude", "")).toBeNull();
    expect(resumeHintFor(null, "abc")).toBeNull();
  });
});

describe("building a reference", () => {
  it("derives the resume command from the cli and session", () => {
    expect(transcriptRef({ cli: "claude", sessionId: "s-1" })).toEqual({
      cli: "claude",
      sessionId: "s-1",
      path: null,
      resume: "claude --resume s-1",
    });
  });

  it("keeps the command the agent sent over the one it would derive", () => {
    const ref = transcriptRef({
      cli: "claude",
      sessionId: "s-1",
      resume: "claude --resume s-1 --dangerously-skip-permissions",
    });
    expect(ref?.resume).toBe("claude --resume s-1 --dangerously-skip-permissions");
  });

  it("returns null when there is nothing to point at", () => {
    expect(transcriptRef({})).toBeNull();
    expect(transcriptRef({ cli: "  ", sessionId: "" })).toBeNull();
  });

  it("keeps a path even from a cli with no resume command", () => {
    expect(transcriptRef({ cli: "gemini-cli", path: "/tmp/chat.json" })).toEqual({
      cli: "gemini-cli",
      sessionId: null,
      path: "/tmp/chat.json",
      resume: null,
    });
  });
});

describe("merging claim and delivery", () => {
  it("fills the path the claim could not know", () => {
    const claimed = transcriptRef({ cli: "claude", sessionId: "s-1" });
    expect(mergeTranscriptRef(claimed, { path: "/home/a/.claude/s-1.jsonl" })).toEqual({
      cli: "claude",
      sessionId: "s-1",
      path: "/home/a/.claude/s-1.jsonl",
      resume: "claude --resume s-1",
    });
  });

  it("keeps the claimed reference when the delivery sends nothing", () => {
    const claimed = transcriptRef({ cli: "codex", sessionId: "s-2" });
    expect(mergeTranscriptRef(claimed, null)).toEqual(claimed);
    expect(mergeTranscriptRef(claimed, undefined)).toEqual(claimed);
  });

  it("accepts a delivery on an attempt that never had a reference", () => {
    expect(mergeTranscriptRef(null, { cli: "codex", sessionId: "s-3" })).toEqual({
      cli: "codex",
      sessionId: "s-3",
      path: null,
      resume: "codex resume s-3",
    });
  });
});

describe("reading what was stored", () => {
  it("reads back the stored reference", () => {
    const stored = { cli: "claude", sessionId: "s-1", path: "/t.jsonl", resume: "x" };
    expect(readTranscriptRef(stored)).toEqual(stored);
  });

  it("degrades an old attempt to the session id its executor recorded", () => {
    expect(readTranscriptRef(null, { cli: "claude", sessionId: "old-1" })).toEqual({
      cli: "claude",
      sessionId: "old-1",
      path: null,
      resume: "claude --resume old-1",
    });
  });

  it("returns null for an attempt with no session and no reference", () => {
    expect(readTranscriptRef(null, {})).toBeNull();
    expect(readTranscriptRef(undefined, { cli: undefined })).toBeNull();
  });
});

describe("recomputing usage from one transcript", () => {
  it("pins a shipped recipe to the path with an argument every shell passes", () => {
    // The environment prefix was POSIX-only syntax: on Windows PowerShell it
    // bound nothing and the recipe measured whichever session ran last.
    expect(recomputeUsageCommand("node -e script", "/home/a/s.jsonl")).toBe(
      "node -e script transcript=/home/a/s.jsonl",
    );
  });

  it("encodes a path with a space so no shell splits it", () => {
    expect(recomputeUsageCommand("node -e script", "/My Repo/s.jsonl")).toBe(
      "node -e script transcript=/My%20Repo/s.jsonl",
    );
  });

  it("keeps the environment prefix for a recipe the workspace rewrote", () => {
    // A custom command was written against the old form; the board pins it the
    // way its author expects instead of reinterpreting it.
    expect(recomputeUsageCommand("python3 count.py", "/My Repo/s.jsonl", "custom")).toBe(
      `${TRANSCRIPT_PATH_ENV}='/My Repo/s.jsonl' python3 count.py`,
    );
  });

  it("offers nothing when there is no path or no command to run", () => {
    expect(recomputeUsageCommand("python3 count.py", null)).toBeNull();
    expect(recomputeUsageCommand("", "/home/a/s.jsonl")).toBeNull();
  });
});
