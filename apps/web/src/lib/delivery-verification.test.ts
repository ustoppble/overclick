import { describe, expect, it } from "vitest";
import { DELIVERY_UNVERIFIED_WARNING, verifyDelivery } from "./delivery-verification";

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 404,
    headers: { "content-type": "application/json" },
  });
}

describe("verifyDelivery", () => {
  it("does not verify or flag a project without a remote", async () => {
    const result = await verifyDelivery({
      repoUrl: null,
      commit: "abc123",
      branch: "main",
    });

    expect(result).toEqual({
      status: null,
      unverified: false,
      warning: null,
    });
  });

  it("verifies a commit that the GitHub branch contains", async () => {
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/commits/abc123")) return response({ sha: "abc123" });
      if (url.endsWith("/branches/main")) {
        return response({ commit: { sha: "abc123" } });
      }
      throw new Error("unexpected GitHub request");
    };

    await expect(
      verifyDelivery(
        {
          repoUrl: "https://github.com/example/board.git",
          commit: "abc123",
          branch: "main",
        },
        { fetch },
      ),
    ).resolves.toEqual({ status: "verified", unverified: false, warning: null });
  });

  it.each([404, 422])("accepts a fake commit but marks the delivery unverified (%s)", async (status) => {
    const result = await verifyDelivery(
      {
        repoUrl: "https://github.com/example/board",
        commit: "deadbeef",
        branch: "main",
      },
      { fetch: async (url) => String(url).includes("/commits/")
        ? Response.json({ message: "No commit found" }, { status })
        : response({ id: 1 }) },
    );

    expect(result).toEqual({
      status: "unverified",
      unverified: true,
      warning: DELIVERY_UNVERIFIED_WARNING,
    });
  });

  it("marks a remote project without a commit as unverified", async () => {
    const result = await verifyDelivery({
      repoUrl: "https://github.com/example/board",
      branch: "main",
    });

    expect(result).toEqual({
      status: "unverified",
      unverified: true,
      warning: DELIVERY_UNVERIFIED_WARNING,
    });
  });

  it.each([401, 403, 404, 429, 500, 503])("does not report an absent commit when GitHub is inaccessible (%s)", async (status) => {
    const result = await verifyDelivery(
      { repoUrl: ["https:/", "github.com", "example", "private-repo"].join("/"), commit: "832022f5f", branch: "feat/motion-dna" },
      { fetch: async () => Response.json({ message: "Unavailable" }, { status }) },
    );
    expect(result.unverified).toBe(true);
    expect(result.warning).not.toBe(DELIVERY_UNVERIFIED_WARNING);
    expect(result.warning).toContain("não foi possível verificar");
  });

  it("does not report an absent commit after a network failure", async () => {
    const result = await verifyDelivery(
      { repoUrl: ["https:/", "github.com", "example", "repo"].join("/"), commit: "832022f5f", branch: "main" },
      { fetch: async () => { throw new Error("network unavailable"); } },
    );
    expect(result.unverified).toBe(true);
    expect(result.warning).toContain("não foi possível verificar");
  });

  it("uses ls-remote and an ancestry check for a generic remote", async () => {
    const calls: string[][] = [];
    const result = await verifyDelivery(
      {
        repoUrl: "https://git.example.com/test-remote.git",
        commit: "abc123",
        branch: "main",
      },
      {
        lookup: async () => ["140.82.112.3"],
        git: async (args) => {
          calls.push(args);
          if (args.includes("ls-remote")) return "def456\trefs/heads/main\n";
          return "";
        },
      },
    );

    expect(result).toEqual({ status: "verified", unverified: false, warning: null });
    expect(calls[0]!.slice(-5)).toEqual([
      "ls-remote",
      "--refs",
      "--",
      "https://git.example.com/test-remote.git",
      "refs/heads/main",
    ]);
    expect(calls.some((args) => args.includes("merge-base"))).toBe(true);
  });
});
