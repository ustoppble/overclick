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

export function hookCommand(hookInput) {
  return hookInput?.tool_input?.command ?? hookInput?.tool_input?.cmd ?? "";
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

// Ports the two shell greps verbatim: first any redirection that is not an
// output-only discard, then the write-shaped command vocabulary.
const REDIRECTION = /(^|[^<])>{1,2}\s*[^&]/;
const WRITE_COMMANDS = new RegExp(
  "(^|[;&|()\\s])(apply_patch|touch|mkdir|rmdir|rm|mv|cp|install|ln|chmod|chown|truncate|dd|tee)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(sed\\s+(-[^\\s]*)?i|perl\\s+-[^\\s]*i)" +
    "|(^|[;&|()\\s])git\\s+(add|am|apply|branch|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|revert|rm|stash|switch|tag|worktree)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(npm|pnpm|yarn|bun)\\s+(add|install|remove|uninstall|update|upgrade|link|unlink|publish)([;&|()\\s]|$)" +
    "|(^|[;&|()\\s])(bash|sh|zsh|python3?|node)\\s+[^;&|]*([.]sh|-[cm])[;&|\\s]*",
  "i",
);

export function bashWrites(command) {
  if (!command) return false;
  const withoutDiscards = command
    .replace(/[0-9]*>>?\s*\/dev\/null/g, "")
    .replace(/[0-9]*>&[0-9]+/g, "");
  if (REDIRECTION.test(withoutDiscards)) return true;
  return WRITE_COMMANDS.test(command);
}

// The same question in the other dialect. WRITE_COMMANDS still applies -- git,
// npm and the coreutils aliases (rm, mv, cp, mkdir) are all real in PowerShell
// -- so this only adds what is native to it: the *-Item / *-Content verbs and
// the .NET file APIs, which no amount of coreutils vocabulary would catch.
const PS_WRITE_COMMANDS = new RegExp(
  "(^|[;&|(){}\\s])(" +
    "Set-Content|Add-Content|Clear-Content|Out-File|Tee-Object|" +
    "New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|" +
    "New-ItemProperty|Set-ItemProperty|Remove-ItemProperty|Rename-ItemProperty|" +
    "Export-Csv|Export-Clixml|Export-ModuleMember|Set-Acl|" +
    "New-Item[A-Za-z]*|Write-EventLog" +
    ")([;&|(){}\\s]|$)" +
    // Invoke-WebRequest is a read until -OutFile turns it into a download.
    "|(^|[;&|(){}\\s])(Invoke-WebRequest|Invoke-RestMethod|curl|wget)\\b[^;&|]*-OutFile" +
    // [System.IO.File]::WriteAllText(...) and friends, short form included.
    "|\\[\\s*(System\\.)?IO\\.(File|Directory|FileInfo|DirectoryInfo)\\s*\\]\\s*::" +
    "\\s*(Write|Append|Create|Delete|Move|Copy|Replace|Encrypt|Decrypt|SetAttributes)",
  "i",
);

export function powershellWrites(command) {
  if (!command) return false;
  // PowerShell discards to $null, not /dev/null, and `2>&1` is a merge rather
  // than a write. Strip both before asking about redirection.
  const withoutDiscards = command
    .replace(/[0-9]*>>?\s*\$null/gi, "")
    .replace(/[0-9]*>&[0-9]+/g, "");
  if (REDIRECTION.test(withoutDiscards)) return true;
  if (PS_WRITE_COMMANDS.test(command)) return true;
  return WRITE_COMMANDS.test(command);
}

// Which dialect to ask. An unknown shell tool is NOT assumed harmless: the
// vocabulary check is a heuristic either way, so the wider of the two runs.
// This is still an allowlist by tool name -- see SHELL_TOOLS in claim-guard.
export function shellWrites(toolName, command) {
  return /^bash$/i.test(toolName ?? "")
    ? bashWrites(command)
    : powershellWrites(command);
}

// A hook that throws is a hook that fails closed on the wrong side: Claude Code
// prints the stack trace and the guard decision is lost. Every entrypoint wraps
// its body with this.
export function failOpen(main) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
