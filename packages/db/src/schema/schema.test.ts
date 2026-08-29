import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import {
  cardapioEntry,
  executionAttempt,
  handoff,
  mcpToken,
  mission,
  missionAttempt,
  missionAttemptReport,
  organization,
  project,
  projectContextAudit,
  task,
  taskComment,
  user,
  workspace,
} from "./index";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.keys(getTableColumns(table));
}

describe("complete schema from spec §3", () => {
  it("exposes every entity as a table", () => {
    expect(getTableName(workspace)).toBe("workspace");
    expect(getTableName(user)).toBe("user");
    expect(getTableName(organization)).toBe("organization");
    expect(getTableName(mission)).toBe("mission");
    expect(getTableName(missionAttempt)).toBe("mission_attempt");
    expect(getTableName(missionAttemptReport)).toBe("mission_attempt_report");
    expect(getTableName(project)).toBe("project");
    expect(getTableName(projectContextAudit)).toBe("project_context_audit");
    expect(getTableName(task)).toBe("task");
    expect(getTableName(executionAttempt)).toBe("execution_attempt");
    expect(getTableName(handoff)).toBe("handoff");
    expect(getTableName(mcpToken)).toBe("mcp_token");
    expect(getTableName(taskComment)).toBe("task_comment");
    expect(getTableName(cardapioEntry)).toBe("cardapio_entry");
  });

  it("cardapio_entry is type → CLI · model · effort with no skills column", () => {
    expect(columnNames(cardapioEntry)).toEqual(
      expect.arrayContaining([
        "id",
        "workspaceId",
        "activityType",
        "cli",
        "model",
        "effort",
      ]),
    );
    expect(columnNames(cardapioEntry)).not.toContain("skills");
  });

  it("keeps effort provider-specific by storing it as text", () => {
    expect(getTableColumns(cardapioEntry).effort.getSQLType()).toBe("text");
  });

  it("workspace holds name, executor config and cardápio", () => {
    expect(columnNames(workspace)).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "executors",
        "cardapio",
        "claimTimeoutMinutes",
        "createdAt",
        "updatedAt",
      ]),
    );
  });

  it("user is local auth only: email + password hash", () => {
    const cols = columnNames(user);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "email",
        "passwordHash",
        "active",
        "sessionVersion",
        "boardProjectId",
        "boardMissionId",
        "boardResolvedIn",
        "createdAt",
      ]),
    );
    expect(cols).not.toContain("phone");
    expect(cols).not.toContain("company");
    expect(cols).not.toContain("howHeard");
    expect(cols).not.toContain("emailVerified");
    expect(cols).not.toContain("emailVerifiedAt");
  });

  it("mission carries title, markdown context and status", () => {
    expect(columnNames(mission)).toEqual(
      expect.arrayContaining([
        "id",
        "workspaceId",
        "title",
        "objective",
        "context",
        "status",
        "createdAt",
        "updatedAt",
      ]),
    );
  });

  it("project is the work unit ↔ repo with an ID prefix", () => {
    expect(columnNames(project)).toEqual(
      expect.arrayContaining([
        "id",
        "workspaceId",
        "name",
        "repoUrl",
        "contextSource",
        "latestPrerelease",
        "contextUpdatedAt",
        "idPrefix",
        "nextNumber",
        "createdAt",
        "updatedAt",
      ]),
    );
  });

  it("project context audit keeps source, actor and idempotency reference", () => {
    expect(columnNames(projectContextAudit)).toEqual(
      expect.arrayContaining([
        "projectId",
        "source",
        "sourceRef",
        "version",
        "prerelease",
        "summary",
        "actor",
        "createdAt",
      ]),
    );
  });

  it("task has the full card contract from §3.1", () => {
    expect(columnNames(task)).toEqual(
      expect.arrayContaining([
        "id",
        "projectId",
        "missionId",
        "parentId",
        "shortId",
        "title",
        "oQue",
        "porQue",
        "comoConfirmo",
        "tipo",
        "status",
        "revisado",
        "priority",
        "devolveParaKind",
        "devolveParaUserId",
        "devolveParaAgentRef",
        "harness",
        "branch",
        "prUrl",
        "commitHash",
        "deliveryUnverified",
        "deliveryVerification",
        "deliveryWarning",
        "origin",
        "mode",
        "telemetryIncomplete",
        "isExample",
        "claimedAt",
        "claimedByExecutor",
        "claimedByTokenId",
        "createdByUserId",
        "createdAt",
        "updatedAt",
      ]),
    );
  });

  it("execution_attempt stores usage: tokens in/out/cache, cost, duration, turns", () => {
    expect(columnNames(executionAttempt)).toEqual(
      expect.arrayContaining([
        "id",
        "taskId",
        "executor",
        "model",
        "modelSource",
        "sessionId",
        "startedAt",
        "lastActivityAt",
        "finishedAt",
        "tokensIn",
        "tokensOut",
        "tokensCache",
        "reportedCostUsd",
        "costUsd",
        "costSource",
        "costStatus",
        "costUnpricedModels",
        "costBreakdown",
        "durationMs",
        "turns",
        "usageSuspect",
        "usageSuspectReason",
        "deliveryUnverified",
        "deliveryVerification",
        "deliveryWarning",
        "result",
        "resultNote",
      ]),
    );
  });

  it("mission_attempt stores the orchestration lifecycle and frozen cost snapshot", () => {
    expect(columnNames(missionAttempt)).toEqual(
      expect.arrayContaining([
        "id",
        "missionId",
        "projectId",
        "executor",
        "model",
        "modelSource",
        "sessionId",
        "transcript",
        "status",
        "startedAt",
        "lastActivityAt",
        "finishedAt",
        "usageSegments",
        "tokensIn",
        "tokensOut",
        "tokensCache",
        "durationMs",
        "serverDurationMs",
        "turns",
        "usageEstimated",
        "reportedCostUsd",
        "costUsd",
        "costSource",
        "costStatus",
        "costUnpricedModels",
        "costBreakdown",
        "usageSuspect",
        "usageSuspectReason",
        "result",
        "resultNote",
        "lastReportSequence",
      ]),
    );
  });

  it("mission_attempt_report stores cumulative checkpoints and derived totals", () => {
    expect(columnNames(missionAttemptReport)).toEqual(
      expect.arrayContaining([
        "id",
        "missionAttemptId",
        "sequence",
        "capturedAt",
        "checkpoint",
        "usageSegments",
        "tokensIn",
        "tokensOut",
        "tokensCache",
        "durationMs",
        "turns",
        "estimated",
        "result",
        "resultNote",
      ]),
    );
  });

  it("handoff stores summary, evidences, artifacts and usage", () => {
    expect(columnNames(handoff)).toEqual(
      expect.arrayContaining([
        "id",
        "taskId",
        "attemptId",
        "summary",
        "evidences",
        "artifacts",
        "branch",
        "prUrl",
        "commitHash",
        "deliveryUnverified",
        "deliveryVerification",
        "deliveryWarning",
        "usage",
        "createdAt",
      ]),
    );
  });

  it("mcp_token stores label, hash and revoked", () => {
    expect(columnNames(mcpToken)).toEqual(
      expect.arrayContaining([
        "id",
        "workspaceId",
        "label",
        "hash",
        "tokenPrefix",
        "revoked",
        "revokedAt",
        "lastUsedAt",
        "createdByUserId",
        "createdAt",
      ]),
    );
  });
});

describe("organization layer", () => {
  it("organization belongs to a workspace and carries its own context", () => {
    expect(columnNames(organization)).toEqual([
      "id",
      "workspaceId",
      "name",
      "context",
      "createdAt",
      "updatedAt",
    ]);
  });

  it("project and mission each point at exactly one organization", () => {
    expect(columnNames(project)).toContain("organizationId");
    expect(columnNames(mission)).toContain("organizationId");
    expect(getTableColumns(project).organizationId.notNull).toBe(true);
    expect(getTableColumns(mission).organizationId.notNull).toBe(true);
  });
});
