import { mcpToken } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPairingCode, exchangePairingCode } from "../lib/pairing";
import { authenticateBearer } from "../mcp/auth";
import { closeTestWorld, createTestWorld, type TestWorld } from "../mcp/test-db";

let world: TestWorld;

/** Any signed-in human: the action only asks that a session exists. */
const OWNER_ID = "00000000-0000-4000-8000-000000000001";

vi.mock("../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

vi.mock("../lib/cookies", () => ({
  getSession: async () => ({ userId: OWNER_ID, sessionVersion: 1, email: "owner@example.com" }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { setTokenManageAction } = await import("./tokens");

/**
 * OCL-136 (issue #71): the manage flag could only be decided on the manual
 * "generate token" form, and pairing — which is how the plugin installs —
 * always produced a token without it. So the MCP refusal asked the user for a
 * permission that no control on the board could grant, and harness_set was
 * unreachable for anyone who paired.
 */
describe("granting manage on an existing token", () => {
  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  async function pairToken(label: string): Promise<string> {
    const code = await createPairingCode(world.db, {
      workspaceId: world.workspaceId,
      label,
    });
    const paired = await exchangePairingCode(world.db, code.code, "198.51.100.4");
    if (!paired.ok) throw new Error("pairing failed");
    return paired.token;
  }

  it("turns a freshly paired worker token into a manage token", async () => {
    world = await createTestWorld();
    const secret = await pairToken("claude code on this machine");

    // The state the bug report starts from: brand new token, no manage.
    const before = await authenticateBearer(world.db, `Bearer ${secret}`);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.ctx.canManage).toBe(false);

    const granted = await setTokenManageAction(before.ctx.tokenId, true);
    expect(granted).toEqual({ ok: true });

    const after = await authenticateBearer(world.db, `Bearer ${secret}`);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.ctx.canManage).toBe(true);
  });

  it("takes the capability back", async () => {
    world = await createTestWorld();
    const off = await setTokenManageAction(world.manageTokenId, false);
    expect(off).toEqual({ ok: true });

    const [row] = await world.db
      .select({ canManage: mcpToken.canManage })
      .from(mcpToken)
      .where(eq(mcpToken.id, world.manageTokenId));
    expect(row?.canManage).toBe(false);
  });

  it("refuses to hand the capability to a revoked token", async () => {
    world = await createTestWorld();
    const result = await setTokenManageAction(world.revokedTokenId, true);
    expect(result.ok).toBe(false);

    const [row] = await world.db
      .select({ canManage: mcpToken.canManage })
      .from(mcpToken)
      .where(eq(mcpToken.id, world.revokedTokenId));
    expect(row?.canManage).toBe(false);
  });
});
