import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_MODEL,
  genericCodexModelRefusal,
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

  it("refuses known generic Codex names and names the exact models", () => {
    const message = genericCodexModelRefusal("gpt-5");
    expect(message).toBeTruthy();
    expect(message).toContain("gpt-5.6-sol");
    expect(message).toContain("gpt-5.6-luna");
    expect(message).toContain("gpt-5.6-terra");
    expect(message).toContain("gpt-5.3-codex-spark");
    expect(genericCodexModelRefusal("gpt-daybreak-blue-latest")).toContain(
      "gpt-5.6-sol",
    );
  });

  it("lets priced models and aliases through the generic Codex refusal", () => {
    expect(genericCodexModelRefusal("gpt-5.6-sol")).toBeNull();
    expect(genericCodexModelRefusal("gpt-5-codex")).toBeNull();
    expect(genericCodexModelRefusal("grok-4.6")).toBeNull();
    expect(genericCodexModelRefusal("claude-opus-5")).toBeNull();
    expect(genericCodexModelRefusal(undefined)).toBeNull();
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
