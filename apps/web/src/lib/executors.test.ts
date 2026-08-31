import { describe, expect, it } from "vitest";
import {
  CUSTOM_EXECUTOR_ID,
  EXECUTOR_CATALOG,
  addModelToSelection,
  applyExecutorUpdate,
  cardapioLabel,
  isPairInConfig,
  learnedExecutorDefs,
  modelsForCli,
  removeModelFromSelection,
  resolveCatalogCli,
  selectionFromConfig,
} from "./executors";

describe("executor catalog", () => {
  it("ships the 10 onboarding CLIs, no repeated ids", () => {
    expect(EXECUTOR_CATALOG).toHaveLength(10);
    expect(new Set(EXECUTOR_CATALOG.map((d) => d.id)).size).toBe(10);
    expect(EXECUTOR_CATALOG.every((d) => d.models.length > 0)).toBe(true);
  });
});

describe("selectionFromConfig", () => {
  it("ignores disabled executors and empty non-catalog entries", () => {
    const sel = selectionFromConfig([
      { id: "claude-code", label: "Claude Code", enabled: true, models: ["fable-5"] },
      { id: "codex", label: "Codex", enabled: false, models: ["gpt-5.6-sol"] },
      { id: "aider", label: "Aider", enabled: true, models: [] },
    ]);
    expect(sel.enabled).toEqual({ "claude-code": ["fable-5"] });
    expect(sel.labels).toEqual({});
  });

  it("keeps executors learned from real connections and their labels", () => {
    const sel = selectionFromConfig([
      { id: "aider", label: "aider", enabled: true, models: ["aider-pro"], catalog: ["aider-pro"] },
    ]);
    expect(sel.enabled.aider).toEqual(["aider-pro"]);
    expect(sel.labels.aider).toBe("aider");
    expect(learnedExecutorDefs(sel)).toEqual([
      { id: "aider", label: "aider", models: ["aider-pro"] },
    ]);
  });

  it("falls back to the catalog's first model when the config came without one", () => {
    const sel = selectionFromConfig([
      { id: "grok", label: "Grok", enabled: true, models: [] },
    ]);
    expect(sel.enabled.grok).toEqual(["grok-4.6"]);
  });

  it("recognizes the custom CLI and keeps the user-given name", () => {
    const sel = selectionFromConfig([
      { id: CUSTOM_EXECUTOR_ID, label: "Our internal agent", enabled: true, models: [] },
    ]);
    expect(sel.customEnabled).toBe(true);
    expect(sel.customName).toBe("Our internal agent");
  });

  it("does not treat the generic MCP factory label as a chosen name", () => {
    for (const label of ["Other (generic MCP)", "Outro (MCP genérico)"]) {
      const sel = selectionFromConfig([
        { id: CUSTOM_EXECUTOR_ID, label, enabled: true, models: [] },
      ]);
      expect(sel.customEnabled).toBe(true);
      expect(sel.customName).toBe("");
    }
  });

  it("does not leak the config's models array reference", () => {
    const models = ["fable-5"];
    const sel = selectionFromConfig([
      { id: "claude-code", label: "Claude Code", enabled: true, models },
    ]);
    sel.enabled["claude-code"]?.push("haiku-4-5");
    expect(models).toEqual(["fable-5"]);
  });
});

describe("editable model catalog", () => {
  it("seeds the editable list from the built-in suggestion on a fresh config", () => {
    const sel = selectionFromConfig([]);
    expect(sel.models.grok).toEqual(["grok-4.6", "grok-4.5", "grok-composer-2.5-fast"]);
    expect(sel.models["claude-code"]).toEqual(EXECUTOR_CATALOG[0]?.models);
  });

  it("keeps custom checked models from a config saved before the catalog field", () => {
    const sel = selectionFromConfig([
      { id: "grok", label: "Grok", enabled: true, models: ["grok-4.6", "grok-5-beta"] },
    ]);
    expect(sel.models.grok).toContain("grok-5-beta");
    expect(sel.enabled.grok).toEqual(["grok-4.6", "grok-5-beta"]);
  });

  it("honors a persisted catalog even when it drops built-in suggestions", () => {
    const sel = selectionFromConfig([
      { id: "grok", label: "Grok", enabled: true, models: [], catalog: ["grok-5"] },
    ]);
    expect(sel.models.grok).toEqual(["grok-5"]);
    expect(sel.enabled.grok).toEqual(["grok-5"]);
  });

  it("addModelToSelection trims, dedupes and checks the model on an enabled CLI", () => {
    const base = selectionFromConfig([
      { id: "grok", label: "Grok", enabled: true, models: ["grok-4.6"] },
    ]);
    const added = addModelToSelection(base, "grok", "  grok-4.7  ");
    expect(added.models.grok).toContain("grok-4.7");
    expect(added.enabled.grok).toContain("grok-4.7");
    expect(addModelToSelection(added, "grok", "grok-4.7").models.grok).toEqual(
      added.models.grok,
    );
    expect(addModelToSelection(added, "grok", "   ")).toBe(added);
  });

  it("removeModelFromSelection drops the chip and unchecks it", () => {
    const base = selectionFromConfig([
      { id: "grok", label: "Grok", enabled: true, models: ["grok-4.6", "grok-4.5"] },
    ]);
    const removed = removeModelFromSelection(base, "grok", "grok-4.6");
    expect(removed.models.grok).not.toContain("grok-4.6");
    expect(removed.enabled.grok).toEqual(["grok-4.5"]);
  });
});

describe("modelsForCli (OCL-77)", () => {
  it("offers nothing for a CLI that is switched off", () => {
    const sel = selectionFromConfig([
      { id: "claude-code", label: "Claude Code", enabled: true, models: ["sonnet-5"] },
      { id: "codex", label: "Codex", enabled: false, models: ["gpt-5.6-sol"] },
    ]);
    expect(modelsForCli(sel, "codex")).toEqual([]);
  });

  it("still offers an enabled CLI's checked models", () => {
    const sel = selectionFromConfig([
      { id: "codex", label: "Codex", enabled: true, models: ["gpt-5.6-sol"] },
    ]);
    expect(modelsForCli(sel, "codex")).toEqual(["gpt-5.6-sol"]);
  });

  it("excludes a disabled CLI's models from the no-preference union", () => {
    const sel = selectionFromConfig([
      { id: "claude-code", label: "Claude Code", enabled: true, models: ["sonnet-5"] },
      { id: "codex", label: "Codex", enabled: false, models: ["gpt-5.6-sol"] },
    ]);
    expect(modelsForCli(sel, null)).toEqual(["sonnet-5"]);
  });

  it("keeps the custom executor's fixed model regardless of enabled state", () => {
    const sel = selectionFromConfig([]);
    expect(modelsForCli(sel, CUSTOM_EXECUTOR_ID)).toEqual(["generic-mcp"]);
  });
});

describe("learning executors from connections", () => {
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

  it("isPairInConfig matches enabled executors, alias-aware and case-insensitive", () => {
    const config = [
      { id: "claude-code", enabled: true, models: ["sonnet-5"] },
      { id: "codex", enabled: false, models: ["gpt-5.6-sol"] },
    ];
    expect(isPairInConfig(config, "claude", "sonnet-5")).toBe(true);
    expect(isPairInConfig(config, "claude-code", "Sonnet-5")).toBe(true);
    expect(isPairInConfig(config, "claude", "claude-fable-5")).toBe(false);
    expect(isPairInConfig(config, "codex", "gpt-5.6-sol")).toBe(false);
  });
});

describe("cardapioLabel", () => {
  it("labels the known types and returns the type itself when unknown", () => {
    expect(cardapioLabel("bug").label).toBe("Bug");
    expect(cardapioLabel("unknown")).toEqual({ label: "unknown", hint: "" });
  });
});

describe("applyExecutorUpdate", () => {
  const base = [
    {
      id: "claude-code",
      label: "Claude Code",
      enabled: true,
      models: ["fable-5"],
      catalog: ["fable-5", "opus-5"],
    },
    { id: "codex", label: "Codex", enabled: false, models: [], catalog: ["gpt-5.5"] },
  ];

  it("adds a model to the catalog and checks it, turning the CLI on", () => {
    const { config, targetId, removed } = applyExecutorUpdate(base, {
      cli: "codex",
      add_models: ["gpt-5.6-sol"],
    });
    const row = config.find((r) => r.id === "codex");
    expect(targetId).toBe("codex");
    expect(removed).toBe(false);
    expect(row?.catalog).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
    expect(row?.models).toEqual(["gpt-5.6-sol"]);
    expect(row?.enabled).toBe(true);
  });

  it("honours an explicit enabled:false while still adding the model", () => {
    const { config } = applyExecutorUpdate(base, {
      cli: "codex",
      add_models: ["gpt-5.6-sol"],
      enabled: false,
    });
    const row = config.find((r) => r.id === "codex");
    expect(row?.catalog).toContain("gpt-5.6-sol");
    expect(row?.enabled).toBe(false);
  });

  it("removes a model from both the catalog and the checked list", () => {
    const { config } = applyExecutorUpdate(base, {
      cli: "claude-code",
      remove_models: ["fable-5"],
    });
    const row = config.find((r) => r.id === "claude-code");
    expect(row?.catalog).toEqual(["opus-5"]);
    expect(row?.models).toEqual([]);
    expect(row?.enabled).toBe(true);
  });

  it("resolves the binary name an agent sends to the board id", () => {
    const { config, targetId } = applyExecutorUpdate(base, {
      cli: "claude",
      add_models: ["opus-5"],
    });
    expect(targetId).toBe("claude-code");
    expect(config.filter((r) => r.id === "claude-code")).toHaveLength(1);
    expect(config.find((r) => r.id === "claude-code")?.models).toEqual([
      "fable-5",
      "opus-5",
    ]);
  });

  it("creates a CLI that is not in the config yet, with the given label", () => {
    const { config, targetId } = applyExecutorUpdate(base, {
      cli: "aider",
      label: "Aider",
      add_models: ["deepseek-v4"],
    });
    expect(targetId).toBe("aider");
    expect(config.find((r) => r.id === "aider")).toEqual({
      id: "aider",
      label: "Aider",
      enabled: true,
      models: ["deepseek-v4"],
      catalog: ["deepseek-v4"],
    });
  });

  it("drops the whole CLI on remove and leaves the others alone", () => {
    const { config, removed } = applyExecutorUpdate(base, {
      cli: "codex",
      remove: true,
    });
    expect(removed).toBe(true);
    expect(config.map((r) => r.id)).toEqual(["claude-code"]);
  });

  it("does not mutate the config it was given", () => {
    const snapshot = JSON.stringify(base);
    applyExecutorUpdate(base, { cli: "claude-code", add_models: ["haiku-4-5"] });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("fills the catalog of a legacy row saved before the field existed", () => {
    const { config } = applyExecutorUpdate(
      [{ id: "claude-code", label: "Claude Code", enabled: true, models: ["fable-5"] }],
      { cli: "claude-code", add_models: ["custom-model"] },
    );
    const row = config.find((r) => r.id === "claude-code");
    // Built-in suggestions plus what was checked, then the new model.
    expect(row?.catalog).toContain("opus-5");
    expect(row?.catalog).toContain("fable-5");
    expect(row?.catalog).toContain("custom-model");
  });
});
