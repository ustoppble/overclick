import { describe, expect, it } from "vitest";
import * as identity from "./executor-identity";
import { DEFAULT_CODEX_MODEL, resolveClaimExecutor } from "./executor-identity";

describe("executor identity aliases", () => {
  it("uses the confirmed Codex fallbacks", () => {
    expect(resolveClaimExecutor({ cli: "codex", model: "gpt-5" })).toMatchObject({
      model: DEFAULT_CODEX_MODEL,
      model_source: "harness",
    });
    expect(resolveClaimExecutor({ cli: "codex", model: "o4-mini" })).toMatchObject({
      model: "gpt-5-6-sol",
      model_source: "harness",
    });
  });

  it("records no model for any other generic label (OCL-202: no plan to inherit)", () => {
    const resolved = resolveClaimExecutor({ cli: "claude-code", model: "claude", effort: "max" });
    expect(resolved).not.toHaveProperty("model");
    expect(resolved).not.toHaveProperty("model_source");
    expect(resolved).toMatchObject({ cli: "claude-code", effort: "max" });
  });

  it.each([
    ["gpt-daybreak-blue-latest", "gpt-daybreak-blue-latest"],
    ["gpt-6-astra", "gpt-6-astra"],
    ["gpt-5-codex", "gpt-5-3-codex-spark"],
    ["claude-opus-5", "opus-5"],
    ["claude-fable-5", "fable-5"],
    ["claude-sonnet-5", "sonnet-5"],
    ["kimi", "k3"],
    ["kimi-code/k3", "k3"],
  ])("normalizes declared model %s to %s", (declared, expected) => {
    expect(resolveClaimExecutor({ cli: "other", model: declared })).toMatchObject({
      model: expected,
      model_source: "declared",
    });
  });

  it("resolves CLI aliases and records the orchestrator as it declared itself", () => {
    expect(resolveClaimExecutor({ cli: "Codex CLI", model: "gpt-5" }).cli).toBe("codex");
    expect(resolveClaimExecutor({ cli: "overclock", model: "claude-fable-5" }).cli).toBe(
      "overclock",
    );
  });

  it("accepts a model nobody registered, normalized and recorded as declared", () => {
    // The board records what ran; the Overclock app decides it. A model the
    // workspace never registered is not refused any more: the claim goes
    // through and the normalization keeps Consumo from splitting it in two.
    expect(resolveClaimExecutor({ cli: "grok", model: "grok-4.6", effort: "high" })).toEqual({
      cli: "grok",
      model: "grok-4-6",
      model_source: "declared",
      effort: "high",
    });
    expect(resolveClaimExecutor({ cli: "some-new-cli", model: "whatever-1" })).toMatchObject({
      cli: "some-new-cli",
      model: "whatever-1",
      model_source: "declared",
    });
  });

  it("no longer carries a claim refusal or a catalog check", () => {
    expect(identity).not.toHaveProperty("unregisteredClaimModelRefusal");
    expect(identity).not.toHaveProperty("isExecutorPairConfigured");
    expect(identity).not.toHaveProperty("normalizeObservedExecutor");
  });
});
