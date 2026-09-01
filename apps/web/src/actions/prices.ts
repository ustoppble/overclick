"use server";

import { and, eq, notInArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  factoryModelPrices,
  modelPrice,
  normalizeModelKey,
  workspace,
} from "@agent-board/db";
import type { ActionResult } from "../lib/action-result";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";

export type PriceInput = {
  model: string;
  label: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cachePerMtok: number;
  cacheWritePerMtok: number;
};

const SAME = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * Persists the price table. Only rows that differ from the seeded public list
 * are stored: a row back at its factory number goes away again, so "public
 * price, read on <date>" never lies about a number a human typed.
 */
export async function savePricesAction(
  rows: PriceInput[],
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  const factory = new Map(factoryModelPrices().map((row) => [row.model, row]));
  const seen = new Set<string>();
  const custom: PriceInput[] = [];

  for (const row of rows) {
    const model = normalizeModelKey(row.model);
    const label = row.label.trim() || model;
    if (!model || seen.has(model)) continue;
    seen.add(model);
    for (const value of [
      row.inputPerMtok,
      row.outputPerMtok,
      row.cachePerMtok,
      row.cacheWritePerMtok,
    ]) {
      if (!Number.isFinite(value) || value < 0) {
        return {
          ok: false,
          error: `Price for '${label}' must be a number of dollars per million tokens, zero or more.`,
        };
      }
    }
    const seed = factory.get(model);
    const isFactory =
      seed != null &&
      SAME(seed.inputPerMtok, row.inputPerMtok) &&
      SAME(seed.outputPerMtok, row.outputPerMtok) &&
      SAME(seed.cachePerMtok, row.cachePerMtok) &&
      SAME(seed.cacheWritePerMtok, row.cacheWritePerMtok);
    if (!isFactory) custom.push({ ...row, model, label });
  }

  const keep = custom.map((row) => row.model);
  await db()
    .delete(modelPrice)
    .where(
      keep.length > 0
        ? and(
            eq(modelPrice.workspaceId, ws.id),
            notInArray(modelPrice.model, keep),
          )
        : eq(modelPrice.workspaceId, ws.id),
    );

  for (const row of custom) {
    await db()
      .insert(modelPrice)
      .values({
        workspaceId: ws.id,
        model: row.model,
        label: row.label,
        inputPerMtok: String(row.inputPerMtok),
        outputPerMtok: String(row.outputPerMtok),
        cachePerMtok: String(row.cachePerMtok),
        cacheWritePerMtok: String(row.cacheWritePerMtok),
        seededAt: null,
        updatedBy: session.email,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [modelPrice.workspaceId, modelPrice.model],
        set: {
          label: row.label,
          inputPerMtok: String(row.inputPerMtok),
          outputPerMtok: String(row.outputPerMtok),
          cachePerMtok: String(row.cachePerMtok),
          cacheWritePerMtok: String(row.cacheWritePerMtok),
          seededAt: null,
          updatedBy: session.email,
          updatedAt: new Date(),
        },
      });
  }

  revalidatePath("/settings");
  revalidatePath("/insights");
  revalidatePath("/home");
  return { ok: true };
}

/**
 * Turns the money layer on or off. OFF by default: tokens and time are facts
 * on every plan, a dollar figure is not. With it off the board shows no
 * dollars anywhere and the price table sits idle; with it on, cost appears
 * next to the tokens, labeled approximate and labeled by source.
 */
export async function savePricingEnabledAction(
  enabled: boolean,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  await db()
    .update(workspace)
    .set({ pricingEnabled: enabled })
    .where(eq(workspace.id, ws.id));

  revalidatePath("/settings");
  revalidatePath("/insights");
  revalidatePath("/home");
  return { ok: true };
}
