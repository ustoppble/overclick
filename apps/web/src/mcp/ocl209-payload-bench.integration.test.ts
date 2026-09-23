/**
 * OCL-209 — the scale for the board diet. Not a regression test: it only runs
 * when OCL209_BENCH_OUT names a file, and then it calls EVERY MCP tool through
 * the same invokeTool path the server uses, recording the exact JSON text the
 * client would receive (server.ts sends JSON.stringify of the value) and the
 * time the server spent on it.
 *
 * Two regimes:
 * - "small": a brand-new workspace (1 organization, 1 project, 1 mission).
 * - "grown": the same workspace grown to the owner's real shape — 4
 *   organizations, 61 projects, 51 missions, 600 cards — with checkpoints on
 *   the way so the list tools give a curve, not a point.
 *
 * Arguments mirror the MEDIAN sizes the owner's agents really wrote between
 * 2026-09-09 and 2026-09-23 (mined from their transcripts, see
 * scripts/ocl-209/), so the echo-heavy answers (claim, get, branch_register)
 * weigh what they weigh in real use.
 *
 *   OCL209_BENCH_OUT=/tmp/bench.jsonl pnpm vitest run src/mcp/ocl209-payload-bench.integration.test.ts
 */
import { appendFileSync, writeFileSync } from "node:fs";
import type { McpToolName } from "@agent-board/mcp-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createOverclickMcpServer } from "./server";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";
import { invokeTool } from "./tools";
import type { AuthContext } from "./types";

const OUT = process.env.OCL209_BENCH_OUT;

const FILLER =
  "O executor lê o contrato, confere o critério de aceite e segue para a entrega com evidência. ";
function pt(length: number): string {
  let text = "";
  while (text.length < length) text += FILLER;
  return text.slice(0, length).trim();
}

const SESSION = "0f5f1e0a-6d0e-4a55-9a4e-2d1f7d3b9c11";
const TRANSCRIPT = {
  cli: "claude",
  session_id: SESSION,
  path: `/Users/someone/.claude/projects/-Users-someone-Developer-acme-app--worktrees-dev/${SESSION}.jsonl`,
};

/** Median task_create of the real window: 1.7k chars of arguments. */
function cardArgs(projectRef: string, missionId?: string) {
  return {
    project_id: projectRef,
    ...(missionId ? { mission: missionId } : {}),
    title: pt(81),
    type: "feature" as const,
    priority: "media" as const,
    o_que: pt(430),
    por_que: pt(154),
    como_confirmo: [
      { step: pt(90), expected: pt(89) },
      { step: pt(90), expected: pt(89) },
      { step: pt(90), expected: pt(89) },
    ],
    origem: { cli: "claude", session_id: SESSION, agent: "pane-1234 (worker de pane-5678)" },
  };
}

describe.skipIf(!OUT)("OCL-209 payload bench", () => {
  it("weighs every tool in a new workspace and in one grown to the real shape", async () => {
    const world: TestWorld = await createTestWorld();
    const ctx: AuthContext = { tokenId: world.tokenId, workspaceId: world.workspaceId, tokenLabel: "bench" };
    const manage: AuthContext = { tokenId: world.manageTokenId, workspaceId: world.workspaceId, tokenLabel: "bench-manage", canManage: true };
    writeFileSync(OUT!, "");

    async function call(regime: string, label: string, name: McpToolName, args: Record<string, unknown>, as = ctx, extra: Record<string, unknown> = {}) {
      const started = performance.now();
      const result = await invokeTool(world.db, as, name, args);
      const serverMs = performance.now() - started;
      const text = result.ok
        ? JSON.stringify(result.value)
        : JSON.stringify({ error: { code: result.error.code, message: result.error.message, details: result.error.details } });
      appendFileSync(
        OUT!,
        `${JSON.stringify({ regime, label, tool: name, ok: result.ok, chars: text.length, args_chars: JSON.stringify(args).length, server_ms: Number(serverMs.toFixed(2)), ...extra, error: result.ok ? undefined : `${result.error.code}: ${result.error.message.slice(0, 160)}` })}\n`,
      );
      return result;
    }
    /**
     * What every session pays before any call: the server instructions and
     * the tool definitions (description + input schema), measured over a real
     * MCP handshake against the same server factory the route uses.
     */
    async function handshake(regime: string) {
      const server = await createOverclickMcpServer({ db: world.db, ctx });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "ocl209-bench", version: "0" });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const instructions = client.getInstructions() ?? "";
      appendFileSync(OUT!, `${JSON.stringify({ regime, label: "instructions", tool: "(handshake)", ok: true, chars: instructions.length })}\n`);
      const { tools } = await client.listTools();
      let total = 0;
      for (const tool of tools) {
        const chars = JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }).length;
        total += chars;
        appendFileSync(OUT!, `${JSON.stringify({ regime, label: `definition:${tool.name}`, tool: tool.name, ok: true, chars })}\n`);
      }
      appendFileSync(OUT!, `${JSON.stringify({ regime, label: "definitions:total", tool: "(handshake)", ok: true, chars: total, n: tools.length })}\n`);
      await client.close();
      await server.close();
    }
    const value = (r: Awaited<ReturnType<typeof invokeTool>>) => {
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      return r.value as Record<string, any>;
    };

    // ---------- small: brand-new workspace, one project ----------
    const S = "small";
    await handshake(S);
    await call(S, "organization_list", "organization_list", {});
    await call(S, "organization_get", "organization_get", { organization_id: "General" });
    await call(S, "project_list", "project_list", {});
    await call(S, "project_get", "project_get", { project_id: "OC" });
    await call(S, "mission_list", "mission_list", {});
    await call(S, "mission_get", "mission_get", { mission_id: world.missionId });
    const created = value(await call(S, "task_create", "task_create", cardArgs("OC", world.missionId)));
    const card = String(created.task?.short_id ?? created.short_id ?? created.id);
    await call(S, "task_list", "task_list", {});
    await call(S, "task_search", "task_search", { q: "contrato" });
    await call(S, "task_get", "task_get", { task_id: card });
    await call(S, "task_get(view=full)", "task_get", { task_id: card, view: "full" });
    const claimArgs = {
      task_id: card,
      executor: { cli: "claude", model: "opus-5", effort: "high", session_id: SESSION },
      transcript: TRANSCRIPT,
    };
    await call(S, "task_claim", "task_claim", claimArgs);
    await call(S, "branch_register", "branch_register", { task_id: card, branch: "oc-1-pesar-o-board" });
    await call(S, "task_heartbeat", "task_heartbeat", { task_id: card });
    await call(S, "task_update", "task_update", { task_id: card, comment: pt(516) });
    await call(S, "task_release", "task_release", { task_id: card, reason: pt(211) });
    await call(S, "task_claim(again)", "task_claim", claimArgs);
    const deliverArgs = {
      task_id: card,
      summary: pt(608),
      how_to_verify: pt(142),
      evidence: [{ text: pt(230) }, { text: pt(230) }, { text: pt(230) }],
      branch: "oc-1-pesar-o-board",
      commit: "7a2e1be",
      usage: {
        segments: [{ model: "opus-5", input: 12, output: 9_000, cache_read: 1_200_000, cache_write: 60_000 }],
        turns: 40,
        estimated: false,
      },
      transcript: TRANSCRIPT,
    };
    await call(S, "task_deliver", "task_deliver", deliverArgs);
    // Median real reopen reason: 1.6k chars.
    await call(S, "task_reopen", "task_reopen", { task_id: card, reason: pt(1_600) });
    await call(S, "insights_query", "insights_query", {});
    const newMission = value(
      await call(S, "mission_create", "mission_create", { title: pt(58), organization: "General", objective: pt(268), context: pt(710) }),
    );
    const newMissionId = String(newMission.mission?.id);
    await call(S, "mission_update", "mission_update", { mission_id: newMissionId, objective: pt(249) });
    const attempt = value(
      await call(S, "mission_attempt_start", "mission_attempt_start", {
        mission_id: newMissionId,
        executor: { cli: "claude", model: "opus-5", effort: "high", session_id: SESSION },
        transcript: TRANSCRIPT,
      }),
    );
    await call(S, "mission_report_usage", "mission_report_usage", {
      mission_id: newMissionId,
      attempt_id: String(attempt.attempt?.id ?? attempt.attempt_id),
      sequence: 1,
      checkpoint: "rodada",
      usage: { segments: [{ model: "opus-5", input: 10, output: 5_000, cache_read: 300_000, cache_write: 20_000 }], turns: 12, estimated: false },
    });
    await call(S, "mission_delete", "mission_delete", { mission_id: newMissionId, force: true });
    await call(S, "project_create", "project_create", { name: "Bench Two", organization: "General", repo_url: "https://github.com/acme/bench-two", id_prefix: "BT" });
    await call(S, "project_update", "project_update", { project_id: "BT", context: pt(160) });
    await call(S, "project_context_refresh", "project_context_refresh", { project_id: "BT" });
    await call(S, "project_delete", "project_delete", { project_id: "BT" });
    await call(S, "organization_create", "organization_create", { name: "Bench Org" });
    await call(S, "organization_update", "organization_update", { organization_id: "Bench Org", context: pt(300) });
    await call(S, "organization_delete", "organization_delete", { organization_id: "Bench Org" });
    await call(S, "executors_update", "executors_update", { cli: "claude-code", add_models: ["opus-5"] }, manage);
    const doomed = value(await call(S, "task_create(for delete)", "task_create", cardArgs("OC")));
    await call(S, "task_delete", "task_delete", { task_id: String(doomed.task?.short_id ?? doomed.short_id ?? doomed.id) });

    // ---------- grown: 4 organizations, 61 projects, 51 missions, 600 cards ----------
    const G = "grown";
    const orgs = ["General"];
    for (const name of ["Overclock", "Pessoal", "Cliente Alfa"]) {
      value(await invokeTool(world.db, ctx, "organization_create", { name }));
      orgs.push(name);
    }
    const prefixes = ["OC"];
    const projectCheckpoints = new Set([5, 20, 40, 61]);
    for (let i = 2; i <= 61; i++) {
      const prefix = `P${i.toString(36).toUpperCase().padStart(2, "0")}`;
      value(
        await invokeTool(world.db, ctx, "project_create", {
          name: `Projeto de bancada número ${i}`,
          organization: orgs[i % orgs.length],
          repo_url: `https://github.com/acme/projeto-bancada-${i}`,
          id_prefix: prefix,
          ...(i % 3 === 0 ? { context: pt(1_500) } : {}),
        }),
      );
      prefixes.push(prefix);
      if (projectCheckpoints.has(i)) await call(`curve:projects=${i}`, "project_list", "project_list", {}, ctx, { n: i });
    }
    const missions = [world.missionId];
    const missionCheckpoints = new Set([10, 25, 51]);
    for (let i = 2; i <= 51; i++) {
      const m = value(
        await invokeTool(world.db, ctx, "mission_create", {
          title: pt(57),
          organization: orgs[i % orgs.length],
          objective: pt(268),
          context: pt(710),
        }),
      );
      missions.push(String(m.mission?.id));
      if (missionCheckpoints.has(i)) await call(`curve:missions=${i}`, "mission_list", "mission_list", {}, ctx, { n: i });
    }
    const cardCheckpoints = new Set([50, 200, 600]);
    let cards = 2; // the two created above (one deleted, one delivered+reopened)
    let lastCard = card;
    while (cards < 600) {
      cards += 1;
      const made = value(
        await invokeTool(world.db, ctx, "task_create", cardArgs(prefixes[cards % prefixes.length]!, missions[cards % missions.length])),
      );
      lastCard = String(made.task?.short_id ?? made.short_id ?? made.id);
      if (cardCheckpoints.has(cards)) {
        await call(`curve:cards=${cards}`, "task_list", "task_list", {}, ctx, { n: cards });
        await call(`curve:cards=${cards}`, "task_search", "task_search", { q: "contrato" }, ctx, { n: cards });
        await call(`curve:cards=${cards}`, "insights_query", "insights_query", {}, ctx, { n: cards });
      }
    }
    await handshake(G);
    await call(G, "organization_list", "organization_list", {});
    await call(G, "organization_get", "organization_get", { organization_id: "Overclock" });
    await call(G, "project_list", "project_list", {});
    await call(G, "project_get", "project_get", { project_id: prefixes[3]! });
    await call(G, "mission_list", "mission_list", {});
    await call(G, "mission_get", "mission_get", { mission_id: missions[7]! });
    await call(G, "task_list", "task_list", {});
    await call(G, "task_search", "task_search", { q: "contrato" });
    const fresh = value(await call(G, "task_create", "task_create", cardArgs(prefixes[3]!, missions[7]!)));
    const grownCard = String(fresh.task?.short_id ?? fresh.short_id ?? fresh.id);
    await call(G, "task_get", "task_get", { task_id: grownCard });
    await call(G, "task_get(view=full)", "task_get", { task_id: grownCard, view: "full" });
    await call(G, "task_claim", "task_claim", { ...claimArgs, task_id: grownCard });
    await call(G, "branch_register", "branch_register", { task_id: grownCard, branch: "p03-7-pesar-o-board" });
    await call(G, "task_heartbeat", "task_heartbeat", { task_id: grownCard });
    await call(G, "task_update", "task_update", { task_id: grownCard, comment: pt(516) });
    await call(G, "task_deliver", "task_deliver", { ...deliverArgs, task_id: grownCard });
    await call(G, "insights_query", "insights_query", {});
    expect(lastCard).toBeTruthy();
    await closeTestWorld(world);
  }, 600_000);
});
