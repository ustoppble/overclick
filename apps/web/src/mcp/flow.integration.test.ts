import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  TaskDeliverFullOutputSchema as TaskDeliverOutputSchema,
  MCP_TOOL_NAMES,
  TaskClaimOutputSchema,
  TaskCreateFullOutputSchema as TaskCreateOutputSchema,
  TaskGetOutputSchema,
  TaskListOutputSchema,
} from "@agent-board/mcp-core";
import { afterEach, describe, expect, it } from "vitest";
import { createOverclickMcpServer } from "./server";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeToolForTests as invokeTool } from "./test-tools";

const origem = {
  pane_id: "pane_1",
  session_id: "sess_torre",
  agent: "oc-chef",
  cli: "overclock",
  reportado_por: "test",
};

async function connectClient(world: TestWorld, tokenId = world.tokenId) {
  const server = await createOverclickMcpServer({
    db: world.db,
    ctx: { tokenId, workspaceId: world.workspaceId, tokenLabel: "test" },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "overclick-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function parseTool<T>(
  result: unknown,
  schema: { parse: (v: unknown) => T },
): T {
  const payload = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  expect(payload.isError ?? false).toBe(false);
  const text = payload.content?.find((part) => part.type === "text")?.text;
  expect(text).toBeTruthy();
  return schema.parse(JSON.parse(text as string));
}

describe("MCP end-to-end against a test db", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("lists and reads project context as an MCP resource", async () => {
    world = await createTestWorld();
    const updated = await invokeTool(world.db, {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "test",
    }, "project_update", {
      project_id: "OC",
      context: "# Resource context\n\nComplete markdown.",
      current_version: "1.3.5",
    });
    expect(updated.ok).toBe(true);

    const { client, server } = await connectClient(world);
    try {
      const listed = await client.listResources();
      expect(listed.resources.map((resource) => resource.uri)).toContain(
        "overclick://project/OC/context",
      );
      const read = await client.readResource({
        uri: "overclick://project/OC/context",
      });
      expect(read.contents[0]).toMatchObject({
        mimeType: "text/markdown",
        text: "# Resource context\n\nComplete markdown.",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists the tool catalog and runs create → claim → handoff", async () => {
    world = await createTestWorld();
    const { client, server } = await connectClient(world);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);

      const created = parseTool(
        await client.callTool({
          name: "task_create",
          arguments: {
            mission: world.missionId,
            project_id: world.projectId,
            title: "Corrige login",
            type: "bug",
            o_que: "O login volta a autenticar.",
            por_que: "Ninguém entra.",
            como_confirmo: [{ step: "abre /login", expected: "entra na home" }],
            mode: "solo",
            origem,
            devolve_para: { kind: "agent", session_id: "sess_torre" },
            return: "full",
          },
        }),
        TaskCreateOutputSchema,
      );
      expect(created.task.short_id).toBe("OC-1");
      expect(created.task.workspace_id).toBe(world.workspaceId);
      expect(created.task.mission_id).toBe(world.missionId);
      expect(created.task.status).toBe("aberto");
      expect(created.task.harness?.model).toBe("fable-5");
      expect(created.task.devolve_para).toEqual({
        kind: "agent",
        session_id: "sess_torre",
      });

      const got = parseTool(
        await client.callTool({
          name: "task_get",
          arguments: { task_id: created.task.short_id, view: "briefing" },
        }),
        TaskGetOutputSchema,
      );
      expect(got.briefing_markdown).toContain("OC-1");
      expect(got.briefing_markdown).toContain("O login volta a autenticar.");
      expect(got.briefing_markdown).toContain("Fechar o loop MCP do MVP.");
      expect(got.briefing_markdown).toContain(got.branch_convention.branch);
      expect(got.mission?.title).toBe("Norte do board");

      const claimed = parseTool(
        await client.callTool({
          name: "task_claim",
          arguments: {
            task_id: created.task.id,
            executor: { cli: "claude-code", model: "opus-5", session_id: "sess_exec" },
          },
        }),
        TaskClaimOutputSchema,
      );
      expect(claimed.task.status).toBe("em_execucao");
      expect(claimed.attempt.task_id).toBe(created.task.id);
      expect(claimed.attempt.finished_at).toBeNull();
      expect(claimed.harness_divergence?.warning).toMatch(/opus-5/i);
      expect(claimed.briefing_markdown).toContain("## Convenção");

      const handoff = parseTool(
        await client.callTool({
          name: "task_deliver",
          arguments: {
            task_id: created.task.id,
            summary: "Login autenticando de novo.",
            evidence: [{ text: "teste manual passou" }],
            artifacts: [
              {
                kind: "markdown",
                name: "notes.md",
                markdown: "# notas",
              },
            ],
            branch: "oc-1-corrige-login",
            pull_request_url: "https://example.com/pr/12",
            usage: {
              tokens_in: 1200,
              tokens_out: 400,
              tokens_cache: 100,
              cost_usd: 0.02,
              duration_ms: 8000,
              turns: 3,
            },
            return: "full",
          },
        }),
        TaskDeliverOutputSchema,
      );
      expect(handoff.task.status).toBe("feito");
      expect(handoff.telemetry_incomplete).toBe(false);
      expect(handoff.routed_to).toEqual({
        kind: "agent",
        session_id: "sess_torre",
      });
      expect(handoff.handoff.artifacts[0]?.kind).toBe("markdown");

      const reviewQueue = parseTool(
        await client.callTool({
          name: "task_list",
          arguments: { awaiting_review_by: "me" },
        }),
        TaskListOutputSchema,
      );
      expect(reviewQueue.tasks.map((task) => task.short_id)).toContain("OC-1");
    } finally {
      await server.close();
    }
  });

  it("returns ALREADY_CLAIMED when two agents race the same card", async () => {
    world = await createTestWorld();
    const ctxA = {
      tokenId: world.tokenId,
      workspaceId: world.workspaceId,
      tokenLabel: "a",
    };
    const created = await invokeTool(world.db, ctxA, "task_create", {
      project_id: world.projectId,
      title: "Race",
      type: "feature",
      o_que: "Um card.",
      por_que: "Testar CAS.",
      como_confirmo: [{ step: "existe", expected: "um card" }],
      origem,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const createdOut = TaskCreateOutputSchema.parse(created.value);

    const [first, second] = await Promise.all([
      invokeTool(world.db, ctxA, "task_claim", { task_id: createdOut.task.id }),
      invokeTool(
        world.db,
        {
          tokenId: world.secondTokenId,
          workspaceId: world.workspaceId,
          tokenLabel: "b",
        },
        "task_claim",
        { task_id: createdOut.task.id },
      ),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    const denied = outcomes.find((r) => !r.ok);
    expect(denied?.ok).toBe(false);
    if (denied && !denied.ok) {
      expect(denied.error.code).toBe("ALREADY_CLAIMED");
    }
  });
});
