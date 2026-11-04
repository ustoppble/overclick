import { describe, expect, it } from "vitest";
import { modelHarness } from "./model-harness";

describe("which CLI and effort ran each model (Consumo, Por modelo)", () => {
  it("reads both from the executor the claim recorded", () => {
    const map = modelHarness([
      { model: "opus-5", executor: JSON.stringify({ cli: "claude-code", effort: "high" }) },
      { model: "opus-5", executor: JSON.stringify({ cli: "claude-code", effort: "medium" }) },
      { model: "gpt-5-6-sol", executor: JSON.stringify({ cli: "codex" }) },
    ]);
    expect(map.get("opus-5")).toEqual({ clis: ["claude-code"], efforts: ["high", "medium"] });
    expect(map.get("gpt-5-6-sol")).toEqual({ clis: ["codex"], efforts: [] });
  });

  it("groups a model by its canonical key, as the table does", () => {
    const map = modelHarness([
      { model: "claude-opus-5", executor: JSON.stringify({ cli: "claude-code", effort: "high" }) },
      { model: "opus-5", executor: JSON.stringify({ cli: "claude-code", effort: "high" }) },
    ]);
    expect([...map.keys()]).toEqual(["opus-5"]);
    expect(map.get("opus-5")?.efforts).toEqual(["high"]);
  });

  it("an executor stored as a bare name is the CLI, with no effort", () => {
    const map = modelHarness([{ model: "opus-5", executor: "claude" }]);
    expect(map.get("opus-5")).toEqual({ clis: ["claude-code"], efforts: [] });
  });

  it("a row with no model or no executor says nothing, and does not throw", () => {
    const map = modelHarness([
      { model: null, executor: JSON.stringify({ cli: "codex" }) },
      { model: "opus-5", executor: null },
    ]);
    expect(map.get("opus-5")).toEqual({ clis: [], efforts: [] });
    expect(map.size).toBe(1);
  });
});
