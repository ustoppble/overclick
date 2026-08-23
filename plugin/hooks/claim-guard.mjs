import {
  bashWrites,
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

  switch (toolName) {
    case "Edit":
    case "Write":
    case "edit":
    case "write":
      break;
    case "Bash":
    case "bash":
      if (!bashWrites(hookCommand(hookInput))) return;
      break;
    default:
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
