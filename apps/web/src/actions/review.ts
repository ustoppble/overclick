"use server";

import {
  canTransition,
  task,
  taskComment,
  type ValidationTick,
} from "@agent-board/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { parseComoConfirmo } from "../mcp/map";
import type { ActionResult } from "../lib/action-result";

/**
 * Ticks or unticks one How-to-confirm step of a done card, recording who and
 * when. The Validate button only enables when every step is ticked.
 */
export async function tickValidationStepAction(
  taskId: string,
  stepIndex: number,
  checked: boolean,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const row = await db().query.task.findFirst({ where: eq(task.id, taskId) });
  if (!row) return { ok: false, error: "Card not found." };
  if (row.status !== "feito") {
    return { ok: false, error: "You can only check steps on a card in done." };
  }

  const steps = parseComoConfirmo(row.comoConfirmo);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) {
    return { ok: false, error: "This step does not exist on the card." };
  }

  const ticks = row.validationTicks.filter((t) => t.index !== stepIndex);
  if (checked) {
    const tick: ValidationTick = {
      index: stepIndex,
      byUserId: session.userId,
      byEmail: session.email,
      at: new Date().toISOString(),
    };
    ticks.push(tick);
  }

  await db().update(task).set({ validationTicks: ticks }).where(eq(task.id, taskId));
  revalidatePath("/home");
  return { ok: true };
}

/**
 * feito → validado (signed-in human only). Requires every How-to-confirm step
 * ticked unless the reviewer explicitly overrides ("validate anyway").
 */
export async function validateTaskAction(
  taskId: string,
  options: { override?: boolean } = {},
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const row = await db().query.task.findFirst({ where: eq(task.id, taskId) });
  if (!row) return { ok: false, error: "Card not found." };
  if (!canTransition(row.status, "validado", "human")) {
    return { ok: false, error: "You can only validate a card that is in done." };
  }

  if (!options.override) {
    const steps = parseComoConfirmo(row.comoConfirmo);
    const ticked = new Set(row.validationTicks.map((t) => t.index));
    const missing = steps.filter((_, index) => !ticked.has(index));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Check all ${steps.length} steps first, or validate anyway.`,
      };
    }
  }

  await db()
    .update(task)
    .set({ status: "validado", revisado: true })
    .where(eq(task.id, taskId));
  revalidatePath("/home");
  return { ok: true };
}

/**
 * validado → feito (signed-in human only, never exposed via MCP). Leaves an
 * auditable trail — who desvalidated and when — instead of moving the card
 * back in silence.
 */
export async function unvalidateTaskAction(taskId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const row = await db().query.task.findFirst({ where: eq(task.id, taskId) });
  if (!row) return { ok: false, error: "Card not found." };
  if (!canTransition(row.status, "feito", "human")) {
    return { ok: false, error: "You can only desvalidate a card that is validated." };
  }

  await db().insert(taskComment).values({
    taskId,
    authorUserId: session.userId,
    kind: "desvalidar",
    body: `Desvalidado por ${session.email} em ${new Date().toISOString()}.`,
  });
  await db()
    .update(task)
    .set({ status: "feito" })
    .where(eq(task.id, taskId));
  revalidatePath("/home");
  return { ok: true };
}

/**
 * Adds a prose comment to an open card without moving it — the only path in
 * the product for a human to answer an `aberto` card. Every other write path
 * (tick, validate, reopen) requires the card to already be `feito`; a request
 * for a decision (`tipo: "rfc"`) is asked before any work starts, so it never
 * reaches that state on its own. Scoped to `rfc` on purpose: `feature`/`bug`
 * cards keep the existing claim → deliver → validate flow untouched.
 */
export async function answerOpenTaskAction(
  taskId: string,
  comment: string,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const body = comment.trim();
  if (!body) {
    return { ok: false, error: "Write an answer before sending." };
  }

  const row = await db().query.task.findFirst({ where: eq(task.id, taskId) });
  if (!row) return { ok: false, error: "Card not found." };
  if (row.status !== "aberto") {
    return { ok: false, error: "You can only answer a card that is open." };
  }
  if (row.tipo !== "rfc") {
    return { ok: false, error: "Only a decision card (rfc) takes a free-form answer." };
  }

  await db().insert(taskComment).values({
    taskId,
    authorUserId: session.userId,
    body,
  });
  revalidatePath("/home");
  return { ok: true };
}

/** feito → aberto, recording the comment the agent reads on its next claim. */
export async function reopenTaskAction(
  taskId: string,
  comment: string,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const body = comment.trim();
  if (!body) {
    return { ok: false, error: "Describe what's missing. The agent reads it on its next claim." };
  }

  const row = await db().query.task.findFirst({ where: eq(task.id, taskId) });
  if (!row) return { ok: false, error: "Card not found." };
  if (!canTransition(row.status, "aberto", "human", { hasComment: true })) {
    return { ok: false, error: "You can only reopen a card that is in done." };
  }

  await db().insert(taskComment).values({
    taskId,
    authorUserId: session.userId,
    body,
  });
  await db()
    .update(task)
    .set({ status: "aberto", validationTicks: [] })
    .where(eq(task.id, taskId));
  revalidatePath("/home");
  return { ok: true };
}
