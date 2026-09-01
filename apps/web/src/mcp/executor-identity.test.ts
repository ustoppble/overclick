import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_MODEL,
  isExecutorPairConfigured,
  normalizeObservedExecutor,
  resolveClaimExecutor,
  unregisteredClaimModelRefusal,
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

  const executors = [
    {
      id: "codex",
      label: "Codex",
      enabled: true,
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.3-codex-spark"],
    },
    { id: "grok", label: "Grok", enabled: true, models: ["grok-4.6", "grok-4.5"] },
  ];

  it("refuses a model that is not on any configured executor, for a cli the board knows", () => {
    const message = unregisteredClaimModelRefusal("grok", "grok-4", executors);
    expect(message).toBeTruthy();
    expect(message).toContain("grok-4");
    expect(message).toContain("grok-4.6");
    expect(message).toContain("grok-4.5");
    expect(message).toContain("executors_update");
  });

  it("lets registered models and their aliases through", () => {
    expect(unregisteredClaimModelRefusal("codex", "gpt-5.6-sol", executors)).toBeNull();
    expect(unregisteredClaimModelRefusal("codex", "gpt-5-codex", executors)).toBeNull();
    expect(unregisteredClaimModelRefusal("grok", "grok-4.6", executors)).toBeNull();
    expect(unregisteredClaimModelRefusal("codex", undefined, executors)).toBeNull();
  });

  it("leaves generic placeholder labels alone: resolveClaimExecutor handles those", () => {
    expect(unregisteredClaimModelRefusal("codex", "gpt-5", executors)).toBeNull();
    expect(unregisteredClaimModelRefusal("codex", "", executors)).toBeNull();
  });

  it("refuses a cli the workspace has not configured yet, and says which are", () => {
    // The first cut let an unknown cli through so the board could discover it
    // from the claim itself. That kept the guarantee at "for the CLIs you
    // already use": a made-up model under a made-up cli is exactly as invented
    // as one under a known cli, only harder to notice. A connection is learned
    // when a human registers it, not when an agent asserts it.
    const refusal = unregisteredClaimModelRefusal(
      "some-new-cli",
      "whatever-1",
      executors,
    );
    expect(refusal).toContain("some-new-cli");
    expect(refusal).toContain("executors_update");
  });

  it("lets anything through on a board with nothing registered yet", () => {
    // No catalog to pick from is a fresh board, not a bad claim: refusing
    // every claim would leave no way in at all.
    expect(unregisteredClaimModelRefusal("codex", "gpt-9-ultra", [])).toBeNull();
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
