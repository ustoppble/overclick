/** Catalog of executor CLIs, shared between onboarding (T2) and /settings. */
export type ExecutorDef = {
  id: string;
  label: string;
  models: string[];
};

export const EXECUTOR_CATALOG: readonly ExecutorDef[] = [
  { id: "claude-code", label: "Claude Code", models: ["fable-5", "opus-5", "sonnet-5", "haiku-4-5"] },
  {
    id: "gemini-cli",
    label: "Gemini",
    models: ["3.5-flash", "3.1-pro", "3.1-flash-lite", "3-pro", "3-flash", "2.5-pro", "2.5-flash"],
  },
  {
    id: "codex",
    label: "Codex",
    models: [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ],
  },
  {
    id: "kimi",
    label: "Kimi",
    models: ["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"],
  },
  {
    id: "antigravity",
    label: "Antigravity",
    models: ["3.7-flash-high", "3.7-flash-medium", "3.7-flash-low"],
  },
  { id: "cursor", label: "Cursor", models: ["auto"] },
  { id: "github-copilot", label: "GitHub Copilot", models: ["auto"] },
  { id: "grok", label: "Grok", models: ["grok-4.6", "grok-4.5", "grok-composer-2.5-fast"] },
  {
    id: "opencode",
    label: "OpenCode",
    // OpenCode's own models. The CLI also fronts the whole Hugging Face
    // catalog, which is dozens of entries and belongs in the free-text field,
    // not in a suggestion grid.
    models: [
      "big-pickle",
      "deepseek-v4-flash-free",
      "hy3-free",
      "laguna-s-2.1-free",
      "mimo-v2.5-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
    ],
  },
  { id: "muse-code", label: "Muse Code", models: ["muse-spark-1.2"] },
];

/** Id of the custom executor ("+ Customize"), which connects via generic MCP. */
export const CUSTOM_EXECUTOR_ID = "generic-mcp";

/**
 * Names agents actually send on claim/deliver mapped to catalog ids. The MCP
 * executor field carries the binary name ("claude"), not the catalog id.
 */
const CLI_ALIASES: Record<string, string> = {
  claude: "claude-code",
  "codex cli": "codex",
  gemini: "gemini-cli",
  copilot: "github-copilot",
};

/** Resolves a connection's cli name to a catalog id, or null when unknown. */
export function resolveCatalogCli(cli: string): string | null {
  const needle = cli.trim().toLowerCase();
  if (!needle) return null;
  if (EXECUTOR_CATALOG.some((d) => d.id === needle)) return needle;
  return CLI_ALIASES[needle] ?? null;
}

/**
 * True when the cli/model pair is actively configured: an enabled executor
 * whose checked models include the model. Alias-aware on the cli.
 */
export function isPairInConfig(
  config: readonly { id: string; enabled: boolean; models: string[] }[],
  cli: string,
  model: string,
): boolean {
  const needleModel = model.trim().toLowerCase();
  const needleCli = cli.trim().toLowerCase();
  const resolved = resolveCatalogCli(needleCli);
  return config.some(
    (row) =>
      row.enabled &&
      (row.id.toLowerCase() === needleCli || row.id === resolved) &&
      row.models.some((m) => m.trim().toLowerCase() === needleModel),
  );
}

/** Selection state of the executors grid (onboarding T2 and /settings). */
export type ExecutorSelection = {
  /** enabled ids → checked models */
  enabled: Record<string, string[]>;
  /**
   * Editable model list per CLI id. Seeded from the built-in catalog, which is
   * only the initial suggestion; the user adds and removes entries as free text
   * and the list persists in the workspace config.
   */
  models: Record<string, string[]>;
  /**
   * Display labels for executors learned from real connections (ids outside
   * the built-in catalog). Catalog CLIs keep their catalog label.
   */
  labels: Record<string, string>;
  customEnabled: boolean;
  customName: string;
};

/**
 * Initial grid state from the ExecutorConfig[] persisted on the workspace.
 * Lives here, not in the component, because the server pages (/onboarding and
 * /settings) call this function, and React refuses the call from inside a
 * "use client" module.
 */
export function selectionFromConfig(
  config: readonly {
    id: string;
    label?: string;
    enabled: boolean;
    models: string[];
    catalog?: string[];
  }[],
): ExecutorSelection {
  const enabled: Record<string, string[]> = {};
  const models: Record<string, string[]> = {};
  const labels: Record<string, string> = {};
  for (const def of EXECUTOR_CATALOG) {
    models[def.id] = [...def.models];
  }
  let customEnabled = false;
  let customName = "";
  for (const row of config) {
    if (row.id === CUSTOM_EXECUTOR_ID) {
      if (row.enabled) customEnabled = true;
      continue;
    }
    // Ids outside the built-in catalog are executors learned from real
    // connections; they render in the grid with their persisted label.
    if (!EXECUTOR_CATALOG.some((d) => d.id === row.id)) {
      if (row.models.length === 0 && !row.catalog?.length) continue;
      labels[row.id] = row.label ?? row.id;
    }
    // A persisted catalog wins, even when it dropped built-in suggestions.
    // Configs saved before the field existed keep the suggestion plus any
    // checked models the user typed in elsewhere.
    models[row.id] = row.catalog
      ? [...row.catalog]
      : [...new Set([...(models[row.id] ?? []), ...row.models])];
    if (row.enabled) {
      enabled[row.id] = row.models.length
        ? [...row.models]
        : [models[row.id]?.[0] ?? "auto"];
    }
  }
  // "Outro (MCP genérico)" is the pt-BR factory label kept for workspaces
  // seeded before the English-only pass.
  const FACTORY_CUSTOM_LABELS = ["Other (generic MCP)", "Outro (MCP genérico)"];
  const custom = config.find((r) => r.id === CUSTOM_EXECUTOR_ID);
  if (custom?.label && !FACTORY_CUSTOM_LABELS.includes(custom.label)) customName = custom.label;
  return { enabled, models, labels, customEnabled, customName };
}

/** Grid defs for executors learned from real connections (non-catalog ids). */
export function learnedExecutorDefs(sel: ExecutorSelection): ExecutorDef[] {
  return Object.keys(sel.labels)
    .filter((id) => !EXECUTOR_CATALOG.some((d) => d.id === id))
    .map((id) => ({
      id,
      label: sel.labels[id] ?? id,
      models: sel.models[id] ?? [],
    }));
}

/**
 * Adds a free-text model to one CLI's editable list. Trims the input, ignores
 * empties and duplicates, and checks the model when the CLI is already on.
 */
export function addModelToSelection(
  sel: ExecutorSelection,
  execId: string,
  raw: string,
): ExecutorSelection {
  const model = raw.trim();
  if (!model) return sel;
  const list = sel.models[execId] ?? [];
  const models = list.includes(model)
    ? sel.models
    : { ...sel.models, [execId]: [...list, model] };
  const checked = sel.enabled[execId];
  const enabled =
    checked && !checked.includes(model)
      ? { ...sel.enabled, [execId]: [...checked, model] }
      : sel.enabled;
  return { ...sel, models, enabled };
}

/** Removes a model from one CLI's editable list and unchecks it. */
export function removeModelFromSelection(
  sel: ExecutorSelection,
  execId: string,
  model: string,
): ExecutorSelection {
  const list = sel.models[execId] ?? [];
  const models = { ...sel.models, [execId]: list.filter((m) => m !== model) };
  const checked = sel.enabled[execId];
  const enabled = checked
    ? { ...sel.enabled, [execId]: checked.filter((m) => m !== model) }
    : sel.enabled;
  return { ...sel, models, enabled };
}

/** One row of the persisted executor config, structurally. */
export type ExecutorConfigRow = {
  id: string;
  label: string;
  enabled: boolean;
  /** Checked models: the ones agents may actually be asked to run. */
  models: string[];
  /** Editable model list offered by the selects. */
  catalog?: string[];
};

export type ExecutorUpdate = {
  cli: string;
  label?: string;
  enabled?: boolean;
  add_models?: string[];
  remove_models?: string[];
  remove?: boolean;
};

/** Catalog of a stored row, filling the legacy shape saved before the field. */
function catalogOf(row: ExecutorConfigRow, builtIn: readonly string[]): string[] {
  return row.catalog
    ? [...row.catalog]
    : [...new Set([...builtIn, ...row.models])];
}

/**
 * Applies one add/remove operation to the executor config, in the exact shape
 * the Settings grid saves: `catalog` is what the selects offer, `models` is
 * what is checked, `enabled` is the CLI switch. Pure so both the MCP tool and
 * its tests can use it without a database.
 *
 * Adding models turns the CLI on unless the caller says otherwise: a model
 * nobody checked is invisible to the policy selects and to card harnesses,
 * which is never what "add this model" means.
 */
export function applyExecutorUpdate(
  config: readonly ExecutorConfigRow[],
  update: ExecutorUpdate,
): { config: ExecutorConfigRow[]; targetId: string; removed: boolean } {
  const cli = update.cli.trim();
  const targetId = resolveCatalogCli(cli) ?? cli.toLowerCase();
  const next: ExecutorConfigRow[] = config.map((row) => ({
    ...row,
    models: [...row.models],
    ...(row.catalog ? { catalog: [...row.catalog] } : {}),
  }));

  if (update.remove) {
    return {
      config: next.filter((row) => row.id !== targetId),
      targetId,
      removed: true,
    };
  }

  const builtIn = EXECUTOR_CATALOG.find((d) => d.id === targetId)?.models ?? [];
  let row = next.find((item) => item.id === targetId);
  if (!row) {
    row = {
      id: targetId,
      label:
        update.label?.trim() ||
        EXECUTOR_CATALOG.find((d) => d.id === targetId)?.label ||
        cli,
      enabled: false,
      models: [],
      catalog: [],
    };
    next.push(row);
  } else if (update.label?.trim()) {
    row.label = update.label.trim();
  }

  const catalog = catalogOf(row, builtIn);
  const checked = [...row.models];

  for (const raw of update.add_models ?? []) {
    const model = raw.trim();
    if (!model) continue;
    if (!catalog.includes(model)) catalog.push(model);
    if (!checked.includes(model)) checked.push(model);
  }
  for (const raw of update.remove_models ?? []) {
    const model = raw.trim();
    if (!model) continue;
    const inCatalog = catalog.indexOf(model);
    if (inCatalog >= 0) catalog.splice(inCatalog, 1);
    const inChecked = checked.indexOf(model);
    if (inChecked >= 0) checked.splice(inChecked, 1);
  }

  row.catalog = catalog;
  row.models = checked;
  if (update.enabled !== undefined) {
    row.enabled = update.enabled;
  } else if ((update.add_models ?? []).length > 0) {
    row.enabled = true;
  }

  return { config: next, targetId, removed: false };
}

/** Display labels for the cardapio activity types (real mcp-core types). */
export const CARDAPIO_LABELS: Record<string, { label: string; hint: string }> = {
  bug: { label: "Bug", hint: "localized fix, repro → patch" },
  feature: { label: "Feature / UI", hint: "new screen, component, flow" },
  rfc: { label: "RFC", hint: "decision document" },
  architecture: { label: "Architecture", hint: "design decision, written plan" },
  mechanical: { label: "Mechanical / report", hint: "rename, export, sweep logs" },
};

export function cardapioLabel(type: string): { label: string; hint: string } {
  return CARDAPIO_LABELS[type] ?? { label: type, hint: "" };
}
