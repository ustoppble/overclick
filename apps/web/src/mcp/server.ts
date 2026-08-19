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
  mission_list: "Lista as missões do workspace e o contexto de cada uma.",
  mission_get:
    "Devolve a missão completa (objetivo/contexto) para injetar no prompt.",
  mission_create:
    "Cria uma missão no workspace (title, objective/context em markdown, status). Use o id retornado em task_create.mission.",
  mission_update:
    "Updates a mission in place (title, objective/context markdown, status). Omitted fields stay unchanged; conventions for one round belong in the mission context.",
  mission_delete:
    "Deletes an empty mission shell. A mission with cards is refused with its count unless force: true explicitly detaches those cards first.",
  task_list:
    "Fila de cards do workspace. Filtros: projeto, missão, status, prioridade, awaiting_review_by, limit (default 50, máx 200). A resposta traz truncated: true quando o board tem mais cards do que coube.",
  task_get:
    "Card autocontido: contrato + harness + missão + convenção de branch (markdown).",
  task_search:
    "Free-text search over the workspace's cards (title, what, why, comments), best match first. Filters: project_id (uuid or prefix), type, status (one or a list), limit (default 5, max 20). Each hit carries resolved_in, comments_count and reports_count, so you can tell whether a card already covers something before creating one. Empty list when nothing matches.",
  task_create:
    "Cria um card. Workspace vem do token. mission é o id de uma missão existente (mission_create / mission_list); omitido → card solto. mode solo|team. supersedes descarta atomicamente o card anterior em execução; inherit reutiliza o contrato sem copiar comentários.",
  task_claim:
    "Pega o card (status → em execução), cria ExecutionAttempt e devolve o briefing. Codex deve declarar o modelo exato de --model (por exemplo gpt-5.6-sol), nunca só gpt-5. Um claim sem atividade além do timeout do workspace é abandonado como stale e pode ser retomado sem force; a resposta marca reclaimed_stale: true.",
  task_release:
    "Solta o claim atual: o card volta a aberto e o attempt vira abandoned com o reason, preservando usage. Permitido ao mesmo token que fez o claim ou a um token com manage.",
  task_heartbeat:
    "Renova a atividade do claim atual para execuções longas e devolve quando o lease expira. Permitido ao token dono do claim ou a um token com manage.",
  task_update:
    "Registra progresso, comentário, marca revisado, reclassifica o harness ou reporta/corrige usage do card (inclusive descartado). project_id move o card entre projetos. status descartado + superseded_by encerra o attempt como abandoned e liga a continuação; exige can_manage.",
  task_deliver:
    "Entrega o resultado: resumo, evidências, artefatos, usage. usage é OBRIGATÓRIO: sem números exatos, ESTIME tokens, turns e custo e marque estimated: true — o card rotula como estimativa. A duração é medida pelo servidor do claim ao deliver. how_to_verify (URL ou comando) abre o painel de validação leiga. Status → feito.",
  task_delete:
    "Hard delete: remove o card com attempts, handoffs e subtasks em cascata. Irreversível.",
  branch_register: "Grava a branch criada no card.",
  harness_recommend:
    "Lookup da política do cardápio: tipo → CLI · modelo · effort.",
  harness_list:
    "Política inteira do workspace (tipo → CLI · modelo · effort) e os executores configurados.",
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
