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
  commit: null,
  delivery_unverified: false,
  delivery_verification: null,
  delivery_warning: null,
  workspace_id: "ws_1",
  previous_short_ids: [],
  parent_id: null,
  supersedes: null,
  superseded_by: null,
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
  organization_id: "org_1",
  organization_name: "Overclock",
  objective: "Fechar o loop MCP.",
  context: "O board é a fonte de verdade do trabalho.",
};

describe("the organization block", () => {
  it("renders the business context above the project block", () => {
    const md = renderBriefingMarkdown({
      task,
      mission,
      organization: {
        name: "Overclock",
        context: "# Regras do negócio\n\nTudo em português com o cliente.",
      },
      project: {
        name: "OverClick",
        idPrefix: "OC",
        context: "# Regras do repo",
        currentVersion: null,
      },
      branchConvention: branchConvention(task.short_id, task.title),
    });

    expect(md).toContain("- organization: Overclock");
    expect(md).toContain("Tudo em português com o cliente.");
    // The worker reads the rules of the business before the rules of the repo.
    expect(md.indexOf("## Organization context")).toBeLessThan(
      md.indexOf("## Project context"),
    );
  });

  it("says the context is not configured instead of leaving a blank section", () => {
    const md = renderBriefingMarkdown({
      task,
      mission,
      organization: { name: "Padre Miguel", context: null },
      branchConvention: branchConvention(task.short_id, task.title),
    });
    expect(md).toContain("(organization context not configured)");
  });

  it("omits the block entirely when no organization was passed", () => {
    const md = renderBriefingMarkdown({
      task,
      mission,
      branchConvention: branchConvention(task.short_id, task.title),
    });
    expect(md).not.toContain("## Organization context");
  });
});

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

  it("teaches the mission orchestration usage cycle", () => {
    const convention = branchConvention(task.short_id, task.title);
    const md = renderBriefingMarkdown({ task, mission, branchConvention: convention });

    expect(md).toContain("## Mission orchestration telemetry");
    expect(md).toContain("mission_attempt_start");
    expect(md).toContain("mission_report_usage");
    expect(md).toContain('checkpoint: \"rodada\"');
    expect(md).toContain('checkpoint: \"final\"');
    expect(md).toContain("cumulative snapshot since the attempt started");
    expect(md).toContain('"attempt_id": "<attempt>"');
    expect(md).toContain("server's attempt start as the usage boundary");
    expect(md).toContain("never send zero to mean unknown");
    expect(md).toContain('"segments": [{"model": "gpt-5.6-sol"');
    expect(md).toContain("estimated: true");
    expect(md).toContain("unpriced` means the model has no price");
    expect(md).toContain("OCL-11 marks overlapping usage");
    expect(md).toContain("marks overlapping usage `suspect`");
  });

  it("ends with the executor contract so agents know to deliver with usage", () => {
    const convention = branchConvention(task.short_id, task.title);
    const md = renderBriefingMarkdown({ task, mission, branchConvention: convention });

    const contractAt = md.indexOf("## Executor contract");
    expect(contractAt).toBeGreaterThan(-1);
    expect(md.slice(contractAt)).toContain(
      "Before `task_deliver`, create the commit and push it to the remote",
    );
    expect(md.slice(contractAt)).toContain("summary, evidence, commit, branch and usage");
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
    // The fence carries no language: the command is not bash-only any more.
    expect(md.slice(recipeAt, contractAt)).toContain("```");
    expect(md.slice(recipeAt, contractAt)).not.toContain("```bash");
    expect(md.slice(recipeAt, contractAt)).toContain("node -e");
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

  it("lists every comment chronologically right after the contract, with the most-recent-wins rule", () => {
    const convention = branchConvention(task.short_id, task.title);
    const md = renderBriefingMarkdown({
      task,
      mission,
      branchConvention: convention,
      comments: [
        {
          author: "dono@board",
          kind: "comment",
          body: "cadência: 1 post por dia",
          created_at: "2026-08-19T10:00:00.000Z",
        },
        {
          author: "dono@board",
          kind: "report",
          body: "remove o card parcial",
          created_at: "2026-08-19T11:00:00.000Z",
        },
      ],
    });

    const sectionAt = md.indexOf("## Comentários do card");
    expect(sectionAt).toBeGreaterThan(-1);
    expect(md).toContain(
      "comentários abaixo alteram/refinam o contrato acima",
    );
    expect(md).toContain("comentário mais recente vence");
    const firstAt = md.indexOf("cadência: 1 post por dia");
    const secondAt = md.indexOf("remove o card parcial");
    expect(firstAt).toBeGreaterThan(sectionAt);
    expect(secondAt).toBeGreaterThan(firstAt);
    expect(md.indexOf("## Comentários do card")).toBeLessThan(
      md.indexOf("## Harness"),
    );
  });

  it("adds no comments section when the card has none", () => {
    const convention = branchConvention(task.short_id, task.title);
    const md = renderBriefingMarkdown({ task, mission, branchConvention: convention, comments: [] });

    expect(md).not.toContain("## Comentários do card");
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
