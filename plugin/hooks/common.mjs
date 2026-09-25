// Shared, side-effect-free helpers for every OverClick hook.
//
// The hooks used to be POSIX shell. Claude Code on Windows without Git Bash
// runs hook commands through PowerShell, which neither parses the POSIX form
// ("${CLAUDE_PLUGIN_ROOT}"/hooks/x.sh — the bare slash after the string reads
// as a division operator) nor has a shell able to execute .sh at all, so every
// hook died silently there (issue #63). Node is the one runtime a Claude Code
// client is guaranteed to have, and `node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"`
// keeps the whole path inside the quotes. Nothing here may shell out: no jq,
// no python, no curl, no bash. Only node built-ins.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function configFile() {
  if (process.env.OVERCLICK_CONFIG_FILE) return process.env.OVERCLICK_CONFIG_FILE;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "overclick", "config");
}

// Last `key=value` line wins, exactly like `grep -E "^key=" | tail -n 1`.
export function setting(key) {
  let raw;
  try {
    raw = fs.readFileSync(configFile(), "utf8");
  } catch {
    return "";
  }
  const prefix = `${key}=`;
  let value = "";
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(prefix)) value = line.slice(prefix.length);
  }
  return value;
}

export function enabled(key) {
  return setting(key) === "1";
}

export function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The board answers a JSON-RPC tools/call. `reachable` is false only when the
// board itself could not be reached (no url/token, connection refused, closed
// port, timeout, non-2xx) — never when it answered with zero matching rows.
// Callers that need to tell "board said no" from "board is down" (S2 door 4)
// use the probe; every other caller keeps the plain string via mcpCall.
async function mcpCallProbe(tool, argumentsJson) {
  const url = setting("url");
  const token = setting("token");
  if (!url || !token) return { reachable: false, raw: "" };

  const body = `{"jsonrpc":"2.0","id":"overclick-hook","method":"tools/call","params":{"name":${JSON.stringify(
    tool,
  )},"arguments":${argumentsJson}}}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return { reachable: false, raw: "" };
    return { reachable: true, raw: await response.text() };
  } catch {
    return { reachable: false, raw: "" };
  }
}

// The board answers a JSON-RPC tools/call. Returns the raw body, or "" for any
// failure — every caller treats an empty answer as "the board said nothing".
export async function mcpCall(tool, argumentsJson) {
  return (await mcpCallProbe(tool, argumentsJson)).raw;
}

// `.result.structuredContent // (.result.content[0].text | fromjson)`
export function payloadOf(document) {
  const structured = document?.result?.structuredContent;
  if (structured) return structured;
  return JSON.parse(document?.result?.content?.[0]?.text ?? "{}");
}

// Returns the rendered lines, or null when the answer is not the expected JSON.
export function renderBoard(rawResponse, heading) {
  const document = parseJson(rawResponse);
  if (!document) return null;
  let payload;
  try {
    payload = payloadOf(document);
  } catch {
    return null;
  }
  const tasks = payload?.tasks ?? [];
  const lines = [heading];
  if (!tasks.length) lines.push("- none");
  for (const task of tasks) {
    lines.push(`- ${task.short_id ?? "?"}: ${task.title ?? "Untitled"} [${task.status ?? "?"}]`);
  }
  if (payload?.truncated) lines.push("- more cards omitted");
  return lines;
}

// Returns 0 when the answer cannot be read, matching the shell `|| printf '0'`.
export function countTasks(rawResponse) {
  const document = parseJson(rawResponse);
  if (!document) return 0;
  try {
    return (payloadOf(document).tasks ?? []).length;
  } catch {
    return 0;
  }
}

export function hookTool(hookInput) {
  return hookInput?.tool_name ?? hookInput?.toolName ?? "";
}

export function hookCwd(hookInput) {
  return hookInput?.cwd ?? hookInput?.working_directory ?? hookInput?.workingDirectory ?? "";
}

export function hookSession(hookInput) {
  return hookInput?.session_id ?? hookInput?.sessionId ?? "";
}

/** Never infer session ownership from a token shared by several panes. */
export async function sessionClaims(hookInput, limit) {
  const sessionId = hookSession(hookInput);
  if (!sessionId) return "";
  return mcpCall("task_list", JSON.stringify({
    status: "em_execucao", claimed_by: "me", session_id: sessionId, limit,
  }));
}

// Same call as sessionClaims, but reports whether the board answered at all
// (S2 door 4 / AC 20-21): a hook that cannot tell "board is down" from
// "board said no claims" cannot narrate the difference to the operator, and
// cannot single out the narrow board-down recovery surface from an ordinary
// missing claim.
export async function sessionClaimsProbe(hookInput, limit) {
  const sessionId = hookSession(hookInput);
  if (!sessionId) return { reachable: false, raw: "" };
  return mcpCallProbe("task_list", JSON.stringify({
    status: "em_execucao", claimed_by: "me", session_id: sessionId, limit,
  }));
}

// The directory `install.sh` clones/updates ustoppble/overclick into — the
// board's own source checkout, never the plugin copy a CLI executes hooks
// from. AC 21's `docker compose ps|up|restart` recovery is scoped to this
// directory specifically so the guard cannot be widened into "any compose
// project" by a command that merely happens to run from somewhere else.
export function installDir() {
  if (process.env.OVERCLICK_INSTALL_DIR) return process.env.OVERCLICK_INSTALL_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "overclick", "plugin-src");
}

export function isOverclickInstallDir(cwd) {
  if (!cwd) return false;
  const root = path.resolve(installDir());
  const here = path.resolve(cwd);
  return here === root || here.startsWith(root + path.sep);
}

// Every key a harness has been seen carrying a shell command under. A shell
// tool whose command hides under some other key reads as empty here, and an
// empty command is not proven read-only — so it blocks (OCL-134).
export function hookCommand(hookInput) {
  const input = hookInput?.tool_input ?? {};
  for (const key of ["command", "cmd", "commandLine", "command_line", "script", "shell_command", "powershell"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return "";
}

// A tool nobody knows, carrying a file body: a write however it is named.
export function writeShapedInput(hookInput) {
  const input = hookInput?.tool_input ?? {};
  if (!input || typeof input !== "object") return false;
  const keys = Object.keys(input);
  if (keys.some((key) => /^(patch|diff|edits|new_string|new_str|new_source|replacement)$/i.test(key))) return true;
  const hasBody = keys.some((key) => /^(content|contents|text|data|body|value)$/i.test(key));
  const hasTarget = keys.some((key) => /^(path|file_path|filePath|file|filename|target|destination)$/i.test(key));
  return hasBody && hasTarget;
}

// The marker the claim guard trusts later. Null whenever the claim did not
// actually take the card: an errored response, a missing id, a status other
// than em_execucao.
export function claimMarker(hookInput, fallbackClaimedAt) {
  const response =
    hookInput?.tool_response ??
    hookInput?.toolResponse ??
    hookInput?.tool_result ??
    hookInput?.toolResult ??
    {};
  const result = response.result ?? {};
  let payload = response.structuredContent ?? result.structuredContent;
  if (!payload) {
    try {
      payload = JSON.parse((response.content ?? result.content ?? [])[0]?.text ?? "{}");
    } catch {
      payload = {};
    }
  }
  const task = payload.task ?? {};
  const attempt = payload.attempt ?? {};
  const input = hookInput?.tool_input ?? {};
  const taskId = task.short_id ?? task.id ?? input.task_id ?? input.id ?? "";
  const claimedAt = attempt.started_at ?? attempt.startedAt ?? fallbackClaimedAt ?? "";
  const isError = Boolean(response.isError ?? result.isError ?? false);
  if (!taskId || !claimedAt || isError) return null;
  if ((task.status ?? "em_execucao") !== "em_execucao") return null;
  return {
    task_id: taskId,
    claimed_at: claimedAt,
    session_id: hookSession(hookInput),
  };
}

export function markerValid(marker, expectedSession) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  if (typeof marker.task_id !== "string" || !marker.task_id.length) return false;
  if (typeof marker.claimed_at !== "string" || !marker.claimed_at.length) return false;
  const markerSession = marker.session_id ?? "";
  if (markerSession && expectedSession && markerSession !== expectedSession) return false;
  return true;
}

export function block(reason) {
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

// SNP-84: the marker used to be one file per cwd (`.overclick/claim.json`),
// with no notion of which pane wrote it. Several panes share the same
// primary cwd (squad convention: visit worktrees via `git -C`/subshell,
// never a persistent `cd`), so every task_claim/task_deliver/task_release
// from ANY of them overwrote the one shared file — last write wins, no
// lock, no merge (see common.mjs history / SNP-84 for the measured
// collision). That pushed most traffic onto the recovery path
// (`sessionClaims`) instead of the fast local check it exists to skip.
// Scoping the filename by session id gives each pane its own marker at the
// same cwd, so siblings stop colliding. A session id is present on every
// caller this file has (Claude Code's real hookInput.session_id, and
// Antigravity's conversationId — see antigravity.sh's `oc_agy_normalize`);
// the "shared" fallback below only covers a hookInput with no session id at
// all, which is the same blind spot the old single-file scheme always had,
// never a regression from it.
function claimFileSlug(sessionId) {
  if (!sessionId || !sessionId.length) return "shared";
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function claimFile(root, sessionId) {
  const base = root && root.length ? root : process.cwd();
  return path.join(base, ".overclick", `claim-${claimFileSlug(sessionId)}.json`);
}

export function writeClaimMarker(root, marker) {
  const file = claimFile(root, marker?.session_id);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.claim.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function clearClaimMarker(root, sessionId) {
  fs.rmSync(claimFile(root, sessionId), { force: true });
}

export function claimMarkerValid(root, expectedSession) {
  let raw;
  try {
    raw = fs.readFileSync(claimFile(root, expectedSession), "utf8");
  } catch {
    return false;
  }
  return markerValid(parseJson(raw), expectedSession);
}

// ---------------------------------------------------------------------------
// Shell command classification (OCL-134).
//
// The old rule asked "does this command LOOK like a write?" and let everything
// else run. That fails OPEN for every dialect the regex does not speak: on
// Windows the shell tool is called `PowerShell`, and
// `[System.IO.File]::WriteAllText(...)` does not look like a write to a POSIX
// regex — the reporter of issue #72 rewrote their own config that way with the
// guard turned on. A guard that silently stops blocking is worse than no guard,
// so the question is inverted: a command runs unclaimed only when it is
// PROVABLY read-only. Unknown verb, unknown dialect, unreadable input — all
// mutations as far as the guard is concerned.

// Separators are honoured outside quotes only, so `grep 'a|b' file` stays one
// segment instead of splitting into a bogus `b' file` command.
function shellSegments(command) {
  const segments = [];
  let current = "";
  let quote = "";
  for (const character of command) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";" || character === "|" || character === "&" || character === "\n" || character === "\r") {
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

// Anything that can smuggle a second command past the verb allowlist. Checked
// against the raw command, quotes included: a read-only `grep '>'` blocked by
// this is a false alarm the operator can fix with a claim, while the reverse
// mistake is the bug this card exists to close.
const EVALUATION_TRAPS = [
  /\$\(/, // POSIX command substitution
  /`/, // POSIX backtick substitution
  /<\(/, // process substitution
  /\$\{[^}]*[;|&]/, // parameter expansion hiding a command
  /\[\s*(System|IO|Microsoft)\./i, // .NET type literal: [System.IO.File]::...
  /::\s*[A-Za-z_]\w*\s*\(/, // any .NET static call
  /(^|[\s;|&(])(eval|exec|source|iex|Invoke-Expression|Invoke-Command|Start-Process|Start-Job|xargs|env|sudo|doas|nohup|setsid|Set-Alias|New-Alias)([\s;|&)]|$)/i,
];

// Verbs that cannot mutate anything on their own. A head not listed here is not
// "probably fine" — it is unproven, which now means blocked.
const READ_ONLY_HEADS = new Set([
  // POSIX / GNU
  "ls", "ll", "cat", "bat", "head", "tail", "less", "more", "echo", "printf",
  "pwd", "cd", "wc", "grep", "egrep", "fgrep", "rg", "ack", "file", "stat",
  "du", "df", "tree", "which", "whereis", "whoami", "id", "hostname", "uname",
  "date", "printenv", "basename", "dirname", "realpath", "readlink", "sort",
  "uniq", "cut", "tr", "diff", "comm", "cmp", "column", "fold", "nl", "od",
  "xxd", "strings", "md5sum", "sha1sum", "sha256sum", "shasum", "jq", "yq",
  "true", "false", "test", "sleep", "man", "help", "history", "ps", "top",
  // `find` and `sed` mutate only through the flags HEAD_ARGUMENT_TRAPS
  // catches above (-exec/-delete/... and -i/w respectively), so the head
  // itself is read-only (S2 / AC 15).
  "find", "sed",
  // Windows cmd
  "dir", "type", "where", "findstr", "ver", "systeminfo", "tasklist",
]);

// PowerShell verbs are open-ended, so the allowlist is the cmdlet name itself.
// Get-* is safe as a family; ForEach-Object and Where-Object are NOT, because a
// script block carries arbitrary code the allowlist never sees.
const READ_ONLY_CMDLETS =
  /^(Get-[A-Za-z]+|Test-Path|Test-Connection|Resolve-Path|Split-Path|Join-Path|Select-String|Select-Object|Sort-Object|Group-Object|Measure-Object|Compare-Object|Format-(List|Table|Wide|Custom)|Out-(String|Host|GridView)|Write-(Host|Output)|ConvertTo-(Json|Csv|Xml)|ConvertFrom-(Json|Csv|Xml|StringData)|Show-Command)$/i;

// Subcommand-shaped tools: the head alone proves nothing.
const READ_ONLY_SUBCOMMANDS = {
  // `git` decides through gitReadOnly() instead (its subcommand can hide
  // behind `-C <dir>` and some, like `branch`, are read-only only with
  // certain arguments) — this map stays for the other subcommand-shaped tools.
  gh: new Set(["pr", "issue", "repo", "run", "api"]),
  // `docker logs` is here rather than in HEAD_ARGUMENT_TRAPS because it is
  // read-only by default and only its `-f`/`--follow` form is trapped above.
  docker: new Set(["ps", "inspect", "logs"]),
};

// Read-only heads that stop being read-only with the wrong flag.
const HEAD_ARGUMENT_TRAPS = {
  find: /(^|\s)-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fprint0)\b/,
  // A sed `w` command is usually glued to its address with no space
  // (`1w file`, `$w file`, `s/a/b/w file`) — the address itself is often a
  // digit, so the trap excludes only a preceding letter/underscore (which
  // would make it part of a word like "new" or "raw"), not a digit.
  sed: /(^|\s)-\S*i|(^|[^A-Za-z_])w\s+\S/,
  sort: /(^|\s)-o(\s|$)/,
  grep: /(^|\s)-\S*[of]\s|--output/,
  rg: /(^|\s)--files-with-matches\s*>|(^|\s)-r\b|--replace/,
  gh: /(^|\s)(create|edit|delete|close|merge|comment|clone|sync|rerun|cancel)\b|-X\s*(POST|PUT|PATCH|DELETE)/i,
  // `docker logs -f`/`--follow` never returns, so it is treated the same as a
  // mutation: a command this hook cannot observe finishing is not proven safe.
  docker: /(^|\s)logs\b[^;&|]*\s(-f\b|--follow\b)/,
};

// Heads that are read-only only with a specific flag present (S2 / AC 15):
// `unzip -l`/`-p` list or print; any other invocation can extract to disk.
const READ_ONLY_FLAG_HEADS = {
  unzip: /(^|\s)-l(\s|$)|(^|\s)-p(\s|$)/,
};

// `git` read subcommands whose safety never depends on their arguments.
const GIT_SIMPLE_READ_SUBCOMMANDS = new Set([
  "log", "status", "show", "blame", "describe", "shortlog",
  "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "cat-file",
  "name-rev", "whatchanged", "grep", "count-objects",
]);

// `git branch` with no argument, or only a listing flag, reads; `-d/-D` (delete),
// `-m/-M` (rename) and `-c/-C` (copy) mutate (AC 19) and are deliberately absent.
const GIT_BRANCH_READ_ARGS = new Set(["--list", "-a", "-r", "-v", "--show-current"]);

// A quoted argument (`git -C "dir with spaces" log`) must stay one token, so
// both `git -C <dir>` and the tlc validator path are read through a small
// quote-aware tokenizer rather than a `.split(/\s+/)`.
function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = "";
  let inToken = false;
  for (const character of segment) {
    if (quote) {
      if (character === quote) {
        quote = "";
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inToken = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += character;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

// `git -C <dir> <verb>` hides the subcommand behind a flag whose argument can
// itself contain spaces, so this reads the tokens instead of a fixed index.
function gitReadOnly(segment) {
  const tokens = tokenize(segment);
  let index = 1;
  if (tokens[index] === "-C") index += 2;
  const subcommand = tokens[index] ?? "";
  const rest = tokens.slice(index + 1);

  if (subcommand === "diff") {
    return !rest.some((token) => token === "--output" || token.startsWith("--output="));
  }
  if (subcommand === "branch") {
    return rest.length === 0 || rest.every((token) => GIT_BRANCH_READ_ARGS.has(token));
  }
  if (subcommand === "worktree") {
    return rest.length === 1 && rest[0] === "list";
  }
  return GIT_SIMPLE_READ_SUBCOMMANDS.has(subcommand);
}

// The four tlc-spec-lean validators (S2 / AC 17) — the only python invocation
// this hook ever allows without a claim, and only by exact script name so a
// path that merely contains the word "scripts" does not slip through.
const TLC_VALIDATOR_SCRIPT =
  /[\\/]scripts[\\/](validate_plan|validate_checks|validate_verification|selftest)\.py$/;

function pythonReadOnly(segment) {
  const tokens = tokenize(segment);
  const scriptPath = tokens[1] ?? "";
  return TLC_VALIDATOR_SCRIPT.test(scriptPath);
}

function segmentHead(segment) {
  const head = segment.split(/\s+/)[0] ?? "";
  // `FOO=bar cmd`, `(cmd`, `$cmd`, `./script` — none of them prove anything.
  if (!head || /[=$(){}]/.test(head)) return "";
  return head.replace(/^\.\//, "");
}

function segmentReadOnly(segment) {
  const head = segmentHead(segment);
  if (!head) return false;

  // `git` and the tlc validators decide on their full shape, not the head
  // alone, so they branch before the generic trap/subcommand/head checks.
  if (head === "git") return gitReadOnly(segment);
  if (head === "python3" || head === "python") return pythonReadOnly(segment);

  const trap = HEAD_ARGUMENT_TRAPS[head];
  if (trap && trap.test(segment)) return false;

  const flagGate = READ_ONLY_FLAG_HEADS[head];
  if (flagGate) return flagGate.test(segment);

  const subcommands = READ_ONLY_SUBCOMMANDS[head];
  if (subcommands) {
    const argument = segment.split(/\s+/)[1] ?? "";
    // `git -C other-repo commit` hides the subcommand behind a flag.
    return subcommands.has(argument);
  }

  if (READ_ONLY_HEADS.has(head)) return true;
  if (READ_ONLY_HEADS.has(head.toLowerCase())) return true;
  return READ_ONLY_CMDLETS.test(head);
}

// Output-only discards are not writes: `2>/dev/null`, `>/dev/null`, `2>&1`.
function withoutDiscards(command) {
  return command
    .replace(/[0-9]*>>?\s*(\/dev\/null|\$null|NUL)\b/gi, "")
    .replace(/[0-9]*>&[0-9]+/g, "");
}

const REDIRECTION = /(^|[^<>0-9])>{1,2}\s*[^&\s]/;

// The whole point of the card: proof, not vibes. Everything that is not proven
// read-only is treated as a mutation by the callers of this function.
export function commandReadOnly(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (EVALUATION_TRAPS.some((trap) => trap.test(command))) return false;
  const stripped = withoutDiscards(command);
  if (REDIRECTION.test(stripped)) return false;
  const segments = shellSegments(stripped);
  if (!segments.length) return false;
  return segments.every(segmentReadOnly);
}

// Kept as a second, independent opinion. commandReadOnly already blocks
// everything below, but an accidental widening of the read allowlist would
// still have to get past this list to relax POSIX enforcement, which OCL-134
// explicitly forbids. It also speaks the PowerShell dialect now.
const WRITE_COMMANDS = new RegExp(
  "(^|[;&|()\\s])(apply_patch|touch|mkdir|rmdir|rm|mv|cp|install|ln|chmod|chown|truncate|dd|tee)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(sed\\s+(-[^\\s]*)?i|perl\\s+-[^\\s]*i)" +
    // `branch` and `worktree` are judged by gitReadOnly() instead (S2 / AC 16,
    // AC 19): both have a read-only shape (`branch` with no argument or a
    // listing flag, `worktree list`) alongside a mutating one, so neither can
    // be an unconditional write verb here without also blocking the read shape.
    "|(^|[;&|()\\s])git\\s+(add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|revert|rm|stash|switch|tag)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(npm|pnpm|yarn|bun)\\s+(add|install|remove|uninstall|update|upgrade|link|unlink|publish)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(bash|sh|zsh|python3?|node)\\s+[^;&|]*([.]sh|-[cm])[;&|\\s]*" +
    // PowerShell cmdlets, cmd.exe verbs, and .NET file APIs (issue #72).
    "|(^|[;&|()\\s])(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Acl|Export-Csv|Export-Clixml|Tee-Object|Start-Process|Invoke-Expression|New-Object|del|erase|ren|rename|move|copy|xcopy|robocopy|attrib|icacls|fsutil)([;&|()\\s]|$)" +
    "|\\[\\s*(System\\.)?(IO\\.)?(File|Directory|FileInfo|DirectoryInfo|StreamWriter)\\s*\\]\\s*::" +
    "|::\\s*(Write|Create|Delete|Move|Copy|Append|Replace|SetAttributes)[A-Za-z]*\\s*\\(",
  "i",
);

// A feature slug can legally contain "-c" or "-m" (`some-cool-feature`), which
// the generic `python3 ... -c|-m` write heuristic below would otherwise trip
// on for a validator call such as `python3 .../validate_checks.py some-cool-
// feature` — the exact shape AC 17 requires passing regardless of its argument.
function tlcValidatorInvocation(command) {
  const tokens = tokenize(command.trim());
  const head = tokens[0] ?? "";
  if (head !== "python3" && head !== "python") return false;
  return TLC_VALIDATOR_SCRIPT.test(tokens[1] ?? "");
}

export function commandWrites(command) {
  if (!command) return false;
  if (tlcValidatorInvocation(command)) return false;
  const stripped = withoutDiscards(command);
  if (REDIRECTION.test(stripped)) return true;
  return WRITE_COMMANDS.test(command);
}

// A hook that throws is a hook that fails closed on the wrong side: Claude Code
// prints the stack trace and the guard decision is lost. Every entrypoint wraps
// its body with this.
export function failOpen(main) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
