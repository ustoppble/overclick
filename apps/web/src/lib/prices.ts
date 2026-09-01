import { eq } from "drizzle-orm";
import {
  factoryModelPrices,
  modelPrice,
  normalizeModelKey,
  type Database,
  type ModelPriceRow,
} from "@agent-board/db";

/** Postgres or PGlite drizzle client — the query surface prices need. */
export type PricesDb = Pick<Database, "select">;

/**
 * The workspace price table: the seeded public list, with any row the
 * workspace edited on top. Rows are only stored once someone changes a price,
 * so a fresh instance already computes cost without anyone touching Settings.
 */
export async function loadModelPrices(
  db: PricesDb,
  workspaceId: string,
): Promise<ModelPriceRow[]> {
  const stored = await db
    .select()
    .from(modelPrice)
    .where(eq(modelPrice.workspaceId, workspaceId));

  const rows = new Map<string, ModelPriceRow>();
  for (const row of factoryModelPrices()) rows.set(row.model, row);
  for (const row of stored) {
    const key = normalizeModelKey(row.model);
    rows.set(key, {
      model: key,
      label: row.label,
      inputPerMtok: Number(row.inputPerMtok),
      outputPerMtok: Number(row.outputPerMtok),
      cachePerMtok: Number(row.cachePerMtok),
      cacheWritePerMtok: Number(row.cacheWritePerMtok),
      source: "custom",
      seededAt: row.seededAt,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}
