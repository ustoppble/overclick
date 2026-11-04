import { createHmac } from "node:crypto";
import { project } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_LIMITS } from "../../../../lib/body-limit";
import { closeTestWorld, createTestWorld, type TestWorld } from "../../../../mcp/test-db";

let world: TestWorld;

vi.mock("../../../../lib/db", () => ({
  db: () => world.db,
  getDatabaseUrl: () => "pglite://test",
}));

const { POST } = await import("./route");

const SECRET = "test-only-webhook-secret";

const RELEASE = JSON.stringify({
  action: "published",
  repository: { full_name: "owner/releases" },
  release: {
    id: 7,
    tag_name: "v3.0.0",
    name: "Three",
    body: "- Signed note",
    prerelease: false,
    published_at: "2026-09-24T10:00:00.000Z",
    html_url: "https://github.com/owner/releases/releases/tag/v3.0.0",
  },
  sender: { login: "octocat" },
});

function sign(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function delivery(headers: Record<string, string>, payload = RELEASE): Request {
  return new Request("https://board.example/api/github/release", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "release", ...headers },
    body: payload,
  });
}

async function projectRow() {
  const [row] = await world.db.select().from(project).where(eq(project.id, world.projectId));
  return row;
}

/**
 * OCL-226: the route took any POST that named a project's releases repo and
 * rewrote that project's context and version, with no session and no secret.
 */
describe("POST /api/github/release", () => {
  beforeEach(async () => {
    world = await createTestWorld();
    await world.db
      .update(project)
      .set({
        context: "# Manual",
        contextSource: { releasesRepo: "owner/releases", refresh: "on_release" },
      })
      .where(eq(project.id, world.projectId));
  });

  afterEach(async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    if (world) await closeTestWorld(world);
  });

  it("refuses a delivery with no signature and leaves the project alone", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const before = await projectRow();

    const response = await POST(delivery({}));

    expect(response.status).toBe(401);
    expect(await projectRow()).toEqual(before);
  });

  it("refuses a delivery signed with the wrong secret and leaves the project alone", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const before = await projectRow();

    const response = await POST(delivery({ "x-hub-signature-256": sign("not-the-secret", RELEASE) }));

    expect(response.status).toBe(401);
    expect(await projectRow()).toEqual(before);
  });

  it("refuses a signature over a different body than the one delivered", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const before = await projectRow();

    const response = await POST(
      delivery({ "x-hub-signature-256": sign(SECRET, "{}") }),
    );

    expect(response.status).toBe(401);
    expect(await projectRow()).toEqual(before);
  });

  it("applies a correctly signed release to the project's context and version", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;

    const response = await POST(delivery({ "x-hub-signature-256": sign(SECRET, RELEASE) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, projects: 1 });
    const row = await projectRow();
    expect(row?.currentVersion).toBe("v3.0.0");
    expect(row?.context).toContain("# Manual");
    expect(row?.context).toContain("Signed note");
  });

  it("refuses a body over the ceiling by its Content-Length, even correctly signed", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const before = await projectRow();
    const big = JSON.stringify({ filler: "x".repeat(BODY_LIMITS.githubRelease) });

    const response = await POST(delivery({ "x-hub-signature-256": sign(SECRET, big) }, big));

    expect(response.status).toBe(413);
    expect(await projectRow()).toEqual(before);
  });

  it("cuts a chunked body that has no Content-Length once it passes the ceiling", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    const enc = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(enc.encode("x".repeat(64 * 1024)));
      },
    });
    const request = new Request("https://board.example/api/github/release", {
      method: "POST",
      headers: { "x-github-event": "release", "x-hub-signature-256": sign(SECRET, "{}") },
      body: stream,
      // @ts-expect-error duplex is required by undici for a streamed request body
      duplex: "half",
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    // an endless stream is abandoned a little past the ceiling, not drained
    expect(pulled).toBeLessThan(BODY_LIMITS.githubRelease / (64 * 1024) + 4);
  });

  it("refuses every delivery, signed or not, when the board has no secret", async () => {
    const before = await projectRow();

    const unsigned = await POST(delivery({}));
    const signed = await POST(delivery({ "x-hub-signature-256": sign(SECRET, RELEASE) }));
    process.env.GITHUB_WEBHOOK_SECRET = "   ";
    const blank = await POST(delivery({ "x-hub-signature-256": sign("", RELEASE) }));

    expect(unsigned.status).toBe(503);
    expect(signed.status).toBe(503);
    expect(blank.status).toBe(503);
    expect(await projectRow()).toEqual(before);
  });
});
