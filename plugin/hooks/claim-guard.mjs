import {
  block,
  claimMarker,
  claimMarkerValid,
  clearClaimMarker,
  commandReadOnly,
  commandWrites,
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
  writeShapedInput,
  failOpen,
} from "./common.mjs";

const CLAIM = /^(mcp__.*__)?task_claim$/;
const RELEASE = /^(mcp__.*__)?(task_deliver|task_release)$/;

// Reading and writing the board is how an agent GETS a claim, so gating it
// would deadlock the workflow the guard exists to enforce. These tools never
// touch the working tree.
const BOARD_TOOL =
  /^(mcp__.*__)?(task_|mission_|project_|harness_|insights_|executors_|branch_register|context_ops|objective_ops)/;

// Editors: gated on the TOOL, which is exact — no command text to interpret.
const WRITE_TOOL =
  /^(edit|multiedit|write|notebookedit|str_replace_editor|apply_patch|create_file|update_file|write_file|delete_file|move_file)$/i;

// Investigation tools, allowed by name so the common path costs nothing.
const READ_TOOL =
  /^(read|view|glob|grep|ls|notebookread|todowrite|todoread|task|agent|webfetch|websearch|exitplanmode)$/i;

// A shell by any name. Used only as a floor: if a tool that looks like a shell
// arrives with no command the guard can read, it is not proven read-only.
const SHELL_TOOL =
  /(^|[_.-])(bash|sh|zsh|fish|shell|powershell|pwsh|cmd|terminal|console|command|run_command|execute_command|exec_command|run_shell|local_shell|process|exec|run)([_.-]|$)/i;

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

  // OCL-134 / issue #72. The old switch ended in `default: return`, so a shell
  // tool that was not literally called `Bash` — `PowerShell` on Windows — was
  // waved through and mutated the repo with no claim. The default is inverted
  // here: only what is PROVEN not to mutate returns early.
  if (!mutationSuspected(hookInput, toolName)) return;

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

function mutationSuspected(hookInput, toolName) {
  if (BOARD_TOOL.test(toolName)) return false;
  if (WRITE_TOOL.test(toolName)) return true;

  // Whatever the tool is called, a command is judged on its own merits: proven
  // read-only passes, everything else — unknown verb, unknown dialect,
  // [System.IO.File]::WriteAllText — is a mutation.
  const command = hookCommand(hookInput);
  if (command) return commandWrites(command) || !commandReadOnly(command);

  if (SHELL_TOOL.test(toolName)) return true;
  if (READ_TOOL.test(toolName)) return false;
  if (writeShapedInput(hookInput)) return true;

  // The documented limit of the fail-closed rule: a tool with neither a command
  // nor a file body is not evidence of a mutation, and gating every MCP call
  // would block the board itself. See plugin/OVERCLICK.md.
  return false;
}
