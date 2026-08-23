import { bindRecipeSettings, type RecipeSource } from "./usage-recipe";

/**
 * Transcript references: the pointer back to what the agent actually did.
 *
 * A run already leaves a full transcript on the machine that executed it. The
 * board stores the reference to that file and nothing else: cli, session id,
 * the path, and the command that reopens the session. The content never
 * travels, because a copy inside the board would be a second, staler version
 * of a file the board cannot keep honest, and because the transcript is the
 * agent's whole conversation, which belongs on the agent's machine.
 *
 * With the reference on the card you can audit the run, resume that session,
 * and re-measure usage later when the numbers came back missing or estimated.
 */

/** What the board keeps about a transcript. Reference only, never content. */
export type TranscriptRef = {
  /** CLI that ran the card, as the executor named it. */
  cli: string | null;
  sessionId: string | null;
  /** Path on the machine that ran the card. Null until an agent sends it. */
  path: string | null;
  /** Command that reopens that session in that CLI. */
  resume: string | null;
};

export type TranscriptRefInput = {
  cli?: string | null;
  sessionId?: string | null;
  path?: string | null;
  resume?: string | null;
};

/**
 * Env var the usage recipes read before they go looking for the newest
 * session. Set it and the same script that measured the run re-measures
 * exactly the transcript the card points at.
 */
export const TRANSCRIPT_PATH_ENV = "TRANSCRIPT_PATH";

/**
 * How each CLI reopens a session by id. Only CLIs whose resume flag is known
 * are listed: a wrong command on the clipboard is worse than no button. The
 * binary names agents actually send sit next to the catalog ids so an attempt
 * resolves here without the web app's alias table.
 */
const RESUME_HINTS: Record<string, (sessionId: string) => string> = {
  "claude-code": (id) => `claude --resume ${id}`,
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
};

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The resume command for a cli/session pair, or null when there is none. */
export function resumeHintFor(
  cli: string | null | undefined,
  sessionId: string | null | undefined,
): string | null {
  const key = clean(cli)?.toLowerCase();
  const id = clean(sessionId);
  if (!key || !id) return null;
  return RESUME_HINTS[key]?.(id) ?? null;
}

/**
 * Normalizes a reference, deriving the resume command when the agent did not
 * send one. Returns null when there is nothing to point at: an empty
 * reference on a card would only promise an audit trail that does not exist.
 */
export function transcriptRef(input: TranscriptRefInput): TranscriptRef | null {
  const cli = clean(input.cli);
  const sessionId = clean(input.sessionId);
  const path = clean(input.path);
  const resume = clean(input.resume) ?? resumeHintFor(cli, sessionId);
  if (!cli && !sessionId && !path && !resume) return null;
  return { cli, sessionId, path, resume };
}

/**
 * Deliver refines what claim stored. The path is the field an agent usually
 * only knows at the end, so a delivery that sends it keeps everything the
 * claim already recorded instead of replacing the reference wholesale.
 */
export function mergeTranscriptRef(
  stored: TranscriptRef | null | undefined,
  incoming: TranscriptRefInput | null | undefined,
): TranscriptRef | null {
  if (!incoming) return stored ?? null;
  return transcriptRef({
    cli: clean(incoming.cli) ?? stored?.cli,
    sessionId: clean(incoming.sessionId) ?? stored?.sessionId,
    path: clean(incoming.path) ?? stored?.path,
    resume: clean(incoming.resume) ?? stored?.resume,
  });
}

function field(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = clean(value);
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/**
 * The reference for an attempt, whatever it was stored with. Cards claimed
 * before this column existed only ever recorded the session id inside the
 * executor blob: they still produce a usable reference from cli and session,
 * with the path missing, instead of showing nothing.
 */
export function readTranscriptRef(
  stored: unknown,
  fallback: { cli?: string | null; sessionId?: string | null } = {},
): TranscriptRef | null {
  const record =
    stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  return transcriptRef({
    cli: field(record, "cli") ?? fallback.cli,
    sessionId: field(record, "sessionId", "session_id") ?? fallback.sessionId,
    path: field(record, "path"),
    resume: field(record, "resume"),
  });
}

/** Single-quotes a path for a POSIX shell, so a space never splits it. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The workspace recipe command, pinned to one transcript. Null when the CLI
 * has no command to run or the reference has no path: the board would rather
 * show no button than one that measures whichever session ran last.
 *
 * A shipped recipe takes the path as a `transcript=` argument, which every
 * shell passes through, including PowerShell, where the `VAR=value command`
 * prefix is not syntax at all. A recipe the workspace rewrote keeps the
 * environment prefix: it was written against the old form and the board does
 * not get to reinterpret somebody else's command.
 */
export function recomputeUsageCommand(
  command: string | null | undefined,
  path: string | null | undefined,
  source: RecipeSource = "seed",
): string | null {
  const script = clean(command);
  const target = clean(path);
  if (!script || !target) return null;
  return source === "custom"
    ? `${TRANSCRIPT_PATH_ENV}=${shellQuote(target)} ${script}`
    : bindRecipeSettings(script, { transcript: target });
}
