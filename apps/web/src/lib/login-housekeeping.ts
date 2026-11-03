import { loginCode, loginCodeRequest, loginFailure } from "@agent-board/db";
import { isNotNull, lt, or } from "drizzle-orm";
import type { McpDatabase } from "../mcp/types";
import { CODE_USER_FAILURE_WINDOW_MS } from "./login-rate-limit";

/** The longest window any `login_code_request` bucket counts over. */
const CODE_REQUEST_ROW_TTL_MS = 60 * 60 * 1000;
/** At most one sweep a minute per database handle. */
const SWEEP_EVERY_MS = 60 * 1000;

const lastSweep = new WeakMap<object, number>();

/**
 * Deletes what the sign-in tables only keep for a window: budget rows whose
 * window is over (every bucket restarts on its own, so they count nothing
 * any more) and codes that were used or have expired. Each distinct address a
 * stranger types makes rows, and nothing else ever removes them.
 *
 * Opportunistic, with no cron: the sign-in-by-code actions call it, and it
 * runs at most once a minute per database handle so a flood of requests does
 * not turn into a flood of table scans. Never throws, since a failed sweep
 * must not fail a sign-in.
 */
export async function sweepLoginRows(
  db: McpDatabase,
  now: Date = new Date(),
): Promise<void> {
  const last = lastSweep.get(db);
  if (last !== undefined && now.getTime() - last < SWEEP_EVERY_MS) return;
  lastSweep.set(db, now.getTime());

  try {
    await db
      .delete(loginCodeRequest)
      .where(lt(loginCodeRequest.windowStartedAt, new Date(now.getTime() - CODE_REQUEST_ROW_TTL_MS)));
    await db
      .delete(loginFailure)
      .where(lt(loginFailure.windowStartedAt, new Date(now.getTime() - CODE_USER_FAILURE_WINDOW_MS)));
    await db
      .delete(loginCode)
      .where(or(isNotNull(loginCode.consumedAt), lt(loginCode.expiresAt, now)));
  } catch (err) {
    console.error(
      `[login-code] housekeeping failed (${err instanceof Error ? err.name : "unknown"})`,
    );
  }
}
