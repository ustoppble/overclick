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
  "Typical flow: task_list shows the queue, task_claim takes a card (send your executor: cli, exact session model from --model, session_id) and returns the briefing, then create and push a commit before task_deliver. A modified working tree is not a delivery; send the commit hash and branch with summary, evidence and usage. When the CLI recipe yields tokens_per_model, measure from the transcript; estimated: true is refused unless you send the reason the recipe prints when the transcript is missing. CLIs whose recipe yields no_tokens may estimate.",
  "If an executor must stop, task_release returns its card to the queue without deleting the attempt. Long runs may call task_heartbeat; an inactive claim expires at the workspace timeout and the next task_claim reports reclaimed_stale: true.",
  "Missions group cards: mission_create returns the id that task_create accepts. Every task_id argument accepts the card uuid or the workspace short id (for example AGB-5).",
  "Round-wide conventions belong in mission context: edit them with mission_update. Remove empty mission shells with mission_delete.",
  "Shared markdown is edited incrementally: use context_ops (and objective_ops for a mission objective) to change one section or list line; never resend a whole blob for a one-line change. Send context/objective only for an intentional full rewrite.",
  "Cards live in projects: project_list shows the projects of the workspace and project_create starts one. task_create takes the project uuid or its card prefix (for example AGB).",
  "Projects and missions live under an organization, the business they belong to: organization_list shows them, and project_create/mission_create take one by uuid or name. On a workspace with a single organization it can be omitted; with several the call is refused with the options. project_list, mission_list, task_list and task_search filter by organization.",
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
  organization_list:
    "Lists the businesses in this workspace with has_context and their project, mission and card counts. Every project and mission belongs to exactly one.",
  organization_get:
    "Returns one organization with its context markdown: the business rules an agent reads above the project context.",
  organization_create:
    "Creates an organization (name, optional context markdown). Context is limited to 32000 characters and the name is unique per workspace.",
  organization_update:
    "Renames an organization or rewrites its context markdown; omitted fields stay unchanged. Returns an acknowledgement with updated_at and changed fields by default; pass return: full for the complete organization.",
  organization_delete:
    "Deletes an organization. One still holding projects or missions comes back refused with the counts that block it, unless reassign_to names the organization that inherits them. There is no force: a project or a mission cannot exist without an organization, so there is nothing to detach to.",
  project_list:
    "Lists the workspace projects with card prefix, repo url, has_context and card counts by status, with the organization each one belongs to. Filter by organization to read one business at a time. Start here on a fresh board: task_create needs a project.",
  project_get:
    "Returns one project, including context markdown, current_version, latest_prerelease, context_updated_at and context_source when the briefing view is requested.",
  project_context_refresh:
    "Refreshes a project's configured GitHub release and context-file sources. Stable releases advance current_version; prereleases are kept in latest_prerelease. Managed sections change while manual context outside their markers stays intact. The operation is idempotent and writes an audit entry for each unseen source update.",
  project_create:
    "Creates a project (name, optional organization, repo_url, context, current_version, context_source and id_prefix). Context is limited to 32000 characters. The card prefix is derived from the name when omitted and is unique per workspace. organization takes a uuid or a name; omitted, it resolves to the only organization in the workspace and is refused with the options when there are several.",
  project_update:
    "Partially updates a project (name, organization, repo_url, context, context_ops, current_version, context_source, id_prefix); omitted fields stay unchanged. By default it returns an acknowledgement with updated_at and changed fields; pass return: full for the complete project. Use context_ops to edit one markdown section or list line against the current server value; do not resend the whole context blob for a small change. context is still accepted for an intentional full rewrite and optional expected_len/expected_hash detects a stale legacy read. Context is limited to 32000 characters. Accepts context_source (releases_repo, context_file, refresh) to keep the context synced from GitHub. The card prefix is only editable while the project has no cards, because every card carries it in its short id: to reorganize a project that holds cards, move them with task_update passing project_id.",
  project_delete:
    "Hard delete: removes the project. Only an empty one by default; a project with cards comes back refused with the count that blocks it, and force: true destroys the project with every card in it, and their attempts, handoffs and subtasks. Irreversible.",
  mission_list:
    "Lists the workspace missions with the context carried by each one and the organization each one runs for. Filter by organization to read one business at a time.",
  mission_get:
    "Returns the full mission (objective and context) to inject into the prompt.",
  mission_create:
    "Creates a mission in the workspace (title, optional organization, objective and context in markdown, status). organization takes a uuid or a name; omitted, it resolves to the only organization in the workspace and is refused with the options when there are several. Pass the id it returns as task_create.mission.",
  mission_update:
    "Partially updates a mission in place (title, organization, objective/context markdown, context_ops, objective_ops, status). By default it returns an acknowledgement with updated_at and changed fields; pass return: full for the complete mission. Use context_ops or objective_ops to change one markdown section or list line against the current server value; never resend a whole blob for a one-line change. context/objective remain available for intentional full rewrites, with optional expected_len/expected_hash stale-read guards. Omitted fields stay unchanged; conventions for one round belong in the mission context.",
  mission_delete:
    "Deletes an empty mission shell. A mission with cards is refused with its count unless force: true explicitly detaches those cards first.",
  mission_attempt_start:
    "Starts the one live orchestration attempt for an active mission. The executor session_id is required; a stale lease is abandoned before a new attempt is opened.",
  mission_report_usage:
    "Records a cumulative usage snapshot for a mission orchestration attempt. Replaying the current sequence identically is a no-op; conflicting or regressive sequences fail, and final closes the attempt with frozen cost.",
  task_list:
    "The card queue of the workspace. Each row defaults to the operational minimum — short_id, title, type, status, priority, cost_usd, plus delivery_unverified only when true — with no uuid on the line, since every tool already accepts short_id. Add include for the rest, in groups: [\"harness\"] (planned CLI/model/effort, needed to dispatch — task_list alone is not enough to dispatch anymore), [\"ids\"] (the card's own id), [\"refs\"] (mission_id, project_id, branch, claimed_by), [\"delivery\"] (commit, delivery_verification, delivery_warning, reports_count, revisado, devolve_para), or [\"all\"] for every group at once. Filters: project, mission, organization, resolved_in (exact release), status, priority, claimed_by: me, awaiting_review_by, limit (default 50, max 200). The response returns truncated: true when the board has more cards than fit.",
  task_get:
    "The self-contained card: contract, harness, mission and branch convention, in markdown.",
  task_search:
    "Free-text search over the workspace's cards (title, what, why, comments), best match first. Each hit defaults to short_id, title, type, status and o_que (cut at 300 chars) — no uuid. Same include groups as task_list: [\"ids\"] adds id, [\"refs\"] adds resolved_in, [\"delivery\"] adds comments_count, reports_count and updated_at, [\"all\"] returns every field. Filters: project_id (uuid or prefix), organization (uuid or name), resolved_in (exact release), type, status (one or a list), limit (default 5, max 20). Empty list when nothing matches.",
  task_create:
    "Creates a card. By default it returns a compact acknowledgement with the short id, status, updated_at and changed fields; pass return: full for the complete card and subtasks. The workspace comes from the token. mission is the id of an existing mission (mission_create, mission_list); omit it and the card stands on its own. mode is solo or team. supersedes atomically discards the card that was in execution, and inherit reuses its contract without carrying its comments over.",
  task_claim:
    "Takes the card (status becomes em_execucao), opens an ExecutionAttempt and returns the briefing. Declare the exact cli, model and optional provider effort actually used; the claim response reports divergence from the planned harness. Codex must declare the exact model it was given in --model (gpt-5.6-sol, for example), never just gpt-5. A claim left without activity past the workspace timeout is abandoned as stale and can be taken over without force; the response marks reclaimed_stale: true.",
  task_release:
    "Lets the current claim go: the card returns to aberto and the attempt ends as abandoned with the reason, keeping the usage it reported. Returns a compact acknowledgement by default; pass return: full for the task and attempt. Allowed to the token that made the claim, or to a token with manage.",
  task_heartbeat:
    "Renews the activity of the current claim for a long run and returns a compact acknowledgement by default; pass return: full for last_activity_at and expires_at. Allowed to the token that owns the claim, or to a token with manage.",
  task_update:
    "Records progress, leaves a comment, marks revisado, reclassifies the harness, or reports and corrects the card usage, including on a discarded card. By default it returns a compact acknowledgement with changed fields; pass return: full for the complete card and usage details. project_id moves the card between projects. status descartado together with superseded_by ends the attempt as abandoned and links the card that continues it; that one needs can_manage.",
  task_deliver:
    "Delivers the result: summary, evidence, artifacts, commit, branch and usage. By default it returns a compact acknowledgement with the handoff id and delivery telemetry; pass return: full for the task and handoff. Create and push the commit before calling this tool; a modified working tree is not a delivery. The board verifies the commit against the project remote when possible and accepts failures with a delivery_unverified warning. usage is MANDATORY: when the CLI recipe yields tokens_per_model, send the measured segments; estimated: true is refused unless usage.reason is the message the recipe prints when it cannot read the transcript. CLIs whose recipe yields no_tokens may estimate. Duration is measured by the server, from the claim to the deliver. how_to_verify (a URL or a command) opens the plain-language validation panel. Status becomes feito.",
  task_delete:
    "Hard delete: removes the card, cascading to its attempts, handoffs and subtasks. Irreversible.",
  branch_register: "Records on the card the branch that was created for it.",
  harness_recommend:
    "Policy lookup: reads one activity type off the cardapio and returns its cli, model and effort.",
  harness_list:
    "The whole workspace policy (every activity type to cli, model, effort) and configured executors, including the supported effort values and source URL keyed by model.",
  insights_query:
    "Cost, tokens and time over the workspace, with execution and orchestration subtotals plus a combined total, grouped by project, mission, release, model, executor or card, with an optional period, plus the reopened rate per model. Release groups use resolved_in and a null label for cards without one. Same numbers the Insights page shows: estimated, unreported and unverified work comes back counted, never silently summed.",
  executors_update:
    "Adds or removes CLIs and models in the workspace executor config, and can override the effort list keyed by model. Returns a compact acknowledgement by default; pass return: full for the complete executor config. Adding models turns the CLI on unless enabled:false says otherwise; remove:true drops the whole CLI. Needs a token with the manage flag.",
  harness_set:
    "Writes one policy line (activity type to cli, model, effort), validating the effort against that model's catalog and stamping who changed it. Returns a compact acknowledgement by default; pass return: full for the complete policy line. Needs a token with the manage flag; a plain worker token gets PERMISSION_DENIED.",
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
    { name: "overclick", version: "0.2.0" },
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
