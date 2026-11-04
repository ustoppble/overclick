/**
 * The CLIs the board knows by name: their brand mark, label and suggested
 * models. Since E2 it chooses nothing; it serves the record (the CLI mark,
 * Consumo, the usage recipes) and the price suggestions.
 */
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
      "gpt-reserve",
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

/**
 * Names agents actually send on claim/deliver mapped to catalog ids. The MCP
 * executor field carries the binary name ("claude"), not the catalog id.
 */
const CLI_ALIASES: Record<string, string> = {
  claude: "claude-code",
  "codex cli": "codex",
  "codex-cli": "codex",
  gemini: "gemini-cli",
  copilot: "github-copilot",
  "grok-cli": "grok",
  "kimi-code": "kimi",
};

/** Resolves a connection's cli name to a catalog id, or null when unknown. */
export function resolveCatalogCli(cli: string): string | null {
  const needle = cli.trim().toLowerCase();
  if (!needle) return null;
  if (EXECUTOR_CATALOG.some((d) => d.id === needle)) return needle;
  return CLI_ALIASES[needle] ?? null;
}
