import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import {
  cardapioEntry,
  executionAttempt,
  handoff,
  mcpToken,
  mission,
  project,
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
    expect(getTableName(mission)).toBe("mission");
    expect(getTableName(project)).toBe("project");
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
        "boardProjectId",
        "boardMissionId",
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
        "idPrefix",
        "nextNumber",
        "createdAt",
        "updatedAt",
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
