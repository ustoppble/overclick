import { describe, expect, it } from "vitest";
import { factoryUsageRecipes, findUsageRecipe } from "@agent-board/db";
import { branchConvention, type Mission, type Task } from "@agent-board/mcp-core";
import { renderBriefingMarkdown } from "./briefing";

const task: Task = {
  id: "11111111-1111-4111-8111-111111111111",
  short_id: "OC-123",
  title: "Corrige login",
  type: "bug",
  status: "aberto",
  revisado: false,
  priority: "alta",
  project_id: "proj_1",
  mission_id: "miss_1",
  workspace_id: "ws_1",
  previous_short_ids: [],
  parent_id: null,
  reports_count: 0,
  o_que: "O login volta a autenticar.",
  por_que: "Ninguém entra.",
  como_confirmo: [{ step: "abre /login", expected: "entra na home" }],
  harness: { cli: "claude-code", model: "sonnet-5", effort: "medium" },
  origem: { cli: "overclock", session_id: "sess_torre" },
  mode: "solo",
  devolve_para: { kind: "workspace_queue" },
  branch: null,
  pull_request_url: null,
  resolved_in: null,
  reopen_comment: "faltou o teste do login",
  claimed_by: null,
  created_at: "2026-08-14T12:00:00.000Z",
  updated_at: "2026-08-14T12:00:00.000Z",
};

const mission: Mission = {
  id: "miss_1",
  title: "Norte do board",
  status: "ativa",
  objective: "Fechar o loop MCP.",
  context: "O board é a fonte de verdade do trabalho.",
};

describe("self-contained briefing markdown", () => {
  it("embeds contract, harness, mission context and branch convention", () => {
    const convention = branchConvention(task.short_id, task.title);
    const md = renderBriefingMarkdown({ task, mission, branchConvention: convention });

    expect(md).toContain("# OC-123 — Corrige login");
    expect(md).toContain("O login volta a autenticar.");
    expect(md).toContain("Ninguém entra.");
    expect(md).toContain("abre /login");
    expect(md).toContain("entra na home");
    expect(md).toContain("sonnet-5");
    expect(md).toContain("claude-code");
    expect(md).not.toContain("qa-fix-protocol");
    expect(md).not.toMatch(/skills/i);
    expect(md).toContain("Fechar o loop MCP.");
    expect(md).toContain("O board é a fonte de verdade do trabalho.");
    expect(md).toContain(convention.branch);
    expect(md).toContain(convention.commit_prefix);
    expect(md).toContain("faltou o teste do login");
  });

  it("ends with the executor contract so agents know to deliver with usage", () => {
    const convention = branchConvention(task.short_id, task.title);
    const md = renderBriefingMarkdown({ task, mission, branchConvention: convention });

    const contractAt = md.indexOf("## Executor contract");
    expect(contractAt).toBeGreaterThan(-1);
    expect(md.slice(contractAt)).toContain(
      "When done, call `task_deliver` with summary, evidence, branch and usage",
    );
    expect(md.slice(contractAt)).toContain("segments");
    expect(md.slice(contractAt)).toContain("estimated: true");
    expect(md.slice(contractAt)).toContain("never replace a missing model");
    // Nothing after the contract: it must be the last thing the agent reads.
    expect(md.indexOf("## ", contractAt + 1)).toBe(-1);
  });

  it("ends with the collection recipe and then the contract", () => {
    const convention = branchConvention(task.short_id, task.title);
    const recipe = findUsageRecipe(factoryUsageRecipes(), "claude-code");
    const md = renderBriefingMarkdown({
      task,
      mission,
      branchConvention: convention,
      recipe,
    });

    const recipeAt = md.indexOf("## Measuring this run");
    const contractAt = md.indexOf("## Executor contract");
    expect(recipeAt).toBeGreaterThan(-1);
    // Recipe first, contract last: measure, then send.
    expect(recipeAt).toBeLessThan(contractAt);
    expect(md).toContain("CLAUDE_CODE_SESSION_ID");
    expect(md).toContain("cache_read_input_tokens");
    expect(md.slice(recipeAt, contractAt)).toContain("```bash");
  });

  it("names the claim boundary and excludes earlier session work", () => {
    const convention = branchConvention(task.short_id, task.title);
    const claimedAt = "2026-08-18T12:34:56.000Z";
    const md = renderBriefingMarkdown({
      task,
      mission,
      branchConvention: convention,
      claimedAt,
    });

    expect(md).toContain(`claimed_at: \`${claimedAt}\``);
    expect(md).toContain("Count only work recorded at or after claimed_at");
    expect(md).toContain("work before the claim");
  });

  it("tells a stale-claim successor to disclose the takeover on deliver", () => {
    const convention = branchConvention(task.short_id, task.title);
    const md = renderBriefingMarkdown({
      task,
      mission,
      branchConvention: convention,
      reclaimedStale: true,
    });

    expect(md).toContain("## Expired claim takeover");
    expect(md).toContain("claim expired");
    expect(md).toContain("explicitly in `task_deliver`");
    expect(md.indexOf("## Expired claim takeover")).toBeLessThan(
      md.indexOf("## Executor contract"),
    );
  });

  it("falls back to the generic recipe for a CLI nobody wrote one for", () => {
    const convention = branchConvention(task.short_id, task.title);
    const recipe = findUsageRecipe(factoryUsageRecipes(), "some-new-cli");
    expect(recipe?.cli).toBe("generic");
    const md = renderBriefingMarkdown({
      task,
      mission,
      branchConvention: convention,
      recipe,
    });
    // Nothing to run, so the briefing says so instead of showing an empty block.
    expect(md).toContain("(no command for this CLI yet)");
    expect(md).toContain("estimated: true");
  });

  it("renders the Codex measurement fallback without invented model defaults", () => {
    const convention = branchConvention(task.short_id, task.title);
    const recipe = findUsageRecipe(factoryUsageRecipes(), "codex");
    const md = renderBriefingMarkdown({
      task: {
        ...task,
        harness: { cli: "codex", model: "gpt-5.6-sol", effort: "high" },
      },
      mission,
      branchConvention: convention,
      recipe,
    });

    expect(md).toContain("CODEX_HARNESS_MODEL");
    expect(md).toContain(
      "Only a missing or unreadable rollout returns estimated: true",
    );
    expect(md).not.toContain('model = "unknown"');
  });
});
