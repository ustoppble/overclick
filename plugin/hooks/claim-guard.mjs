import {
  block,
  claimFile,
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
  isOverclickInstallDir,
  sessionClaimsProbe,
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

// S2 door 4 / AC 18: a Write or Edit landing here needs no claim — the spec
// preparation flow (tlc-spec-lean) writes and publishes without one by
// design. Anything else a WRITE_TOOL targets still needs a claim.
const PLANNING_WRITE_PATH = /(^|[\\/])\.specs[\\/]|(^|[\\/])docs[\\/]plano[\\/]aprovacoes[\\/]/;

// AC 21: while the board is unreachable, only this exact recovery shape is
// exempt — the command that restarts the board itself, and only inside the
// board's own install directory. Nothing wider: a compose project of some
// other kind is an ordinary mutation.
const DOCKER_COMPOSE_RECOVERY = /^docker\s+compose\s+(ps|up|restart)(\s|$)/;

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
    clearClaimMarker(cwd, hookSession(hookInput));
    return;
  }

  if (!enabled("enforce_claim")) return;

  // OCL-134 / issue #72. The old switch ended in `default: return`, so a shell
  // tool that was not literally called `Bash` — `PowerShell` on Windows — was
  // waved through and mutated the repo with no claim. The default is inverted
  // here: only what is PROVEN not to mutate returns early.
  if (!mutationSuspected(hookInput, toolName)) return;

  const session = hookSession(hookInput);
  if (claimMarkerValid(cwd, session)) return;

  // A missing marker can be recovered only from this session's claim — but
  // only when the board actually answered. AC 20-21: when it did not, the
  // recovery path is a fixed, narrow surface, never "assume no claims".
  const probe = await sessionClaimsProbe(hookInput, 2);
  if (probe.reachable) {
    if (countTasks(probe.raw) > 0) return;
    block("claima um card no board antes: task_claim {id}");
    return;
  }

  if (boardUnreachableRecoveryAllowed(hookInput, cwd)) return;

  block(
    `board inacessível e nenhum marcador de claim local em ${claimFile(cwd, session)}; ` +
      "religue o board (ou restaure o marcador) antes de mutar",
  );
});

function boardUnreachableRecoveryAllowed(hookInput, cwd) {
  const command = hookCommand(hookInput);
  if (!command) return false;
  if (!DOCKER_COMPOSE_RECOVERY.test(command.trim())) return false;
  return isOverclickInstallDir(cwd);
}

function mutationSuspected(hookInput, toolName) {
  if (BOARD_TOOL.test(toolName)) return false;
  if (WRITE_TOOL.test(toolName)) return !planningWritePath(hookInput);

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

function planningWritePath(hookInput) {
  const input = hookInput?.tool_input ?? {};
  const candidates = [
    input.path, input.file_path, input.filePath, input.file,
    input.target, input.destination, input.notebook_path,
  ];
  return candidates.some(
    (candidate) => typeof candidate === "string" && PLANNING_WRITE_PATH.test(candidate),
  );
}
