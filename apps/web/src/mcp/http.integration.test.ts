import { afterEach, describe, expect, it } from "vitest";
import { project } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { BODY_LIMITS } from "../lib/body-limit";
import { handleMcpRequest } from "./http";
import { closeTestWorld, createTestWorld, type TestWorld } from "./test-db";

function initializeBody() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "overclick-test", version: "0.0.0" },
    },
  };
}

describe("HTTP /mcp auth", () => {
  let world: TestWorld;

  afterEach(async () => {
    if (world) await closeTestWorld(world);
  });

  it("returns 401 when the bearer token was revoked", async () => {
    world = await createTestWorld();
    const response = await handleMcpRequest(
      new Request("http://board.local/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${world.revokedSecret}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(initializeBody()),
      }),
      { db: world.db },
    );
    expect(response.status).toBe(401);
    const json = (await response.json()) as { error: { code: string } };
    expect(json.error.code).toBe("TOKEN_REVOKED");
  });

  // OCL-214: a stateless server has no stream to offer. Answering GET with an
  // event stream that ends at once made every live client reconnect in a loop
  // (about 12 GETs a second in production), each one rebuilding the server.
  it("answers GET with 405 so clients do not reopen an empty event stream", async () => {
    world = await createTestWorld();
    const response = await handleMcpRequest(
      new Request("http://board.local/mcp", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${world.secret}`,
          Accept: "text/event-stream",
        },
      }),
      { db: world.db },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
  });

  it("returns 401 when the token is missing", async () => {
    world = await createTestWorld();
    const response = await handleMcpRequest(
      new Request("http://board.local/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(initializeBody()),
      }),
      { db: world.db },
    );
    expect(response.status).toBe(401);
  });

  it("initializes over streamable HTTP with a live token", async () => {
    world = await createTestWorld();
    const response = await handleMcpRequest(
      new Request("http://board.local/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${world.secret}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(initializeBody()),
      }),
      { db: world.db },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      result?: { serverInfo?: { name: string } };
    };
    expect(json.result?.serverInfo?.name).toBe("overclick");
  });

  it("allows stateless hook clients to call task_list directly", async () => {
    world = await createTestWorld();
    const response = await handleMcpRequest(
      new Request("about:blank", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${world.secret}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "hook-test",
          method: "tools/call",
          params: { name: "task_list", arguments: { status: "aberto" } },
        }),
      }),
      { db: world.db },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      result?: {
        structuredContent?: { tasks?: unknown[] };
        content?: Array<{ text?: string }>;
      };
    };
    const payload =
      json.result?.structuredContent ??
      JSON.parse(json.result?.content?.[0]?.text ?? "{}");
    expect(Array.isArray(payload.tasks)).toBe(true);
  });

  it("ships instructions that open with the board identity", async () => {
    world = await createTestWorld();
    const response = await handleMcpRequest(
      new Request("http://board.local/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${world.secret}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(initializeBody()),
      }),
      { db: world.db },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      result?: { instructions?: string };
    };
    const instructions = json.result?.instructions ?? "";
    // A fresh agent must learn, before any tool call, where it is and what
    // registering an activity means.
    expect(
      instructions.startsWith(
        "OverClick is the task board where agents claim and deliver cards (not Overclock the IDE); registering activities means task_create here.",
      ),
    ).toBe(true);
  });

  it("summarizes documented projects in initialize instructions", async () => {
    world = await createTestWorld();
    await world.db
      .update(project)
      .set({ context: "# Architecture\n\nThe web app owns the MCP endpoint." })
      .where(eq(project.id, world.projectId));

    const response = await handleMcpRequest(
      new Request("http://board.local/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${world.secret}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(initializeBody()),
      }),
      { db: world.db },
    );
    const json = (await response.json()) as {
      result?: { instructions?: string };
    };
    const instructions = json.result?.instructions ?? "";
    expect(instructions).toContain("OverClick (OC)");
    expect(instructions).toContain("Architecture");
    expect(instructions).toContain("Use project_get");
  });
});

function mcpPost(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("http://board.local/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

describe("HTTP /mcp edge limits", () => {
  let world: TestWorld;

  afterEach(async () => {
    delete process.env.OVERCLICK_TRUSTED_PROXY;
    if (world) await closeTestWorld(world);
  });

  it("refuses a Content-Length over the ceiling with 413, before the token is looked up", async () => {
    world = await createTestWorld();
    const big = JSON.stringify({ filler: "x".repeat(BODY_LIMITS.mcp) });
    const response = await handleMcpRequest(
      mcpPost(big, { Authorization: `Bearer ${world.secret}` }),
      { db: world.db },
    );
    expect(response.status).toBe(413);
  });

  it("cuts a chunked body with no Content-Length once it passes the ceiling", async () => {
    world = await createTestWorld();
    const enc = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(enc.encode("x".repeat(256 * 1024)));
      },
    });
    const request = new Request("http://board.local/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${world.secret}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: stream,
      // @ts-expect-error duplex is required by undici for a streamed request body
      duplex: "half",
    });
    const response = await handleMcpRequest(request, { db: world.db });
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(BODY_LIMITS.mcp / (256 * 1024) + 4);
  });

  it("refuses a batch with more messages than the ceiling", async () => {
    world = await createTestWorld();
    const batch = Array.from({ length: BODY_LIMITS.mcpBatch + 1 }, (_, id) => ({
      jsonrpc: "2.0",
      id,
      method: "ping",
    }));
    const response = await handleMcpRequest(
      mcpPost(JSON.stringify(batch), { Authorization: `Bearer ${world.secret}` }),
      { db: world.db },
    );
    expect(response.status).toBe(413);
  });

  it("still serves a batch inside the ceiling", async () => {
    world = await createTestWorld();
    const response = await handleMcpRequest(
      mcpPost(JSON.stringify([{ ...initializeBody(), id: 1 }]), {
        Authorization: `Bearer ${world.secret}`,
      }),
      { db: world.db },
    );
    expect(response.status).toBe(200);
  });

  it("answers 429 to an origin that keeps presenting invalid tokens, and still lets a good token through", async () => {
    world = await createTestWorld();
    process.env.OVERCLICK_TRUSTED_PROXY = "1";
    const bad = (ip: string) =>
      handleMcpRequest(
        mcpPost(JSON.stringify(initializeBody()), {
          Authorization: "Bearer ocl_not-a-real-token",
          "x-forwarded-for": ip,
        }),
        { db: world.db },
      );

    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await bad("198.51.100.7")).status);
    expect(statuses[0]).toBe(401);
    expect(statuses.at(-1)).toBe(429);
    const limited = await bad("198.51.100.7");
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);

    // another origin is not touched by it
    expect((await bad("198.51.100.8")).status).toBe(401);

    // and the drained origin's good token is not a failure to count
    const good = await handleMcpRequest(
      mcpPost(JSON.stringify(initializeBody()), {
        Authorization: `Bearer ${world.secret}`,
        "x-forwarded-for": "198.51.100.7",
      }),
      { db: world.db },
    );
    expect(good.status).toBe(200);
  });
});
