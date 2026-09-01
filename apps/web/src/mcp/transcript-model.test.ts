import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalTranscriptModel,
  identityFromTranscript,
} from "./transcript-model";

describe("canonicalTranscriptModel", () => {
  it("drops Grok's -build suffix after normalizing punctuation", () => {
    expect(canonicalTranscriptModel("grok-4.5-build")).toBe("grok-4-5");
    expect(canonicalTranscriptModel("grok-4.6-build")).toBe("grok-4-6");
    expect(canonicalTranscriptModel("grok-4.6")).toBe("grok-4-6");
  });
});

describe("identityFromTranscript", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function grokFile(model: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ocl-162-"));
    dirs.push(dir);
    const file = path.join(dir, "updates.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        timestamp: 2_000_000_000,
        method: "_x.ai/session/update",
        params: {
          update: {
            sessionUpdate: "turn_completed",
            usage: {
              modelUsage: { [model]: { inputTokens: 10, outputTokens: 4 } },
            },
          },
        },
      })}\n`,
    );
    return file;
  }

  it("reads grok-4.5-build from a Grok updates.jsonl as grok-4-5", () => {
    const file = grokFile("grok-4.5-build");
    expect(identityFromTranscript({ cli: "grok", path: file })).toEqual({
      model: "grok-4-5",
      chain: "grok-4-5",
    });
  });

  it("returns null when the transcript path is missing or unreadable", () => {
    expect(identityFromTranscript({ cli: "grok", path: null })).toBeNull();
    expect(
      identityFromTranscript({
        cli: "grok",
        path: "/no/such/ocl-162-transcript.jsonl",
      }),
    ).toBeNull();
  });

  it("returns null rather than inventing a model when the file names none", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ocl-162-"));
    dirs.push(dir);
    const file = path.join(dir, "updates.jsonl");
    writeFileSync(file, `${JSON.stringify({ timestamp: 1, params: { update: { sessionUpdate: "idle" } } })}\n`);
    expect(identityFromTranscript({ cli: "grok", path: file })).toBeNull();
  });
});
