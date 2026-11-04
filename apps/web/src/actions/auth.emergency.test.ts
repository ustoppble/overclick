import { TEST_AUTH_SECRET } from "../test-support/auth-secret";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmergencyLogin } from "@agent-board/db/emergency-login";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

let world: TestWorld;
let dir: string;

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

const sessions = vi.hoisted(() => [] as Array<{ userId: string; sessionVersion: number }>);
vi.mock("../lib/cookies", () => ({
  setSession: async (payload: { userId: string; sessionVersion: number }) => {
    sessions.push(payload);
  },
  clearSession: async () => {},
}));

const redirectSpy = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectSpy(url) }));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { emergencyLoginAction } = await import("./auth");

function tokenForm(token: string): FormData {
  const form = new FormData();
  form.set("token", token);
  return form;
}

describe("emergencyLoginAction", () => {
  beforeEach(async () => {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    world = await createTestWorld();
    dir = mkdtempSync(join(tmpdir(), "ocl-emergency-action-"));
    sessions.length = 0;
    redirectSpy.mockClear();
  });

  afterEach(async () => {
    if (world) await closeTestWorld(world);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AUTH_SECRET;
  });

  it("signs the admin in with the same session as any other way in, once", async () => {
    const made = await createEmergencyLogin(world.db, "admin@example.test", { dir });
    if (!made.ok) throw new Error(made.error);
    const token = readFileSync(made.file, "utf8").match(/#([A-Za-z0-9_-]+)/)![1]!;

    await emergencyLoginAction(null, tokenForm(token));
    expect(sessions).toEqual([{ userId: world.adminUserId, sessionVersion: 1 }]);
    expect(redirectSpy).toHaveBeenCalledWith("/board");

    expect(await emergencyLoginAction(null, tokenForm(token))).toEqual({
      error: expect.any(String),
    });
    expect(sessions).toHaveLength(1);
  });

  it("refuses a made-up token and signs nobody in", async () => {
    expect(await emergencyLoginAction(null, tokenForm("made-up"))).toEqual({
      error: expect.any(String),
    });
    expect(sessions).toHaveLength(0);
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});
