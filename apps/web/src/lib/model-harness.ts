import { normalizeModelKey } from "@agent-board/db";
import { decodeExecutor } from "../mcp/map";
import { resolveCatalogCli } from "./executors";

/**
 * The CLI and the effort each model ran with, read from the executor every
 * attempt recorded at claim (E5). Nothing is stored for this: the effort lives
 * only inside that JSON. A model keyed the way Consumo keys it, so the table
 * row and this answer are about the same model. "Not declared" is an empty
 * list, shown as a dash, never a guess.
 */
export type ModelHarness = { clis: string[]; efforts: string[] };

export function modelHarness(
  rows: ReadonlyArray<{ model: string | null; executor: string | null }>,
): Map<string, ModelHarness> {
  const byModel = new Map<string, ModelHarness>();
  for (const row of rows) {
    if (!row.model) continue;
    const key = normalizeModelKey(row.model);
    const entry = byModel.get(key) ?? { clis: [], efforts: [] };
    byModel.set(key, entry);
    if (!row.executor) continue;
    const executor = decodeExecutor(row.executor, row.model);
    const name = executor.cli ?? executor.agent;
    const cli = name ? (resolveCatalogCli(name) ?? name) : null;
    if (cli && !entry.clis.includes(cli)) entry.clis.push(cli);
    if (executor.effort && !entry.efforts.includes(executor.effort)) {
      entry.efforts.push(executor.effort);
    }
  }
  return byModel;
}
