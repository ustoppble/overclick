"use server";

import { db } from "../lib/db";
import { globalBarCountsLimiter } from "../lib/board-signature-guard";
import { getSession } from "../lib/cookies";
import { loadGlobalCounts, type GlobalCounts } from "../lib/global-counts";
import { sessionPrincipal } from "../lib/web-scope";

/**
 * The global bar's two numbers, for the pages that have no board poll of
 * their own (Usage, Settings, Organizations): they ask every 60 s. Null when
 * nobody is signed in, and the bar keeps what it had.
 */
export async function globalBarCountsAction(): Promise<GlobalCounts | null> {
  const session = await getSession();
  if (!session) return null;
  // Before the scope reads, as the board's signature does: a refused poll
  // costs the session lookup and nothing else, and the bar keeps its numbers.
  const slot = globalBarCountsLimiter.acquire(session.userId);
  if (!slot.ok) return null;
  try {
    const principal = await sessionPrincipal(session);
    if (!principal) return null;
    const ws = await db().query.workspace.findFirst({ columns: { id: true } });
    if (!ws) return null;
    return await loadGlobalCounts(db(), ws.id, principal);
  } finally {
    slot.release();
  }
}
