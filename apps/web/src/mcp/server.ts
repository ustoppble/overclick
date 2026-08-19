import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { project } from "@agent-board/db";
import {
  MCP_TOOL_NAMES,
  toolContracts,
  type McpToolName,
} from "@agent-board/mcp-core";
import { asc, eq } from "drizzle-orm";
import { invokeTool } from "./tools";
import type { AuthContext, McpDatabase } from "./types";

// The first sentence disambiguates the two products: field tests burned
// sessions with agents registering activities in Overclock instead of here.
export const SERVER_INSTRUCTIONS = [
  "OverClick is the task board where agents claim and deliver cards (not Overclock the IDE); registering activities means task_create here.",
  "",
  "Typical flow: task_list shows the queue, task_claim takes a card (send your executor: cli, exact session model from --model, session_id) and returns the briefing, and when the work is done you call task_deliver with summary, evidence, branch and usage. Without exact usage numbers, estimate and set estimated: true.",
  "If an executor must stop, task_release returns its card to the queue without deleting the attempt. Long runs may call task_heartbeat; an inactive claim expires at the workspace timeout and the next task_claim reports reclaimed_stale: true.",
  "Missions group cards: mission_create returns the id that task_create accepts. Every task_id argument accepts the card uuid or the workspace short id (for example AGB-5).",
  "Round-wide conventions belong in mission context: edit them with mission_update. Remove empty mission shells with mission_delete.",
  "Cards live in projects: project_list shows the projects of the workspace and project_create starts one. task_create takes the project uuid or its card prefix (for example AGB).",
  "Reorganizing is project_update to rename, project_delete to remove (empty by default), and task_update with project_id to move a card to another project, which restamps its short id and returns the old-to-new mapping.",
  "If an executor dies or reaches its model limit, create the continuation with task_create supersedes (and inherit: true when reusing the contract); never leave the old card in execution.",
].join("\n");

function contextExcerpt(context: string): string {
  const lines = context
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ");
  return lines.length > 240 ? `${lines.slice(0, 237)}...` : lines;
}

function instructionsWithProjects(
  projects: Array<{ name: string; idPrefix: string; context: string | null }>,
): string {
  const documented = projects.filter((row) => Boolean(row.context?.trim()));
  if (documented.length === 0) return SERVER_INSTRUCTIONS;
  return [
    SERVER_INSTRUCTIONS,
    "",
    "Project contexts available in this workspace:",
    ...documented.map(
      (row) =>
        `- ${row.name} (${row.idPrefix}): ${contextExcerpt(row.context ?? "")} Use project_get {project_id: "${row.idPrefix}"} for the complete project context.`,
    ),
  ].join("\n");
}

const DESCRIPTIONS: Record<McpToolName, string> = {
  project_list:
    "Lists the workspace projects with card prefix, repo url, has_context and card counts by status. Start here on a fresh board: task_create needs a project.",
  project_get:
    "Returns one complete project, including context markdown and current_version. Read it before changing the project.",
  project_create:
    "Creates a project (name, optional repo_url, context, current_version and id_prefix). Context is limited to 32000 characters. The card prefix is derived from the name when omitted and is unique per workspace.",
  project_update:
    "Updates a project (name, repo_url, context, current_version, id_prefix). Context is limited to 32000 characters. The card prefix is only editable while the project has no cards, because every card carries it in its short id: to reorganize a project that holds cards, move them with task_update passing project_id.",
  project_delete:
    "Hard delete: removes the project. Only an empty one by default; a project with cards comes back refused with the count that blocks it, and force: true destroys the project with every card in it, and their attempts, handoffs and subtasks. Irreversible.",
  mission_list:
    "Lists the workspace missions with the context carried by each one.",
  mission_get:
    "Returns the full mission (objective and context) to inject into the prompt.",
  mission_create:
    "Creates a mission in the workspace (title, objective and context in markdown, status). Pass the id it returns as task_create.mission.",
  mission_update:
    "Updates a mission in place (title, objective/context markdown, status). Omitted fields stay unchanged; conventions for one round belong in the mission context.",
  mission_delete:
    "Deletes an empty mission shell. A mission with cards is refused with its count unless force: true explicitly detaches those cards first.",
  task_list:
    "The card queue of the workspace. Filters: project, mission, status, priority, awaiting_review_by.",
  task_get:
    "The self-contained card: contract, harness, mission and branch convention, in markdown.",
  task_search:
    "Free-text search over the workspace's cards (title, what, why, comments), best match first. Filters: project_id (uuid or prefix), type, status (one or a list), limit (default 5, max 20). Each hit carries resolved_in, comments_count and reports_count, so you can tell whether a card already covers something before creating one. Empty list when nothing matches.",
  task_create:
    "Creates a card. The workspace comes from the token. mission is the id of an existing mission (mission_create, mission_list); omit it and the card stands on its own. mode is solo or team. supersedes atomically discards the card that was in execution, and inherit reuses its contract without carrying its comments over.",
  task_claim:
    "Takes the card (status becomes em_execucao), opens an ExecutionAttempt and returns the briefing. Codex must declare the exact model it was given in --model (gpt-5.6-sol, for example), never just gpt-5. A claim left without activity past the workspace timeout is abandoned as stale and can be taken over without force; the response marks reclaimed_stale: true.",
  task_release:
    "Lets the current claim go: the card returns to aberto and the attempt ends as abandoned with the reason, keeping the usage it reported. Allowed to the token that made the claim, or to a token with manage.",
  task_heartbeat:
    "Renews the activity of the current claim for a long run and returns when the lease expires. Allowed to the token that owns the claim, or to a token with manage.",
  task_update:
    "Records progress, leaves a comment, marks revisado, reclassifies the harness, or reports and corrects the card usage, including on a discarded card. project_id moves the card between projects. status descartado together with superseded_by ends the attempt as abandoned and links the card that continues it; that one needs can_manage.",
  task_deliver:
    "Delivers the result: summary, evidence, artifacts, usage. usage is MANDATORY: without exact numbers, ESTIMATE tokens, turns and cost and set estimated: true, and the card labels them as an estimate. Duration is measured by the server, from the claim to the deliver. how_to_verify (a URL or a command) opens the plain-language validation panel. Status becomes feito.",
  task_delete:
    "Hard delete: removes the card, cascading to its attempts, handoffs and subtasks. Irreversible.",
  branch_register: "Records on the card the branch that was created for it.",
  harness_recommend:
    "Policy lookup: reads one activity type off the cardapio and returns its cli, model and effort.",
  harness_list:
    "The whole workspace policy (every activity type to cli, model, effort) and the configured executors.",
  insights_query:
    "Cost, tokens and time over the workspace, grouped by project, mission, model or card, with an optional period, plus the reopened rate per model. Same numbers the Insights page shows: estimated and unreported usage come back counted, never silently summed.",
  executors_update:
    "Adds or removes CLIs and models in the workspace executor config, in the same shape the Settings grid saves. Adding models turns the CLI on unless enabled:false says otherwise; remove:true drops the whole CLI. Needs a token with the manage flag.",
  harness_set:
    "Writes one policy line (activity type to cli, model, effort), validated against the configured executors and stamped with who changed it. Needs a token with the manage flag; a plain worker token gets PERMISSION_DENIED.",
};

function inputSchemaFor(name: McpToolName) {
  const schema = toolContracts[name].input;
  const unwrap = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const next = (value as { _def?: { schema?: unknown; innerType?: unknown } })._def;
    if (next?.schema) return unwrap(next.schema);
    if (next?.innerType) return unwrap(next.innerType);
    return value;
  };
  return unwrap(schema) as typeof schema;
}

export async function createOverclickMcpServer(opts: {
  db: McpDatabase;
  ctx: AuthContext;
}): Promise<McpServer> {
  const projects = await opts.db
    .select({
      name: project.name,
      idPrefix: project.idPrefix,
      context: project.context,
    })
    .from(project)
    .where(eq(project.workspaceId, opts.ctx.workspaceId))
    .orderBy(asc(project.createdAt));
  const server = new McpServer(
    { name: "overclick", version: "0.1.12" },
    { instructions: instructionsWithProjects(projects) },
  );

  for (const row of projects) {
    if (!row.context?.trim()) continue;
    const uri = `overclick://project/${row.idPrefix}/context`;
    const context = row.context;
    server.registerResource(
      `project-${row.idPrefix.toLowerCase()}-context`,
      uri,
      {
        title: `${row.name} project context`,
        description: `Complete markdown context for project ${row.idPrefix}.`,
        mimeType: "text/markdown",
      },
      async () => ({
        contents: [{ uri, mimeType: "text/markdown", text: context }],
      }),
    );
  }

  for (const name of MCP_TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: DESCRIPTIONS[name],
        inputSchema: inputSchemaFor(name),
      },
      async (args: unknown) => {
        const result = await invokeTool(opts.db, opts.ctx, name, args);
        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: {
                    code: result.error.code,
                    message: result.error.message,
                    details: result.error.details,
                  },
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.value),
            },
          ],
        };
      },
    );
  }

  return server;
}
