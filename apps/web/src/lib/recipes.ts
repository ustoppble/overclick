import { eq } from "drizzle-orm";
import {
  bindRecipeSettings,
  factoryUsageRecipes,
  findUsageRecipe,
  usageRecipe,
  type Database,
  type RecipeYield,
  type UsageRecipeRow,
} from "@agent-board/db";
import { resolveCatalogCli } from "./executors";

/** Postgres or PGlite drizzle client — the query surface recipes need. */
export type RecipesDb = Pick<Database, "select">;

/**
 * The workspace recipe list: what the board ships, with any recipe the
 * workspace rewrote on top. Rows are only stored once someone edits one, so a
 * fresh instance already hands agents a working command without anyone
 * touching Settings.
 */
export async function loadUsageRecipes(
  db: RecipesDb,
  workspaceId: string,
): Promise<UsageRecipeRow[]> {
  const stored = await db
    .select()
    .from(usageRecipe)
    .where(eq(usageRecipe.workspaceId, workspaceId));

  const rows = new Map<string, UsageRecipeRow>();
  for (const row of factoryUsageRecipes()) rows.set(row.cli, row);
  for (const row of stored) {
    rows.set(row.cli, {
      cli: row.cli,
      label: row.label,
      yields: row.yields as RecipeYield,
      instructions: row.instructions,
      command: row.command,
      source: "custom",
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return [...rows.values()];
}

/**
 * The recipe for the CLI that claimed the card. Agents send the binary name
 * ("claude"); the catalog resolves it to the id the recipes are keyed by, and
 * anything unknown lands on the generic recipe rather than on nothing.
 */
export function recipeForCli(
  recipes: readonly UsageRecipeRow[],
  cli: string | null | undefined,
): UsageRecipeRow | null {
  const raw = (cli ?? "").trim();
  const resolved = raw ? (resolveCatalogCli(raw) ?? raw) : null;
  return findUsageRecipe(recipes, resolved);
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Binds a recipe to this attempt's claim window. Every transcript-reading
 * shipped recipe understands claimed_at; Codex additionally gets the exact
 * session and harness model that select and label its rollout.
 *
 * A shipped recipe takes them as `key=value` arguments, percent-encoded, which
 * survive bash, zsh and PowerShell alike: the old `VAR=value command` prefix
 * is POSIX shell syntax, and on Windows it became a stray argument that bound
 * nothing. A recipe the workspace rewrote keeps the environment prefix — it
 * was written against that form, and the board does not rewrite it.
 */
export function bindUsageRecipe(
  recipe: UsageRecipeRow | null,
  executor: {
    sessionId?: string | null;
    model?: string | null;
    claimedAt?: Date | string | null;
  },
): UsageRecipeRow | null {
  if (!recipe) return recipe;

  const claimedAt = executor.claimedAt
    ? new Date(executor.claimedAt).toISOString()
    : null;

  const isCodex = recipe.cli === "codex";
  const settings = {
    claimed_at: claimedAt,
    codex_session: isCodex ? executor.sessionId : null,
    codex_model: isCodex ? executor.model : null,
  };

  const environment = [
    claimedAt ? `OVERCLICK_CLAIMED_AT=${shellValue(claimedAt)}` : null,
    isCodex && executor.sessionId
      ? `CODEX_SESSION_ID=${shellValue(executor.sessionId)}`
      : null,
    isCodex && executor.model
      ? `CODEX_HARNESS_MODEL=${shellValue(executor.model)}`
      : null,
  ].filter((value): value is string => Boolean(value));

  const windowInstruction = claimedAt
    ? ` Count only transcript entries at or after claimed_at ${claimedAt}; ` +
      "work already present in this session belongs to no part of this card."
    : "";

  if (!recipe.command) return { ...recipe, instructions: `${recipe.instructions}${windowInstruction}` };

  return {
    ...recipe,
    instructions: `${recipe.instructions}${windowInstruction}`,
    command:
      recipe.source === "custom"
        ? environment.length
          ? `${environment.join(" ")} ${recipe.command}`
          : recipe.command
        : bindRecipeSettings(recipe.command, settings),
  };
}
