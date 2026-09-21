import type { McpToolName } from "@agent-board/mcp-core";
import { invokeTool as invokeMcpTool } from "./tools";
import type { AuthContext, McpDatabase } from "./types";

/**
 * Existing integration scenarios inspect the complete object after a write.
 * Keep those scenarios explicit about that legacy-shaped assertion while the
 * production default remains the compact acknowledgement.
 */
const FULL_RESPONSE_WRITES = new Set<McpToolName>([
  "project_update",
  "mission_update",
  "task_create",
  // task_claim answers compact by default (OCL-183); the scenarios written
  // against the markdown briefing ask for it explicitly.
  "task_claim",
  "task_release",
  "task_heartbeat",
  "task_update",
  "task_deliver",
  "harness_set",
  "executors_update",
]);

export function invokeToolForTests(
  db: McpDatabase,
  ctx: AuthContext,
  name: McpToolName,
  args: unknown,
): ReturnType<typeof invokeMcpTool> {
  if (
    FULL_RESPONSE_WRITES.has(name) &&
    args &&
    typeof args === "object" &&
    !("return" in args)
  ) {
    args = { ...(args as Record<string, unknown>), return: "full" };
  }
  return invokeMcpTool(db, ctx, name, args);
}
