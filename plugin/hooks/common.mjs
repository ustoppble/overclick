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

// The board answers a JSON-RPC tools/call. Returns the raw body, or "" for any
// failure — every caller treats an empty answer as "the board said nothing".
export async function mcpCall(tool, argumentsJson) {
  const url = setting("url");
  const token = setting("token");
  if (!url || !token) return "";

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
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

// `.result.structuredContent // (.result.content[0].text | fromjson)`
export function payloadOf(document) {
  const structured = document?.result?.structuredContent;
  if (structured) return structured;
  return JSON.parse(document?.result?.content?.[0]?.text ?? "{}");
}

function harnessSignature(harness) {
  return ["cli", "model", "effort"].map((key) => harness?.[key] ?? "").join("|");
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

export function hookHarness(hookInput) {
  return harnessSignature(hookInput?.tool_input?.harness);
}

export function recommendationHarness(rawResponse) {
  const document = parseJson(rawResponse);
  if (!document) return "";
  try {
    return harnessSignature(payloadOf(document).harness);
  } catch {
    return "";
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

export function claimFile(root) {
  const base = root && root.length ? root : process.cwd();
  return path.join(base, ".overclick", "claim.json");
}

export function writeClaimMarker(root, marker) {
  const file = claimFile(root);
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

export function clearClaimMarker(root) {
  fs.rmSync(claimFile(root), { force: true });
}

export function claimMarkerValid(root, expectedSession) {
  let raw;
  try {
    raw = fs.readFileSync(claimFile(root), "utf8");
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
  git: new Set([
    "status", "log", "diff", "show", "blame", "describe", "shortlog",
    "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "cat-file",
    "name-rev", "symbolic-ref", "whatchanged", "grep", "count-objects",
  ]),
  gh: new Set(["pr", "issue", "repo", "run", "api"]),
};

// Read-only heads that stop being read-only with the wrong flag.
const HEAD_ARGUMENT_TRAPS = {
  find: /(^|\s)-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fprint0)\b/,
  sed: /(^|\s)-\S*i|(^|\s)w\s|\bw\s+\S/,
  grep: /(^|\s)-\S*[of]\s|--output/,
  rg: /(^|\s)--files-with-matches\s*>|(^|\s)-r\b|--replace/,
  gh: /(^|\s)(create|edit|delete|close|merge|comment|clone|sync|rerun|cancel)\b|-X\s*(POST|PUT|PATCH|DELETE)/i,
};

function segmentHead(segment) {
  const head = segment.split(/\s+/)[0] ?? "";
  // `FOO=bar cmd`, `(cmd`, `$cmd`, `./script` — none of them prove anything.
  if (!head || /[=$(){}]/.test(head)) return "";
  return head.replace(/^\.\//, "");
}

function segmentReadOnly(segment) {
  const head = segmentHead(segment);
  if (!head) return false;

  const trap = HEAD_ARGUMENT_TRAPS[head];
  if (trap && trap.test(segment)) return false;

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
    "|(^|[;&|()\\s])git\\s+(add|am|apply|branch|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|revert|rm|stash|switch|tag|worktree)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(npm|pnpm|yarn|bun)\\s+(add|install|remove|uninstall|update|upgrade|link|unlink|publish)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(bash|sh|zsh|python3?|node)\\s+[^;&|]*([.]sh|-[cm])[;&|\\s]*" +
    // PowerShell cmdlets, cmd.exe verbs, and .NET file APIs (issue #72).
    "|(^|[;&|()\\s])(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Acl|Export-Csv|Export-Clixml|Tee-Object|Start-Process|Invoke-Expression|New-Object|del|erase|ren|rename|move|copy|xcopy|robocopy|attrib|icacls|fsutil)([;&|()\\s]|$)" +
    "|\\[\\s*(System\\.)?(IO\\.)?(File|Directory|FileInfo|DirectoryInfo|StreamWriter)\\s*\\]\\s*::" +
    "|::\\s*(Write|Create|Delete|Move|Copy|Append|Replace|SetAttributes)[A-Za-z]*\\s*\\(",
  "i",
);

export function commandWrites(command) {
  if (!command) return false;
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
