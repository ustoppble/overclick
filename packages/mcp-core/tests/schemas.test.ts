import { describe, expect, it } from "vitest";
import {
  TaskDeliverInputSchema,
  TaskCreateOutputSchema,
  TaskUpdateInputSchema,
  MCP_TOOL_NAMES,
  MissionCreateInputSchema,
  MissionDeleteInputSchema,
  MissionUpdateInputSchema,
  ORGANIZATION_CONTEXT_MAX_CHARS,
  OrganizationCreateInputSchema,
  OrganizationDeleteInputSchema,
  OrganizationDetailSchema,
  OrganizationListOutputSchema,
  OrganizationUpdateInputSchema,
  PROJECT_CONTEXT_MAX_CHARS,
  ProjectCreateInputSchema,
  ProjectUpdateInputSchema,
  TaskCreateInputSchema,
  TaskListInputSchema,
  TaskListItemSchema,
  TaskReadSchema,
  TaskSearchInputSchema,
  TaskSearchHitSchema,
  TaskClaimInputSchema,
  ListIncludeSchema,
  WriteAckSchema,
  ExecutorsUpdateInputSchema,
  isTelemetryIncomplete,
  MissionAttemptStartInputSchema,
  MissionReportUsageInputSchema,
  toolContracts,
  HarnessSchema,
  ConfiguredExecutorSchema,
  CardapioPolicyEntrySchema,
  HarnessSetInputSchema,
} from "../src/index.js";

describe("model-specific efforts", () => {
  it("accepts provider values beyond the old low/medium/high enum", () => {
    const claim = TaskClaimInputSchema.parse({
      task_id: "OCL-51",
      executor: { cli: "codex", model: "gpt-5.6-sol", effort: "max" },
    });
    expect(claim.executor?.effort).toBe("max");

    const update = ExecutorsUpdateInputSchema.parse({
      cli: "codex",
      efforts: { "gpt-5.6-sol": ["minimal", "low", "medium", "high", "xhigh", "max"] },
    });
    expect(update.efforts?.["gpt-5.6-sol"]).toContain("max");
  });
});

describe("MCP tool contracts", () => {
  it("exports input and output schemas for all 34 tools", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "organization_list",
      "organization_get",
      "organization_create",
      "organization_update",
      "organization_delete",
      "project_list",
      "project_get",
      "project_create",
      "project_update",
      "project_context_refresh",
      "project_delete",
      "mission_list",
      "mission_get",
      "mission_create",
      "mission_update",
      "mission_delete",
      "mission_attempt_start",
      "mission_report_usage",
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

  it("requires a session and cumulative final result on mission telemetry", () => {
    expect(
      MissionAttemptStartInputSchema.safeParse({
        mission_id: "mission-1",
        executor: { cli: "codex" },
      }).success,
    ).toBe(false);
    expect(
      MissionReportUsageInputSchema.safeParse({
        mission_id: "mission-1",
        attempt_id: "attempt-1",
        sequence: 1,
        checkpoint: "final",
        usage: {},
      }).success,
    ).toBe(false);
    expect(
      MissionReportUsageInputSchema.parse({
        mission_id: "mission-1",
        attempt_id: "attempt-1",
        sequence: 1,
        checkpoint: "final",
        usage: { segments: [{ model: "gpt-5-6-luna", input: 10 }] },
        result: "success",
      }).sequence,
    ).toBe(1);
  });

  it("keeps write responses compact by default with an explicit full opt-in", () => {
    const create = {
      project_id: "OC",
      title: "Card",
      type: "bug" as const,
      o_que: "O comportamento muda.",
      por_que: "O fluxo atual falha.",
      como_confirmo: [{ step: "executa o teste", expected: "passa" }],
      origem: { cli: "codex", session_id: "sess" },
    };

    expect(TaskCreateInputSchema.parse(create).return).toBeUndefined();
    expect(TaskCreateInputSchema.parse({ ...create, return: "full" }).return).toBe(
      "full",
    );
    expect(
      TaskUpdateInputSchema.parse({
        task_id: "OC-1",
        progress: "feito",
        return: "ack",
      }).return,
    ).toBe("ack");
    expect(
      TaskClaimInputSchema.safeParse({ task_id: "OC-1", return: "full" }).success,
    ).toBe(false);

    const ack = TaskCreateOutputSchema.parse({
      short_id: "OC-1",
      updated_at: "2026-08-19T12:00:00.000Z",
      status: "aberto",
      changed: { mode: "solo" },
    });
    expect(ack).toMatchObject({ short_id: "OC-1", status: "aberto" });
    expect(WriteAckSchema.parse(ack).changed).toEqual({ mode: "solo" });
  });
});

describe("task_list", () => {
  it("accepts only the caller shorthand for claimed cards", () => {
    expect(TaskListInputSchema.parse({ claimed_by: "me" })).toEqual({
      claimed_by: "me",
    });
    expect(
      TaskListInputSchema.safeParse({ claimed_by: "another-token" }).success,
    ).toBe(false);
  });

  it("models compact read rows with an optional harness and absent fields", () => {
    const task = TaskReadSchema.parse({
      id: "task-1",
      short_id: "OC-1",
      title: "Compact read",
      type: "feature",
      status: "aberto",
      revisado: false,
      priority: "media",
      project_id: "project-1",
      devolve_para: { kind: "workspace_queue" },
      delivery_unverified: false,
      o_que: "The contract is available.",
      por_que: "The queue stays cheap.",
      como_confirmo: [{ step: "read", expected: "compact" }],
      harness: { cli: "codex", model: "model-1", effort: "medium" },
      origem: { cli: "codex" },
      mode: "solo",
      created_at: "2026-08-19T12:00:00.000Z",
      updated_at: "2026-08-19T12:00:00.000Z",
      workspace_id: "must-not-cross-the-wire",
    });

    expect(task.harness).toEqual({
      cli: "codex",
      model: "model-1",
      effort: "medium",
    });
    expect(task).not.toHaveProperty("workspace_id");
    expect(TaskReadSchema.safeParse({ ...task, commit: null }).success).toBe(false);

    const row = TaskListItemSchema.parse({
      ...task,
      cost_usd: 0.25,
    });
    expect(row.cost_usd).toBe(0.25);
    expect(row).not.toHaveProperty("workspace_id");
    expect(TaskListItemSchema.safeParse({ ...row, cost_usd: null }).success).toBe(
      false,
    );
  });

  it("accepts the operational-minimum row with no id, refs, delivery or harness", () => {
    const minimal = TaskListItemSchema.parse({
      short_id: "OC-1",
      title: "Lean by default",
      type: "feature",
      status: "aberto",
      priority: "alta",
    });
    expect(minimal).toEqual({
      short_id: "OC-1",
      title: "Lean by default",
      type: "feature",
      status: "aberto",
      priority: "alta",
    });
    expect(minimal).not.toHaveProperty("id");
    expect(minimal).not.toHaveProperty("project_id");
    expect(minimal).not.toHaveProperty("mission_id");
    expect(minimal).not.toHaveProperty("revisado");
    expect(minimal).not.toHaveProperty("devolve_para");
    expect(minimal).not.toHaveProperty("harness");
    expect(minimal).not.toHaveProperty("delivery_unverified");
  });

  it("accepts each include group additively on the same row", () => {
    const withIds = TaskListItemSchema.parse({
      short_id: "OC-1",
      title: "t",
      type: "feature",
      status: "aberto",
      priority: "alta",
      id: "task-1",
    });
    expect(withIds.id).toBe("task-1");

    const withRefs = TaskListItemSchema.parse({
      short_id: "OC-1",
      title: "t",
      type: "feature",
      status: "aberto",
      priority: "alta",
      project_id: "project-1",
      mission_id: "mission-1",
      branch: "ocl-1-x",
      claimed_by: "token-1",
    });
    expect(withRefs).toMatchObject({
      project_id: "project-1",
      mission_id: "mission-1",
      branch: "ocl-1-x",
      claimed_by: "token-1",
    });

    const withDelivery = TaskListItemSchema.parse({
      short_id: "OC-1",
      title: "t",
      type: "feature",
      status: "aberto",
      priority: "alta",
      revisado: true,
      devolve_para: { kind: "workspace_queue" },
      commit: "abc123",
      delivery_verification: "verified",
      reports_count: 2,
    });
    expect(withDelivery).toMatchObject({
      revisado: true,
      commit: "abc123",
      delivery_verification: "verified",
      reports_count: 2,
    });

    const withHarness = TaskListItemSchema.parse({
      short_id: "OC-1",
      title: "t",
      type: "feature",
      status: "aberto",
      priority: "alta",
      harness: { cli: "codex", model: "model-1", effort: "medium" },
    });
    expect(withHarness.harness).toEqual({
      cli: "codex",
      model: "model-1",
      effort: "medium",
    });
  });

  it("takes include as one of the five named groups", () => {
    expect(ListIncludeSchema.options).toEqual([
      "harness",
      "ids",
      "delivery",
      "refs",
      "all",
    ]);
    expect(TaskListInputSchema.parse({ include: ["harness"] }).include).toEqual([
      "harness",
    ]);
    expect(TaskListInputSchema.safeParse({ include: ["nope"] }).success).toBe(false);
    expect(TaskListInputSchema.safeParse({ include: [] }).success).toBe(false);
  });
});

describe("task_search", () => {
  it("takes the same include groups as task_list", () => {
    expect(
      TaskSearchInputSchema.parse({ q: "x", include: ["ids", "refs"] }).include,
    ).toEqual(["ids", "refs"]);
    expect(
      TaskSearchInputSchema.safeParse({ q: "x", include: ["harness"] }).success,
    ).toBe(true);
  });

  it("accepts the operational-minimum hit with no id, resolved_in or counts", () => {
    const minimal = TaskSearchHitSchema.parse({
      short_id: "OC-1",
      title: "Lean hit",
      type: "feature",
      status: "aberto",
      o_que: "x",
    });
    expect(minimal).toEqual({
      short_id: "OC-1",
      title: "Lean hit",
      type: "feature",
      status: "aberto",
      o_que: "x",
    });
    expect(minimal).not.toHaveProperty("id");
    expect(minimal).not.toHaveProperty("resolved_in");
    expect(minimal).not.toHaveProperty("comments_count");
    expect(minimal).not.toHaveProperty("reports_count");
    expect(minimal).not.toHaveProperty("updated_at");
  });

  it("accepts every field at once, matching the pre-OCL-96 hit", () => {
    const full = TaskSearchHitSchema.parse({
      short_id: "OC-1",
      title: "Full hit",
      type: "feature",
      status: "aberto",
      o_que: "x",
      id: "task-1",
      resolved_in: "v1.0.0",
      comments_count: 3,
      reports_count: 1,
      updated_at: "2026-08-19T12:00:00.000Z",
    });
    expect(full.id).toBe("task-1");
    expect(full.resolved_in).toBe("v1.0.0");
    expect(full.comments_count).toBe(3);
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

describe("organization contracts", () => {
  it("round-trips a listed organization with its counts", () => {
    const parsed = OrganizationListOutputSchema.parse({
      organizations: [
        {
          id: "5f1e3a1e-8f0c-4d0a-9b4e-1f2a3b4c5d6e",
          name: "Overclock",
          has_context: true,
          counts: { projects: 3, missions: 2, cards: 41 },
          created_at: "2026-08-28T00:00:00.000Z",
        },
      ],
    });
    expect(parsed.organizations[0]?.counts.cards).toBe(41);
    // The list is a summary: the markdown itself only travels in the detail.
    expect(parsed.organizations[0]).not.toHaveProperty("context");
  });

  it("round-trips the detail, with a null context when there is none", () => {
    const parsed = OrganizationDetailSchema.parse({
      id: "5f1e3a1e-8f0c-4d0a-9b4e-1f2a3b4c5d6e",
      name: "Padre Miguel",
      has_context: false,
      counts: { projects: 0, missions: 0, cards: 0 },
      created_at: "2026-08-28T00:00:00.000Z",
      context: null,
    });
    expect(parsed.context).toBeNull();
  });

  it("trims the name, refuses an empty one and caps the context", () => {
    expect(
      OrganizationCreateInputSchema.parse({ name: "  Overclock  " }).name,
    ).toBe("Overclock");
    expect(OrganizationCreateInputSchema.safeParse({ name: "   " }).success).toBe(
      false,
    );
    expect(
      OrganizationCreateInputSchema.safeParse({
        name: "Too much",
        context: "x".repeat(ORGANIZATION_CONTEXT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it("refuses an update that changes nothing", () => {
    expect(
      OrganizationUpdateInputSchema.safeParse({ organization_id: "Overclock" })
        .success,
    ).toBe(false);
    expect(
      OrganizationUpdateInputSchema.parse({
        organization_id: "Overclock",
        context: null,
      }).context,
    ).toBeNull();
  });

  it("takes reassign_to and has no force: the column is not nullable", () => {
    const parsed = OrganizationDeleteInputSchema.parse({
      organization_id: "Padre Miguel",
      reassign_to: "Overclock",
    });
    expect(parsed.reassign_to).toBe("Overclock");
    expect(
      OrganizationDeleteInputSchema.safeParse({
        organization_id: "Padre Miguel",
        force: true,
      }).success,
    ).toBe(false);
  });

  it("keeps organization optional on create, so a single-business install is untouched", () => {
    expect(
      ProjectCreateInputSchema.parse({ name: "Agent Board" }).organization,
    ).toBeUndefined();
    expect(
      ProjectCreateInputSchema.parse({
        name: "Agent Board",
        organization: "Overclock",
      }).organization,
    ).toBe("Overclock");
    expect(
      MissionCreateInputSchema.parse({
        title: "Norte",
        organization: "Overclock",
      }).organization,
    ).toBe("Overclock");
  });

  it("accepts the organization filter on every read that lists cards", () => {
    expect(TaskListInputSchema.parse({ organization: "Overclock" }).organization).toBe(
      "Overclock",
    );
    expect(
      TaskSearchInputSchema.parse({ q: "board", organization: "Overclock" })
        .organization,
    ).toBe("Overclock");
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

  it("accepts granular context edits and rejects a blob plus its delta", () => {
    const mission = MissionUpdateInputSchema.parse({
      mission_id: "mission-1",
      context_ops: [
        { op: "replace_section", heading: "Rules", text: "new rules" },
      ],
      expected_hash: "a".repeat(64),
    });
    expect(mission.context_ops?.[0]?.op).toBe("replace_section");

    expect(
      MissionUpdateInputSchema.safeParse({
        mission_id: "mission-1",
        context: "whole blob",
        context_ops: [{ op: "append_line", heading: "Rules", text: "- one" }],
      }).success,
    ).toBe(false);

    const project = ProjectUpdateInputSchema.parse({
      project_id: "OC",
      context_ops: [{ op: "append_section", heading: "Rules", text: "- one" }],
      expected_len: 12,
    });
    expect(project.expected_len).toBe(12);
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

  it("supports compact and explicit full-content read modes", () => {
    const taskGet = toolContracts.task_get.input;
    expect(taskGet.parse({ task_id: "OCL-52" })).toEqual({
      task_id: "OCL-52",
    });
    expect(
      taskGet.parse({
        task_id: "OCL-52",
        view: "briefing",
      }).view,
    ).toBe("briefing");
    expect(
      taskGet.parse({
        task_id: "OCL-52",
        include: ["briefing", "usage_recipe", "mission"],
      }).include,
    ).toEqual(["briefing", "usage_recipe", "mission"]);
    expect(
      toolContracts.mission_get.input.parse({
        mission_id: "mission_1",
        view: "full",
      }).view,
    ).toBe("full");
    expect(
      toolContracts.project_get.input.parse({
        project_id: "OC",
        include: ["context"],
      }).include,
    ).toEqual(["context"]);
    expect(
      taskGet.safeParse({ task_id: "OCL-52", briefing: true }).success,
    ).toBe(false);
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
      commit: "0123456789abcdef0123456789abcdef01234567",
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
    expect(parsed.commit).toBe("0123456789abcdef0123456789abcdef01234567");
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

  it("keeps the reason the usage recipe prints next to estimated", () => {
    const reason =
      "The Grok transcript /missing/updates.jsonl is missing or unreadable. Estimate usage and send estimated: true.";
    const delivered = TaskDeliverInputSchema.parse({
      task_id: "OC-1",
      summary: "transcript ausente",
      usage: { tokens_in: 1000, tokens_out: 200, estimated: true, reason },
    });
    expect(delivered.usage?.reason).toBe(reason);
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

describe("harness account/provider wire contract (OCL-108)", () => {
  it("keeps account optional so a card built before this feature still parses", () => {
    const parsed = HarnessSchema.parse({ model: "sonnet-5", effort: "high" });
    expect(parsed.account).toBeUndefined();
    expect(parsed).not.toHaveProperty("cli");
  });

  it("accepts task_create.harness.account, retrocompatibly optional", () => {
    const withAccount = TaskCreateInputSchema.parse({
      project_id: "AGB",
      title: "test",
      type: "feature",
      o_que: "x",
      por_que: "x",
      como_confirmo: [{ step: "s", expected: "e" }],
      origem: { agent: "test" },
      harness: { cli: "claude-code", model: "sonnet-5", effort: "high", account: "claude-oauth-acc-2" },
    });
    expect(withAccount.harness?.account).toBe("claude-oauth-acc-2");

    const withoutAccount = TaskCreateInputSchema.parse({
      project_id: "AGB",
      title: "test",
      type: "feature",
      o_que: "x",
      por_que: "x",
      como_confirmo: [{ step: "s", expected: "e" }],
      origem: { agent: "test" },
      harness: { cli: "claude-code", model: "sonnet-5", effort: "high" },
    });
    expect(withoutAccount.harness?.account).toBeUndefined();
  });

  it("lets task_update.harness carry an account too", () => {
    const parsed = TaskUpdateInputSchema.parse({
      task_id: "AGB-1",
      harness: { model: "sonnet-5", effort: "high", account: "claude-oauth" },
    });
    expect(parsed.harness?.account).toBe("claude-oauth");
  });

  it("lets a cardápio policy row carry a preferred account", () => {
    const parsed = CardapioPolicyEntrySchema.parse({
      type: "feature",
      cli: "claude-code",
      model: "sonnet-5",
      effort: "high",
      account: "claude-oauth-acc-2",
    });
    expect(parsed.account).toBe("claude-oauth-acc-2");
  });

  it("lets harness_set declare a preferred account", () => {
    const parsed = HarnessSetInputSchema.parse({
      type: "feature",
      model: "sonnet-5",
      effort: "high",
      account: "claude-oauth-acc-2",
    });
    expect(parsed.account).toBe("claude-oauth-acc-2");
  });

  it("exposes the accounts available for a cli, each independently enabled", () => {
    const parsed = ConfiguredExecutorSchema.parse({
      id: "claude-code",
      label: "Claude Code",
      enabled: true,
      models: ["sonnet-5"],
      efforts: {},
      accounts: [
        { id: "claude-oauth", label: "Conta 1", enabled: true },
        { id: "claude-oauth-acc-2", label: "Conta 2", enabled: false },
      ],
    });
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts?.[1]).toEqual({
      id: "claude-oauth-acc-2",
      label: "Conta 2",
      enabled: false,
    });
  });

  it("parses without accounts at all, retrocompatibly", () => {
    const parsed = ConfiguredExecutorSchema.parse({
      id: "codex",
      label: "Codex",
      enabled: true,
      models: ["gpt-5.6-sol"],
      efforts: {},
    });
    expect(parsed.accounts).toBeUndefined();
  });

  it("disables one account without touching the rest of the executor (refines OCL-75)", () => {
    const parsed = ExecutorsUpdateInputSchema.parse({
      cli: "claude-code",
      set_account: { id: "claude-oauth", enabled: false },
    });
    expect(parsed.set_account).toEqual({ id: "claude-oauth", enabled: false });
  });

  it("still refuses an executors_update with nothing to change", () => {
    const empty = ExecutorsUpdateInputSchema.safeParse({ cli: "claude-code" });
    expect(empty.success).toBe(false);
  });

  it("refuses set_account combined with remove, same as the other fields", () => {
    const invalid = ExecutorsUpdateInputSchema.safeParse({
      cli: "claude-code",
      remove: true,
      set_account: { id: "claude-oauth", enabled: false },
    });
    expect(invalid.success).toBe(false);
  });
});

/**
 * OCL-128: `resolved_in` is the release, and only the release. A delivery
 * that put a branch name there leaked it onto the board's RELEASE filter.
 */
describe("resolved_in only takes a release version", () => {
  const branch = "ovka-78-bug-selecao-de-texto-no-pane-anda-com-o-scroll-f@68218bba";

  function deliver(resolved_in: string) {
    return TaskDeliverInputSchema.safeParse({
      task_id: "OC-1",
      summary: "done",
      resolved_in,
    });
  }

  it("task_deliver keeps taking a version tag", () => {
    for (const value of ["v1.4.0", "1.4.0", "v1.0.0-rc.1"]) {
      expect(deliver(value).success, value).toBe(true);
    }
  });

  it("task_deliver refuses a branch name, a commit and free text", () => {
    for (const value of [branch, "main", "feature/ocl-128", "68218bba"]) {
      expect(deliver(value).success, value).toBe(false);
    }
  });

  it("task_update refuses a branch name but still clears with null", () => {
    expect(
      TaskUpdateInputSchema.safeParse({ task_id: "OC-1", resolved_in: branch })
        .success,
    ).toBe(false);
    expect(
      TaskUpdateInputSchema.safeParse({ task_id: "OC-1", resolved_in: "v2.0.0" })
        .success,
    ).toBe(true);
    expect(
      TaskUpdateInputSchema.safeParse({ task_id: "OC-1", resolved_in: null })
        .success,
    ).toBe(true);
  });
});
