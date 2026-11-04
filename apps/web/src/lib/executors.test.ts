import { describe, expect, it } from "vitest";
import { EXECUTOR_CATALOG, resolveCatalogCli } from "./executors";

describe("executor catalog", () => {
  it("ships the 10 known CLIs, no repeated ids", () => {
    expect(EXECUTOR_CATALOG).toHaveLength(10);
    expect(new Set(EXECUTOR_CATALOG.map((d) => d.id)).size).toBe(10);
    expect(EXECUTOR_CATALOG.every((d) => d.models.length > 0)).toBe(true);
    expect(EXECUTOR_CATALOG.find((d) => d.id === "codex")?.models).toContain(
      "gpt-reserve",
    );
  });
});

describe("resolving the names agents send", () => {
  it("resolves the names agents actually send to catalog ids", () => {
    expect(resolveCatalogCli("claude")).toBe("claude-code");
    expect(resolveCatalogCli("Claude-Code")).toBe("claude-code");
    expect(resolveCatalogCli("gemini")).toBe("gemini-cli");
    expect(resolveCatalogCli("codex")).toBe("codex");
    expect(resolveCatalogCli("some-new-cli")).toBeNull();
    expect(resolveCatalogCli("  ")).toBeNull();
  });

  it("maps grok-cli, codex-cli and kimi-code to catalog ids", () => {
    expect(resolveCatalogCli("grok-cli")).toBe("grok");
    expect(resolveCatalogCli("codex-cli")).toBe("codex");
    expect(resolveCatalogCli("kimi-code")).toBe("kimi");
  });
});
