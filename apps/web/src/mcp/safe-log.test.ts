import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, logToolFailure } from "./safe-log";
import { invokeTool } from "./tools";
import type { AuthContext, McpDatabase } from "./types";

const driverError = () => {
  const cause = Object.assign(new Error('relation "task" does not exist for someone@example.test'), {
    name: "PostgresError",
    code: "42P01",
  });
  return new Error('Failed query: select * from "task" where "email" = $1\nparams: someone@example.test', { cause });
};

describe("logging a failed tool call", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("describes the error without its message, SQL, params or stack", () => {
    const line = describeError("task_list", driverError(), "ref12345");
    expect(line).toBe("operation=task_list type=Error code=42P01 ref=ref12345");
  });

  it("logs only the safe line in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logToolFailure("task_list", driverError(), "ref12345");
    expect(spy).toHaveBeenCalledTimes(1);
    const printed = spy.mock.calls[0]!;
    expect(printed).toHaveLength(1);
    expect(String(printed[0])).toBe("[mcp] tool failed: operation=task_list type=Error code=42P01 ref=ref12345");
  });

  it("keeps the raw error out of the answer and out of the production log when a tool throws", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = driverError();
    const db = new Proxy({}, { get: () => { throw boom; } }) as unknown as McpDatabase;
    const ctx = { tokenId: "t", workspaceId: "w", tokenLabel: "x", userId: "u", role: "admin" } as AuthContext;
    const result = await invokeTool(db, ctx, "task_list", {});
    expect(result.ok).toBe(false);
    const answer = result.ok ? "" : `${result.error.code} ${result.error.message} ${JSON.stringify(result.error.details ?? null)}`;
    const logged = spy.mock.calls.flat().map(String).join(" ");
    for (const leaked of ["select *", "params", "someone@example.test", "$1", "does not exist"]) {
      expect(answer).not.toContain(leaked);
      expect(logged).not.toContain(leaked);
    }
    expect(logged).toMatch(/operation=task_list type=Error code=42P01 ref=[0-9a-f]{8}/);
    const ref = /ref=([0-9a-f]{8})/.exec(logged)?.[1];
    expect(answer).toContain(ref);
  });
});
