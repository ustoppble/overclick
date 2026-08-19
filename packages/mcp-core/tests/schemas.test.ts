import { describe, expect, it } from "vitest";
import {
  TaskDeliverInputSchema,
  TaskUpdateInputSchema,
  MCP_TOOL_NAMES,
  MissionCreateInputSchema,
  MissionDeleteInputSchema,
  MissionUpdateInputSchema,
  PROJECT_CONTEXT_MAX_CHARS,
  ProjectCreateInputSchema,
  TaskCreateInputSchema,
  isTelemetryIncomplete,
  toolContracts,
} from "../src/index.js";

describe("MCP tool contracts", () => {
  it("exports input and output schemas for all 26 tools", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "project_list",
      "project_get",
      "project_create",
      "project_update",
      "project_delete",
      "mission_list",
      "mission_get",
      "mission_create",
      "mission_update",
      "mission_delete",
      "task_list",
      "task_get",
      "task_search",
      "task_create",
      "task_claim",
      "task_release",
      "task_heartbeat",
      "task_update",
      "task_deliver",
      "task_delete",
      "branch_register",
      "harness_recommend",
      "harness_list",
      "harness_set",
      "executors_update",
      "insights_query",
    ]);
    for (const name of MCP_TOOL_NAMES) {
      expect(toolContracts[name].input).toBeDefined();
      expect(toolContracts[name].output).toBeDefined();
    }
  });
});

describe("project_create", () => {
  it("takes a name alone, with repo_url and id_prefix optional", () => {
    const parsed = ProjectCreateInputSchema.parse({ name: "Agent Board" });
    expect(parsed.name).toBe("Agent Board");
    expect(parsed.repo_url).toBeUndefined();
    expect(parsed.id_prefix).toBeUndefined();
  });

  it("rejects an empty name and a repo_url that is not a url", () => {
    expect(ProjectCreateInputSchema.safeParse({ name: "" }).success).toBe(false);
    expect(
      ProjectCreateInputSchema.safeParse({ name: "Board", repo_url: "github" })
        .success,
    ).toBe(false);
  });

  it("accepts context and current_version up to the documented limit", () => {
    const parsed = ProjectCreateInputSchema.parse({
      name: "Agent Board",
      context: "# Architecture\n\nApp and database.",
      current_version: "1.3.5",
    });
    expect(parsed.context).toContain("Architecture");
    expect(parsed.current_version).toBe("1.3.5");
    expect(
      ProjectCreateInputSchema.safeParse({
        name: "Too much",
        context: "x".repeat(PROJECT_CONTEXT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("mission_create", () => {
  it("accepts title plus objective/context markdown and status", () => {
    const parsed = MissionCreateInputSchema.parse({
      title: "Norte do board",
      objective: "Fechar o loop MCP.",
      context: "O board é a fonte de verdade.",
      status: "ativa",
    });
    expect(parsed.title).toBe("Norte do board");
    expect(parsed.objective).toBe("Fechar o loop MCP.");
    expect(parsed.context).toBe("O board é a fonte de verdade.");
  });

  it("allows title only (objective/context optional, status defaults later)", () => {
    const parsed = MissionCreateInputSchema.parse({ title: "Loose north" });
    expect(parsed.objective).toBeUndefined();
    expect(parsed.context).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });

  it("rejects an empty title", () => {
    expect(MissionCreateInputSchema.safeParse({ title: "" }).success).toBe(false);
  });
});

describe("mission_update and mission_delete", () => {
  it("accepts partial mission edits and trims the title", () => {
    expect(
      MissionUpdateInputSchema.parse({
        mission_id: "mission-1",
        title: "  New north  ",
        status: "pausada",
      }),
    ).toEqual({
      mission_id: "mission-1",
      title: "New north",
      status: "pausada",
    });
  });

  it("rejects blank or oversized titles and invalid statuses", () => {
    expect(
      MissionUpdateInputSchema.safeParse({ mission_id: "mission-1", title: "  " })
        .success,
    ).toBe(false);
    expect(
      MissionUpdateInputSchema.safeParse({
        mission_id: "mission-1",
        title: "x".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      MissionUpdateInputSchema.safeParse({
        mission_id: "mission-1",
        status: "archived",
      }).success,
    ).toBe(false);
  });

  it("keeps force optional on mission_delete", () => {
    expect(
      MissionDeleteInputSchema.parse({ mission_id: "mission-1" }),
    ).toEqual({ mission_id: "mission-1" });
  });
});

describe("task_create canonical flow", () => {
  const origem = {
    pane_id: "pane_1",
    session_id: "sess_torre",
    agent: "oc-chef",
    cli: "overclock",
    reportado_por: "Laschuk · ao vivo",
  };

  it("accepts a solo card with mission declared by the caller", () => {
    const parsed = TaskCreateInputSchema.parse({
      mission: "miss_north",
      project_id: "proj_1",
      title: "Corrige login",
      type: "bug",
      o_que: "O login volta a autenticar.",
      por_que: "Ninguém entra.",
      como_confirmo: [
        { step: "abre /login", expected: "entra na home" },
      ],
      mode: "solo",
      origem,
    });
    expect(parsed.mission).toBe("miss_north");
    expect(parsed.mode).toBe("solo");
    expect("workspace_id" in parsed).toBe(false);
  });

  it("allows a card without mission (born loose)", () => {
    const parsed = TaskCreateInputSchema.parse({
      project_id: "proj_1",
      title: "Solto",
      type: "feature",
      o_que: "Nasce sem missão.",
      por_que: "O board não adivinha.",
      como_confirmo: [{ step: "abre o card", expected: "missão vazia" }],
      origem,
    });
    expect(parsed.mission).toBeUndefined();
  });

  it("requires subtask payloads in team mode", () => {
    const result = TaskCreateInputSchema.safeParse({
      project_id: "proj_1",
      title: "Time",
      type: "rfc",
      o_que: "Quebrar o RFC.",
      por_que: "Grande demais.",
      como_confirmo: [{ step: "lê o plano", expected: "há fatias" }],
      mode: "team",
      origem,
    });
    expect(result.success).toBe(false);
  });

  it("accepts team mode with scoped subtasks and optional per-child harness", () => {
    const parsed = TaskCreateInputSchema.parse({
      project_id: "proj_1",
      title: "RFC de auth",
      type: "rfc",
      o_que: "Desenhar auth.",
      por_que: "Precisamos de um contrato.",
      como_confirmo: [{ step: "lê o RFC", expected: "aprovável" }],
      mode: "team",
      devolve_para: { kind: "agent", session_id: "sess_torre" },
      harness: {
        model: "opus-4-8",
        effort: "high",
      },
      subtasks: [
        {
          title: "Pesquisar opções",
          scope: "levantar 3 abordagens",
          boundary: "não implementar",
        },
        {
          title: "Escrever o RFC",
          scope: "documento markdown",
          boundary: "sem código de produto",
          harness: { model: "opus-4-8", effort: "high" },
        },
      ],
      origem,
    });
    expect(parsed.subtasks).toHaveLength(2);
    expect(parsed.devolve_para).toEqual({
      kind: "agent",
      session_id: "sess_torre",
    });
  });

  it("rejects subtasks in solo mode", () => {
    const result = TaskCreateInputSchema.safeParse({
      project_id: "proj_1",
      title: "Solo",
      type: "bug",
      o_que: "Um card.",
      por_que: "Só um.",
      como_confirmo: [{ step: "existe", expected: "um card" }],
      mode: "solo",
      subtasks: [
        { title: "não", scope: "x", boundary: "y" },
      ],
      origem,
    });
    expect(result.success).toBe(false);
  });

  it("documents that task_id accepts a uuid or a short id", () => {
    const schema = toolContracts.task_get.input;
    const described = schema.shape.task_id.description ?? "";
    expect(described.toLowerCase()).toContain("short");
    for (const name of [
      "task_get",
      "task_claim",
      "task_release",
      "task_heartbeat",
      "task_update",
      "task_deliver",
      "task_delete",
      "branch_register",
    ] as const) {
      expect(
        toolContracts[name].input.parse({
          task_id: "AGB-5",
          ...(name === "task_release" ? { reason: "executor stopped" } : {}),
          ...(name === "task_update" ? { comment: "ok" } : {}),
          ...(name === "task_deliver" ? { summary: "ok" } : {}),
          ...(name === "branch_register" ? { branch: "agb-5-x" } : {}),
        }).task_id,
      ).toBe("AGB-5");
    }
  });

  it("requires origem identity from the caller", () => {
    const result = TaskCreateInputSchema.safeParse({
      project_id: "proj_1",
      title: "Sem origem",
      type: "bug",
      o_que: "x",
      por_que: "y",
      como_confirmo: [{ step: "a", expected: "b" }],
      origem: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("task_deliver usage and artifacts", () => {
  it("accepts a handoff without usage (telemetry incomplete)", () => {
    const parsed = TaskDeliverInputSchema.parse({
      task_id: "OC-1",
      summary: "RFC pronto para ler.",
      evidence: [{ text: "documento anexado" }],
      artifacts: [
        {
          kind: "rfc_markdown",
          name: "docs/rfcs/OC-1.md",
          markdown: "# RFC\n\nProposta.",
        },
      ],
    });
    expect(parsed.usage).toBeUndefined();
    expect(parsed.artifacts?.[0]?.kind).toBe("rfc_markdown");
  });

  it("accepts an optional how_to_verify entry point for lay validation", () => {
    const parsed = TaskDeliverInputSchema.parse({
      task_id: "OC-1",
      summary: "pronto",
      how_to_verify: "http://localhost:3300/home, open the card in Done",
    });
    expect(parsed.how_to_verify).toBe(
      "http://localhost:3300/home, open the card in Done",
    );

    const without = TaskDeliverInputSchema.parse({
      task_id: "OC-1",
      summary: "pronto",
    });
    expect(without.how_to_verify).toBeUndefined();

    const empty = TaskDeliverInputSchema.safeParse({
      task_id: "OC-1",
      summary: "pronto",
      how_to_verify: "",
    });
    expect(empty.success).toBe(false);
  });

  it("accepts the full usage block (tokens in/out/cache, cost, duration, turns)", () => {
    const parsed = TaskDeliverInputSchema.parse({
      task_id: "OC-1",
      summary: "corrigido",
      evidence: [{ url: "https://example.com/pr/12" }],
      branch: "oc-1-corrige-login",
      pull_request_url: "https://example.com/pr/12",
      usage: {
        tokens_in: 12000,
        tokens_out: 3400,
        tokens_cache: 8000,
        cost_usd: 0.8,
        duration_ms: 34 * 60 * 1000,
        turns: 11,
      },
    });
    expect(parsed.usage).toEqual({
      tokens_in: 12000,
      tokens_out: 3400,
      tokens_cache: 8000,
      cost_usd: 0.8,
      duration_ms: 34 * 60 * 1000,
      turns: 11,
    });
  });

  it("accepts estimated usage and a usage-only task_update", () => {
    const delivered = TaskDeliverInputSchema.parse({
      task_id: "OC-1",
      summary: "estimado",
      usage: { tokens_in: 1000, tokens_out: 200, estimated: true },
    });
    expect(delivered.usage?.estimated).toBe(true);

    const updated = toolContracts.task_update.input.parse({
      task_id: "OC-1",
      usage: { tokens_in: 5000, cost_usd: 0.4 },
    });
    expect(updated.usage?.tokens_in).toBe(5000);
  });

  it("accepts usage in segments, one per model that ran", () => {
    const delivered = TaskDeliverInputSchema.parse({
      task_id: "OC-1",
      summary: "trocou de modelo",
      usage: {
        segments: [
          { model: "sonnet-5", input: 1000, output: 200, cache_read: 5000 },
          { model: "opus-5", input: 300, output: 900, cache_write: 100 },
        ],
        duration_ms: 900_000,
        turns: 12,
      },
    });
    expect(delivered.usage?.segments).toHaveLength(2);
    expect(delivered.usage?.segments?.[1]?.model).toBe("opus-5");
  });

  it("counts segments as reported tokens for the telemetry flag", () => {
    expect(
      isTelemetryIncomplete({
        segments: [{ model: "opus-5", input: 10, output: 20 }],
        cost_usd: 0.1,
        duration_ms: 1000,
        turns: 2,
      }),
    ).toBe(false);
    // No segments and no flat counters: still incomplete.
    expect(
      isTelemetryIncomplete({ cost_usd: 0.1, duration_ms: 1000, turns: 2 }),
    ).toBe(true);
    // Money is an opt-in layer the board computes itself, so a delivery that
    // names no price is complete as long as it reported what it measured.
    expect(
      isTelemetryIncomplete({
        segments: [{ model: "opus-5", input: 10, output: 20 }],
        duration_ms: 1000,
        turns: 2,
      }),
    ).toBe(false);
    expect(
      isTelemetryIncomplete({ tokens_in: 10, tokens_out: 20, turns: 2 }),
    ).toBe(true);
  });

  it("refuses an unknown key instead of dropping it", () => {
    // The historical case: docs/mcp.md called the flag "reviewed" while the
    // field is "revisado". Without strict the key vanished, the card was
    // never marked, and nothing anywhere said so.
    const typo = TaskUpdateInputSchema.safeParse({
      task_id: "AGB-1",
      reviewed: true,
    });
    expect(typo.success).toBe(false);

    // The same shape with the real field is accepted, so strict costs the
    // caller nothing when the caller is right.
    const correct = TaskUpdateInputSchema.safeParse({
      task_id: "AGB-1",
      revisado: true,
    });
    expect(correct.success).toBe(true);
  });

  it("keeps every tool contract strict, so no surface drifts back", () => {
    for (const name of MCP_TOOL_NAMES) {
      // A schema can carry several refinements, and each one wraps the
      // last, so unwrap until the object itself shows up. That is where
      // strict lives.
      let object: unknown = toolContracts[name].input;
      while ((object as { _def?: { schema?: unknown } })._def?.schema) {
        object = (object as { _def: { schema: unknown } })._def.schema;
      }
      expect(
        (object as { _def: { unknownKeys?: string } })._def.unknownKeys,
        `${name} must be strict`,
      ).toBe("strict");
    }
  });
});