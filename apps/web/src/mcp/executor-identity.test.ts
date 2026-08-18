import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_MODEL,
  isExecutorPairConfigured,
  normalizeObservedExecutor,
  resolveClaimExecutor,
} from "./executor-identity";

const sol = { cli: "codex", model: "gpt-5.6-sol" };

describe("executor identity aliases", () => {
  it("uses the confirmed Codex fallbacks", () => {
    expect(resolveClaimExecutor({ cli: "codex", model: "gpt-5" }, null)).toMatchObject({
      model: DEFAULT_CODEX_MODEL,
      model_source: "harness",
    });
    expect(resolveClaimExecutor({ cli: "codex", model: "o4-mini" }, sol)).toMatchObject({
      model: "gpt-5-6-sol",
      model_source: "harness",
    });
  });

  it.each([
    ["gpt-5-codex", "gpt-5-3-codex-spark"],
    ["claude-opus-5", "opus-5"],
    ["claude-fable-5", "fable-5"],
    ["claude-sonnet-5", "sonnet-5"],
    ["kimi", "k3"],
    ["kimi-code/k3", "k3"],
  ])("normalizes declared model %s to %s", (declared, expected) => {
    expect(resolveClaimExecutor({ cli: "other", model: declared }, null)).toMatchObject({
      model: expected,
      model_source: "declared",
    });
  });

  it("resolves CLI aliases and the orchestrator through the harness", () => {
    expect(resolveClaimExecutor({ cli: "Codex CLI", model: "gpt-5" }, sol).cli).toBe(
      "codex",
    );
    expect(
      resolveClaimExecutor(
        { cli: "overclock", model: "claude-fable-5" },
        { cli: "claude-code", model: "fable-5" },
      ).cli,
    ).toBe("claude-code");
  });

  it("does not turn generic connection labels into add suggestions", () => {
    expect(normalizeObservedExecutor({ cli: "codex", model: "gpt-5" })).toBeNull();
    expect(
      normalizeObservedExecutor({ cli: "overclock", model: "gpt-5.6-sol" }),
    ).toBeNull();
    expect(
      normalizeObservedExecutor({ cli: "Codex CLI", model: "gpt-5.6-sol" }),
    ).toEqual({ cli: "codex", model: "gpt-5-6-sol" });
    expect(
      isExecutorPairConfigured(
        [{ id: "codex", enabled: true, models: ["gpt-5.6-sol"] }],
        "Codex CLI",
        "gpt-5-6-sol",
      ),
    ).toBe(true);
  });
});
