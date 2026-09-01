"use server";

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspace, type UpdateMode } from "@agent-board/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "../lib/action-result";
import { toRecord } from "../lib/auto-update";
import { getSession } from "../lib/cookies";
import { db } from "../lib/db";
import { detectRuntime } from "../lib/runtime";
import type { SourceUpdateReport } from "../lib/source-update";
import {
  recordUpdate,
  runHostSourceUpdate,
  scheduleExit,
} from "../lib/source-update-host";
import {
  readUpdaterState,
  STATUS_FILE,
  TRIGGER_FILE,
  updateHelperDir,
  type UpdaterState,
} from "../lib/updates";

const MODES: readonly UpdateMode[] = ["off", "check", "auto"];

/**
 * Persists what this instance may do about new releases. `off` is the default
 * and the only mode that makes no outbound request at all.
 */
export async function saveUpdateModeAction(
  mode: UpdateMode,
): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (!MODES.includes(mode)) return { ok: false, error: "Unknown update mode." };

  const ws = await db().query.workspace.findFirst();
  if (!ws) return { ok: false, error: "Workspace not found." };

  await db()
    .update(workspace)
    .set({ updateMode: mode })
    .where(eq(workspace.id, ws.id));
  revalidatePath("/home");
  revalidatePath("/settings");
  return { ok: true };
}

export type TriggerUpdateResult =
  | { ok: true; triggered: boolean }
  | { ok: false; error: string };

/**
 * Asks the optional compose updater profile to pull the new image and
 * recreate the app. Reports triggered: false when no sidecar is running, so
 * the UI shows the command that enables it instead of pretending to work.
 */
export async function triggerUpdateAction(): Promise<TriggerUpdateResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const dir = updateHelperDir();
  if (!dir) return { ok: true, triggered: false };
  const state = await readUpdaterState();
  if (!state.running) return { ok: true, triggered: false };
  try {
    // The stale status of the previous run goes first: the UI polls this file
    // and must not read the last update's "done" as this one's result.
    await rm(join(dir, STATUS_FILE), { force: true });
    await writeFile(join(dir, TRIGGER_FILE), new Date().toISOString());
    return { ok: true, triggered: true };
  } catch {
    return { ok: false, error: "Could not write the update trigger." };
  }
}

export type UpdaterStateResult =
  | { ok: true; state: UpdaterState }
  | { ok: false; error: string };

/**
 * What the sidecar is doing right now. The Settings panel polls this while an
 * update runs: the app itself is recreated halfway through, so the progress
 * lives in the shared volume and survives its own restart.
 */
export async function readUpdaterStateAction(): Promise<UpdaterStateResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  return { ok: true, state: await readUpdaterState() };
}

export type SourceUpdateResult =
  | { ok: true; report: SourceUpdateReport }
  | { ok: false; error: string };

/**
 * The Update button on a source install. It runs the update here, in this
 * process's own checkout, and returns the whole step log at once: no socket to
 * hand out, no sidecar to trust, and nothing to poll, because unlike a
 * container being recreated this server survives its own update.
 *
 * Signed-in owners only, and only where the instance really runs from source:
 * a container has an image to pull and its own path for that.
 */
export async function runSourceUpdateAction(
  options: { force?: boolean } = {},
): Promise<SourceUpdateResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  if (detectRuntime() !== "source") {
    return {
      ok: false,
      error: "This instance runs in a container: update it the container way.",
    };
  }

  const ws = await db().query.workspace.findFirst();
  const report = await runHostSourceUpdate(options.force === true);

  // Every run leaves the same record, whoever started it: the panel says what
  // this instance last did about an update, not just what it did unattended.
  if (ws) {
    await recordUpdate(ws.id, toRecord(report, null, new Date().toISOString()));
  }
  if (report.outcome === "updated") revalidatePath("/settings");

  // Only after the report is on its way out: the panel has to be able to show
  // what ran before the process that ran it goes away.
  if (report.restart === "exit") scheduleExit();

  return { ok: true, report };
}
