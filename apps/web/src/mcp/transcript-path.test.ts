import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTranscriptLines, safeTranscriptPath, transcriptRoots } from "./transcript-path";

describe("safeTranscriptPath", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "ocl-sec-transcript-"));
    root = path.join(base, "sessions");
    outside = path.join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(root, "ok.jsonl"), '{"a":1}\n');
    writeFileSync(path.join(outside, "secret.txt"), "not a transcript\n");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("returns the real path of a regular file under a known folder", () => {
    const resolved = safeTranscriptPath(path.join(root, "ok.jsonl"), [root]);
    expect(resolved).not.toBeNull();
    expect(path.basename(resolved!)).toBe("ok.jsonl");
  });

  it("refuses a file outside every known folder", () => {
    expect(safeTranscriptPath(path.join(outside, "secret.txt"), [root])).toBeNull();
  });

  it("refuses a .. that climbs out of the folder", () => {
    expect(safeTranscriptPath(path.join(root, "..", "outside", "secret.txt"), [root])).toBeNull();
  });

  it("refuses a symlink even when it points at a file inside the folder", () => {
    symlinkSync(path.join(root, "ok.jsonl"), path.join(root, "link.jsonl"));
    expect(safeTranscriptPath(path.join(root, "link.jsonl"), [root])).toBeNull();
  });

  it("refuses a symlink that points outside the folder", () => {
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "evil.jsonl"));
    expect(safeTranscriptPath(path.join(root, "evil.jsonl"), [root])).toBeNull();
  });

  it("refuses a file reached through a symlinked folder that leads outside", () => {
    symlinkSync(outside, path.join(root, "dir"));
    expect(safeTranscriptPath(path.join(root, "dir", "secret.txt"), [root])).toBeNull();
  });

  it("refuses a directory, a FIFO and a device", () => {
    mkdirSync(path.join(root, "folder"));
    expect(safeTranscriptPath(path.join(root, "folder"), [root])).toBeNull();
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    expect(safeTranscriptPath(path.join(root, "pipe"), [root])).toBeNull();
    expect(safeTranscriptPath("/dev/zero", ["/dev"])).toBeNull();
  });

  it("refuses a file over the size limit", () => {
    const big = path.join(root, "big.jsonl");
    writeFileSync(big, "");
    truncateSync(big, 2_048);
    expect(safeTranscriptPath(big, [root], 1_024)).toBeNull();
    expect(safeTranscriptPath(big, [root], 4_096)).not.toBeNull();
  });

  it("refuses a relative path, a NUL byte, an empty path and a path that does not exist", () => {
    expect(safeTranscriptPath("ok.jsonl", [root])).toBeNull();
    expect(safeTranscriptPath(`${path.join(root, "ok.jsonl")}\0.txt`, [root])).toBeNull();
    expect(safeTranscriptPath("", [root])).toBeNull();
    expect(safeTranscriptPath(path.join(root, "missing.jsonl"), [root])).toBeNull();
  });

  it("refuses everything when no folder is known", () => {
    expect(safeTranscriptPath(path.join(root, "ok.jsonl"), [])).toBeNull();
  });

  it("does not take a sibling whose name only starts like the folder", () => {
    const sibling = `${root}-evil`;
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, "x.jsonl"), "{}\n");
    expect(safeTranscriptPath(path.join(sibling, "x.jsonl"), [root])).toBeNull();
  });
});

describe("transcriptRoots", () => {
  it("covers the CLIs' own folders under home, the Claude config dir and the operator's list", () => {
    const roots = transcriptRoots(
      { CLAUDE_CONFIG_DIR: "/cfg/claude", OVERCLICK_TRANSCRIPT_DIRS: `/extra/a${path.delimiter}/extra/b` },
      "/home/me",
    );
    expect(roots).toEqual(expect.arrayContaining([
      "/home/me/.claude", "/home/me/.codex", "/home/me/.grok", "/cfg/claude", "/extra/a", "/extra/b",
    ]));
  });

  it("never includes the home folder itself or the filesystem root", () => {
    const roots = transcriptRoots({ OVERCLICK_TRANSCRIPT_DIRS: `/${path.delimiter}` }, "/home/me");
    expect(roots).not.toContain("/home/me");
    expect(roots).not.toContain("/");
  });
});

describe("readTranscriptLines", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "ocl-sec-lines-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("streams the lines of a file", async () => {
    const file = path.join(base, "t.jsonl");
    writeFileSync(file, "one\ntwo\n\nthree");
    const seen: string[] = [];
    for await (const line of readTranscriptLines(file)) seen.push(line);
    expect(seen).toEqual(["one", "two", "", "three"]);
  });

  it("refuses a symlink at open time", async () => {
    const file = path.join(base, "t.jsonl");
    writeFileSync(file, "one\n");
    symlinkSync(file, path.join(base, "l.jsonl"));
    await expect((async () => { for await (const _ of readTranscriptLines(path.join(base, "l.jsonl"))) { /* drain */ } })()).rejects.toThrow();
  });

  it("stops reading past the size limit", async () => {
    const file = path.join(base, "t.jsonl");
    writeFileSync(file, "x".repeat(4_096));
    await expect((async () => { for await (const _ of readTranscriptLines(file, 1_024)) { /* drain */ } })()).rejects.toThrow();
  });
});
