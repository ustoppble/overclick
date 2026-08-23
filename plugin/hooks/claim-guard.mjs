import {
  shellWrites,
  block,
  claimMarker,
  claimMarkerValid,
  clearClaimMarker,
  countTasks,
  enabled,
  hookCommand,
  hookCwd,
  hookSession,
  hookTool,
  mcpCall,
  parseJson,
  readStdin,
  writeClaimMarker,
  failOpen,
} from "./common.mjs";

const CLAIM = /^(mcp__.*__)?task_claim$/;
const RELEASE = /^(mcp__.*__)?(task_deliver|task_release)$/;

// The tools that edit a file outright, and the ones that hand a command to a
// shell. Both lists are mirrored by the PreToolUse matcher in hooks.json: a
// name missing there means this file never runs at all.
//
// Windows was the hole. Claude Code names its shell tool `PowerShell` there,
// `Edit|Write|Bash` did not match it, and the guard silently covered nothing on
// the shell side -- `git commit` without a claim went straight through, which
// is exactly what the OCL-37 incident is about.
const FILE_TOOLS = /^(Edit|Write|NotebookEdit|edit|write|write_to_file|replace_file_content|edit_notebook)$/;
const SHELL_TOOLS = /^(Bash|bash|PowerShell|pwsh|Shell|shell|Terminal|run_command|execute_command)$/;

failOpen(async () => {
  const hookInput = parseJson(readStdin()) ?? {};
  const toolName = hookTool(hookInput);
  const cwd = hookCwd(hookInput) || process.cwd();

  if (CLAIM.test(toolName)) {
    const claimedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const marker = claimMarker(hookInput, claimedAt);
    if (marker) writeClaimMarker(cwd, marker);
    return;
  }

  if (RELEASE.test(toolName)) {
    clearClaimMarker(cwd);
    return;
  }

  if (!enabled("enforce_claim")) return;

  if (SHELL_TOOLS.test(toolName)) {
    if (!shellWrites(toolName, hookCommand(hookInput))) return;
  } else if (!FILE_TOOLS.test(toolName)) {
    return;
  }

  if (claimMarkerValid(cwd, hookSession(hookInput))) return;

  // No local marker: the board is still the source of truth, so a claim taken
  // in another session or before the marker existed keeps working.
  const claims = await mcpCall(
    "task_list",
    '{"status":"em_execucao","claimed_by":"me","limit":2}',
  );
  if (claims && countTasks(claims) > 0) return;

  block("claima um card no board antes: task_claim {id}");
});
