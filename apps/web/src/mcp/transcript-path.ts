import { constants, createReadStream, lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * A card names its transcript by path, and the board reads that file (and runs
 * the shipped recipe on it). The path is typed by whoever delivers, so it is
 * not trusted: it must be a regular file, not a link, inside a folder where a
 * CLI keeps its transcripts, and not unreasonably large. Anything else reads
 * as "the board cannot read it", the same answer as a path on another machine.
 */

/** Longest transcript the board reads. Streaming keeps memory flat below it. */
export const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

/** Folders under home where the supported CLIs write their sessions. */
const HOME_FOLDERS = [
  ".claude",
  ".codex",
  ".grok",
  ".gemini",
  ".cursor",
  ".config/opencode",
  ".local/share/opencode",
  ".overclock-app",
];

/**
 * The known transcript folders. CLAUDE_CONFIG_DIR is where Claude Code (and
 * the Overclock app, one per account) moves its tree; OVERCLICK_TRANSCRIPT_DIRS
 * is the operator's own list, separated like PATH. A root that is the
 * filesystem root or the home folder itself would allow everything, so it is
 * dropped.
 */
export function transcriptRoots(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string[] {
  const extra = (env.OVERCLICK_TRANSCRIPT_DIRS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const claude = env.CLAUDE_CONFIG_DIR?.trim();
  const roots = [
    ...HOME_FOLDERS.map((folder) => path.join(home, folder)),
    ...(claude ? [claude] : []),
    ...extra,
  ];
  return roots
    .filter((root) => path.isAbsolute(root))
    .map((root) => path.resolve(root))
    .filter((root) => root !== path.parse(root).root && root !== path.resolve(home));
}

function realOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The real path of a transcript the board may read, or null. `~/x` is taken
 * against this machine's home. A symlink as the file itself is refused (a link
 * is exactly how a transcript path is made to point elsewhere); a link higher
 * up is followed and the real path must still sit in a known folder.
 */
export function safeTranscriptPath(
  raw: string | null | undefined,
  roots: string[] = transcriptRoots(),
  maxBytes: number = MAX_TRANSCRIPT_BYTES,
): string | null {
  let wanted = (raw ?? "").trim();
  if (!wanted || wanted.includes("\0")) return null;
  if (wanted === "~" || wanted.startsWith("~/")) wanted = path.join(homedir(), wanted.slice(2));
  if (!path.isAbsolute(wanted)) return null;
  wanted = path.resolve(wanted);
  try {
    const stat = lstatSync(wanted);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) return null;
  } catch {
    return null;
  }
  const real = realOrNull(wanted);
  if (!real) return null;
  const allowed = roots
    .map((root) => realOrNull(root))
    .some((root) => root !== null && inside(root, real));
  return allowed ? real : null;
}

/**
 * The lines of a transcript, streamed. The file is opened without following a
 * link and checked on the descriptor it opened (a regular file, under the
 * limit), and reading stops with an error if it grows past the limit.
 */
export async function* readTranscriptLines(
  file: string,
  maxBytes: number = MAX_TRANSCRIPT_BYTES,
): AsyncGenerator<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("transcript is not readable");
    const stream = createReadStream("", { fd: handle.fd, autoClose: false, end: maxBytes });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let read = 0;
    for await (const line of lines) {
      read += Buffer.byteLength(line) + 1;
      if (read > maxBytes) throw new Error("transcript is over the size limit");
      yield line;
    }
  } finally {
    await handle.close();
  }
}
